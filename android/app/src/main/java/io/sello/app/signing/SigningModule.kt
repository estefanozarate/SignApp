package io.sello.app.signing

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.UserNotAuthenticatedException
import android.util.Base64
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.*
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.SecureRandom
import java.security.Signature
import java.security.interfaces.RSAPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.MGF1ParameterSpec
import java.security.spec.X509EncodedKeySpec
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

/**
 * Identidad criptográfica del dispositivo.
 *
 * Son TRES claves, y la separación no es capricho:
 *
 *   - EC P-256 (PURPOSE_SIGN) para firmar: identidad, prueba de posesión y
 *     aprobaciones. Autenticación por operación (CryptoObject).
 *   - RSA-2048 (PURPOSE_DECRYPT, OAEP-SHA256) para recibir secretos cifrados
 *     por el dominio. SIN autenticación, y SIEMPRE en TEE, nunca StrongBox —
 *     ver generarCifrado() y §10.1 de diseno_app.md para el porqué de cada
 *     una de las dos cosas.
 *   - AES-256-GCM (`sello.boveda.v1`) para la bóveda local. Autenticación
 *     por ventana de validez de diez segundos — ver generarBoveda().
 *
 * Se descartó ECDH con una sola clave porque PURPOSE_AGREE_KEY exige API 31 y,
 * sobre todo, porque BiometricPrompt.CryptoObject no admite KeyAgreement: la
 * clave de acuerdo solo puede protegerse con una VENTANA DE TIEMPO, no por
 * operación. RSA usa Cipher, que sí entra en CryptoObject — pero en este
 * keymaster concreto (Samsung SM-T545) el descifrado RSA-OAEP falla tanto con
 * clave ligada a autenticación (§10.1) como, según se comprobó después, con
 * clave en StrongBox — con o sin autenticación de por medio. Por eso la clave
 * RSA ya no pide autenticación y además fuerza TEE: dos ajustes distintos,
 * cada uno resuelto por su propia evidencia de diagnóstico.
 *
 * Ninguna privada cruza el puente a JavaScript: por aquí salen firmas, claves
 * públicas y texto en claro ya descifrado.
 */
class SigningModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "SelloSigning"

    private companion object {
        const val ALIAS = "sello.identidad.v1"
        const val ALIAS_CIFRADO = "sello.cifrado.v1"
        const val ALIAS_BOVEDA = "sello.boveda.v1"
        const val ALIAS_DIAG = "sello.diagnostico.v1"
        const val ALIAS_DIAG_BOVEDA = "sello.diagnostico.boveda.v1"
        const val PREFS = "sello.identidad"
        const val PREF_KEY_ID = "key_id"
        const val PREF_CREADA = "creada_en"
        const val PREF_STRONGBOX = "strongbox"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        // Biometría fuerte (Class 3) o la credencial del dispositivo (PIN/patrón).
        // El rostro Class 2 queda fuera a propósito: Android prohíbe usarlo con
        // CryptoObject, porque una biometría débil no puede custodiar una clave.
        val AUTENTICADORES = BiometricManager.Authenticators.BIOMETRIC_STRONG or
            BiometricManager.Authenticators.DEVICE_CREDENTIAL

        /**
         * Segundos de validez de la clave de la bóveda (§10.1).
         *
         * Empezó siendo 1, por no debilitar la garantía más de lo justo, y no
         * funcionaba para la clave de cifrado RSA original: entre que el
         * usuario teclea el PIN y llega el doFinal pasan cerca de dos
         * segundos, así que la ventana expiraba antes de la operación. Diez
         * da unas cinco veces ese margen sin dejar la clave utilizable
         * durante un rato largo, y es de sobra para que autenticar() → leer
         * la bóveda → firmar() ocurran uno detrás de otro sin que el usuario
         * note más que un gesto.
         */
        const val VENTANA_BOVEDA_S = 10
    }

    private val prefs by lazy { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    private fun keystore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    // ── consulta ──────────────────────────────────────────

    @ReactMethod
    fun tieneIdentidad(promesa: Promise) {
        try {
            promesa.resolve(keystore().containsAlias(ALIAS) && prefs.contains(PREF_KEY_ID))
        } catch (e: Exception) {
            promesa.reject("E_KEYSTORE", e.message, e)
        }
    }

    @ReactMethod
    fun identidad(promesa: Promise) {
        try {
            val ks = keystore()
            if (!ks.containsAlias(ALIAS)) {
                promesa.reject("E_SIN_IDENTIDAD", "Este dispositivo no tiene identidad de firma.")
                return
            }
            promesa.resolve(describir(ks))
        } catch (e: Exception) {
            promesa.reject("E_KEYSTORE", e.message, e)
        }
    }

    // ── creación ─────────────────────────────────────────

    /**
     * EC P-256, PURPOSE_SIGN, no exportable. Se intenta primero en StrongBox
     * (elemento seguro dedicado); si el equipo no lo tiene, cae al TEE.
     */
    @ReactMethod
    fun crearIdentidad(promesa: Promise) {
        try {
            val disponible = BiometricManager.from(ctx).canAuthenticate(AUTENTICADORES)
            if (disponible != BiometricManager.BIOMETRIC_SUCCESS) {
                promesa.reject("E_SIN_BLOQUEO", motivoSinBloqueo(disponible))
                return
            }

            val ks = keystore()
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
            if (ks.containsAlias(ALIAS_CIFRADO)) ks.deleteEntry(ALIAS_CIFRADO)
            if (ks.containsAlias(ALIAS_BOVEDA)) ks.deleteEntry(ALIAS_BOVEDA)

            val keyId = UUID.randomUUID().toString()
            // StrongBox primero; si el equipo no lo tiene, TEE. Si ambos fallan se
            // propaga la causa real en vez de reportar un genérico.
            val conStrongBox = try {
                generar(keyId, strongBox = true); true
            } catch (e: Exception) {
                generar(keyId, strongBox = false); false
            }

            // La de cifrado va SIEMPRE en TEE, nunca StrongBox — ver el doc de
            // generarCifrado(). Con clave en TEE la generación no lanza y el
            // problema solo se vería al descifrar más tarde, así que probar
            // "generar en StrongBox y caer al TEE si falla" no habría servido
            // aquí: la generación en StrongBox tampoco falla en este chip, es
            // el descifrado el que rompe. Se evita StrongBox directamente.
            generarCifrado()

            try {
                generarBoveda(strongBox = true)
            } catch (e: Exception) {
                generarBoveda(strongBox = false)
            }

            prefs.edit()
                .putString(PREF_KEY_ID, keyId)
                .putLong(PREF_CREADA, System.currentTimeMillis())
                .putBoolean(PREF_STRONGBOX, conStrongBox)
                .apply()

            promesa.resolve(describir(keystore()))
        } catch (e: Exception) {
            promesa.reject("E_KEYGEN", e.message, e)
        }
    }

    private fun generar(keyId: String, strongBox: Boolean) {
        if (strongBox && Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            throw UnsupportedOperationException("StrongBox exige API 28+")
        }

        // La invalidación por nueva biometría solo se pide si hay biometría
        // fuerte matriculada: en un equipo que solo tiene PIN, exigirla hace
        // fallar la generación de la clave.
        val hayBiometriaFuerte = BiometricManager.from(ctx)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256)
            .setUserAuthenticationRequired(true)
            // La attestation queda disponible para que un verificador externo
            // compruebe que la clave nació en hardware. Sin backend nadie la
            // valida todavía, pero se genera igual.
            .setAttestationChallenge(keyId.toByteArray())
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && hayBiometriaFuerte) {
                    // Una huella nueva invalida la clave. Cambiar el PIN no:
                    // el sistema no lo trata como cambio de biometría.
                    setInvalidatedByBiometricEnrollment(true)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    // 0 segundos = autenticación por operación, no por ventana de tiempo.
                    setUserAuthenticationParameters(
                        0,
                        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                    )
                } else {
                    @Suppress("DEPRECATION")
                    setUserAuthenticationValidityDurationSeconds(-1)
                }
                if (strongBox) setIsStrongBoxBacked(true)
            }
            .build()

        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, ANDROID_KEYSTORE)
            .apply { initialize(spec) }
            .generateKeyPair()
    }

    /**
     * RSA-2048 para recibir secretos. 2048 y no 3072 porque solo envuelve una
     * clave AES y en el TEE la generación de 3072 tarda varios segundos.
     *
     * §10.1 — SIN setUserAuthenticationRequired. diseno_app.md §10 nunca
     * exigió autenticación en este paso concreto, solo que la privada no
     * salga del dispositivo. En la SM-T545 el keymaster no descifra RSA con
     * una clave ligada a autenticación: diagnosticarOaep() demuestra que la
     * misma combinación OAEP-SHA256/MGF1-SHA1 funciona sobre una clave
     * temporal sin autenticación y falla sobre una clave real con ella,
     * tanto por operación como con ventana de validez — es un
     * IllegalBlockSizeException que envuelve un KeyStoreException "Unknown
     * error", sin más detalle.
     *
     * SEGUNDO HALLAZGO, posterior al de la autenticación: quitar la
     * autenticación no bastó. La clave real, ya SIN autenticación, seguía
     * fallando con el mismo error — mientras que la clave temporal de
     * diagnosticarOaep(), también sin autenticación, funcionaba. La
     * diferencia entre las dos: esta función intentaba StrongBox primero, y
     * como la generación en StrongBox no lanza excepción en este chip (el
     * fallo solo aparece al descifrar, no al generar), la clave real
     * terminaba en StrongBox sin que el try/catch lo detectara. La prueba
     * añadida a diagnosticarOaep() con una clave temporal EN StrongBox lo
     * confirmó: incluso sin autenticación, el descifrado RSA-OAEP con clave
     * en StrongBox falla en este keymaster. Por eso esta función ya no
     * intenta StrongBox en absoluto: siempre TEE.
     *
     * La autenticación real de este flujo no desaparece: se mueve a la
     * bóveda (generarBoveda()). Lo que gana quien fuerce abrirSobre() con el
     * teléfono desbloqueado es el secreto de un sitio nuevo que la propia
     * app todavía no guardó — no el contenido de la bóveda, que sigue detrás
     * de autenticar(). Ver §10.1 de diseno_app.md.
     *
     * Ojo con OAEP: el AndroidKeyStore solo admite MGF1 con SHA-1, aunque el
     * hash de OAEP sea SHA-256. Lo comprobamos en hardware: con MGF1-SHA256
     * lanza "Unsupported MGF1 digest". El emisor tiene que cifrar con esa
     * misma combinación. Ver abrirSobre().
     */
    private fun generarCifrado() {
        val spec = KeyGenParameterSpec.Builder(ALIAS_CIFRADO, KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(2048)
            // Los DOS digests. El de OAEP es SHA-256, pero MGF1 usa SHA-1 y el
            // Keystore comprueba que la clave autorice ambos: declarando solo
            // SHA-256, el descifrado falla con IllegalBlockSizeException, que
            // no dice nada de la causa real.
            .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
            // Deliberadamente SIN setIsStrongBoxBacked: ver el doc de arriba.
            .build()

        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEYSTORE)
            .apply { initialize(spec) }
            .generateKeyPair()
    }

    /**
     * AES-256-GCM para la bóveda local (§10.1, §11). A diferencia de la
     * clave de cifrado RSA, esta SÍ exige autenticación — es lo que hace que
     * "revelar un secreto" (Boveda.tsx) y devolverlo (§14) sigan pidiendo
     * algo real al usuario, ahora que abrirSobre() ya no lo hace.
     *
     * Usa ventana de validez fija de VENTANA_BOVEDA_S segundos, no
     * autenticación por operación: autenticar() se llama una vez y, dentro
     * de esa ventana, tanto cifrarEnBoveda() como descifrarDeBoveda()
     * proceden sin pedir nada más. En un equipo solo-PIN como la SM-T545
     * (DEVICE_CREDENTIAL es el único autenticador disponible: el rostro
     * Class 2 no entra en CryptoObject ni en este esquema), una
     * reconfirmación de PIN a los pocos segundos de la anterior la trata el
     * propio sistema como ya satisfecha. Por eso entregarSecreto() puede
     * encadenar autenticar() → leer la bóveda → firmar() y, en la práctica,
     * el usuario nota un solo gesto — aunque firmar() siga pidiendo su
     * propia autenticación por operación para la clave EC, que es un
     * mecanismo distinto y no se ha tocado.
     *
     * A diferencia de la clave RSA, esta SÍ intenta StrongBox primero: el
     * hallazgo de generarCifrado() fue específico de RSA-OAEP en este chip,
     * no una prohibición general de StrongBox. probarBoveda() mide esto en
     * vivo para AES-GCM con autenticación antes de confiar en el supuesto.
     */
    private fun generarBoveda(strongBox: Boolean) {
        if (strongBox && Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            throw UnsupportedOperationException("StrongBox exige API 28+")
        }

        val spec = KeyGenParameterSpec.Builder(
            ALIAS_BOVEDA, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    setUserAuthenticationParameters(
                        VENTANA_BOVEDA_S,
                        KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                    )
                } else {
                    @Suppress("DEPRECATION")
                    setUserAuthenticationValidityDurationSeconds(VENTANA_BOVEDA_S)
                }
                if (strongBox) setIsStrongBoxBacked(true)
            }
            .build()

        KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            .apply { init(spec) }
            .generateKey()
    }

    /** Traduce el código de canAuthenticate a algo que el usuario pueda accionar. */
    private fun motivoSinBloqueo(codigo: Int): String = when (codigo) {
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ->
            "Este dispositivo no tiene bloqueo de pantalla configurado. Añade un PIN, un patrón o una huella en Ajustes para poder firmar."
        BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE ->
            "Este dispositivo no puede proteger la clave: no tiene bloqueo de pantalla ni sensor biométrico."
        BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE ->
            "El sensor no está disponible ahora mismo. Inténtalo de nuevo en un momento."
        else ->
            "No se pudo comprobar el bloqueo del dispositivo (código $codigo). Revisa el PIN o la huella en Ajustes."
    }

    private fun describir(ks: KeyStore): WritableMap {
        val cadena = ks.getCertificateChain(ALIAS) ?: emptyArray()
        val publica = ks.getCertificate(ALIAS).publicKey

        val attestation = Arguments.createArray()
        cadena.forEach { attestation.pushString(b64(it.encoded)) }

        return Arguments.createMap().apply {
            putString("keyId", prefs.getString(PREF_KEY_ID, "") ?: "")
            putString("clavePublicaSpkiB64", b64(publica.encoded))
            putString("algoritmo", "ES256")
            ks.getCertificate(ALIAS_CIFRADO)?.publicKey?.let {
                putString("clavePublicaCifradoSpkiB64", b64(it.encoded))
                putString("algoritmoCifrado", "RSA-OAEP-256-MGF1SHA1")
            }
            putBoolean("strongBox", prefs.getBoolean(PREF_STRONGBOX, false))
            putDouble("creadaEn", prefs.getLong(PREF_CREADA, 0L).toDouble())
            putArray("attestationB64", attestation)
        }
    }

    // ── diagnóstico ──────────────────────────────────────

    /**
     * El AndroidKeyStore envuelve casi todos sus fallos en excepciones
     * genéricas de JCE: IllegalBlockSizeException, InvalidKeyException. El
     * motivo real ("Incompatible digest", "Key user not authenticated"…) está
     * en la causa encadenada. Sin recorrerla, lo que llega a la interfaz es el
     * nombre de la clase y nada más, que es como estar a ciegas — nos costó
     * un ciclo entero de compilar e instalar para averiguarlo.
     */
    private fun causaDe(e: Throwable): String {
        val partes = mutableListOf<String>()
        var actual: Throwable? = e
        var vueltas = 0
        while (actual != null && vueltas < 6) {
            val m = actual.message
            partes.add(if (m.isNullOrBlank()) actual.javaClass.simpleName else "${actual.javaClass.simpleName}: $m")
            actual = actual.cause
            vueltas++
        }
        return partes.joinToString(" ← ")
    }

    /** Mensaje legible para la interfaz, y la traza completa al logcat. */
    private fun fallo(etiqueta: String, e: Throwable): String {
        Log.e("SelloSigning", etiqueta, e)
        return causaDe(e)
    }

    /**
     * Qué autoriza realmente la clave, según el chip. Es la comprobación
     * directa de la sospecha de siempre: que el digest o el padding que pide
     * la operación no estén entre los que se declararon al generarla.
     */
    private fun describirClave(alias: String, clave: java.security.PrivateKey) {
        try {
            val info = KeyFactory.getInstance(clave.algorithm, ANDROID_KEYSTORE)
                .getKeySpec(clave, KeyInfo::class.java)
            Log.i(
                "SelloSigning",
                "$alias: ${info.keySize} bits, digests=${info.digests.joinToString()}, " +
                    "paddings=${info.encryptionPaddings.joinToString()}, " +
                    "enHardware=${info.isInsideSecureHardware}, " +
                    "autenticacion=${info.isUserAuthenticationRequired}",
            )
        } catch (e: Exception) {
            Log.w("SelloSigning", "no se pudo leer KeyInfo de $alias: ${e.message}")
        }
    }

    /**
     * Prueba, contra este mismo chip, qué combinaciones de OAEP funcionan de
     * verdad — y, desde el segundo hallazgo de generarCifrado(), si StrongBox
     * es también parte del problema.
     *
     * El keymaster devuelve KM_ERROR_UNKNOWN_ERROR para cualquier fallo
     * interno, así que desde fuera no hay forma de distinguir "este digest no
     * me lo soporta el TEE" de "la autenticación no se aplicó bien" de "es
     * StrongBox el que falla". Esto los separa uno por uno: genera claves
     * temporales variando un solo parámetro cada vez — sin autenticación en
     * el TEE primero, y sin autenticación en StrongBox después — y cifra y
     * descifra contra cada una.
     *
     * En la SM-T545 el resultado fue: OAEP-SHA256/MGF1-SHA1 en el TEE, sin
     * autenticación, FUNCIONA — de ahí que generarCifrado() la dejara de
     * pedir (§10.1). La misma combinación EN STRONGBOX, también sin
     * autenticación, FALLA con el mismo error genérico — de ahí que
     * generarCifrado() además dejara de usar StrongBox. Dos hallazgos
     * distintos, cada uno con su propia clave temporal de control.
     *
     * Las claves temporales se borran al terminar. Es diagnóstico, no camino
     * de producción: no cifra nada real ni toca las claves de la identidad.
     */
    private fun diagnosticarOaep() {
        try {
            val ks = keystore()
            if (ks.containsAlias(ALIAS_DIAG)) ks.deleteEntry(ALIAS_DIAG)

            KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEYSTORE)
                .apply {
                    initialize(
                        KeyGenParameterSpec.Builder(ALIAS_DIAG, KeyProperties.PURPOSE_DECRYPT)
                            .setKeySize(2048)
                            .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1)
                            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
                            .build(),
                    )
                }
                .generateKeyPair()

            val ks2 = keystore()
            val privada = (ks2.getEntry(ALIAS_DIAG, null) as KeyStore.PrivateKeyEntry).privateKey
            // La pública se reconstruye por KeyFactory para que el cifrado lo
            // haga el proveedor de software y no el Keystore: así lo único que
            // se está midiendo es el descifrado dentro del chip.
            val publica = KeyFactory.getInstance("RSA").generatePublic(
                X509EncodedKeySpec(ks2.getCertificate(ALIAS_DIAG).publicKey.encoded),
            )
            val dato = ByteArray(32).also { SecureRandom().nextBytes(it) }

            fun probar(nombre: String, transformacion: String, spec: OAEPParameterSpec?, publicaProbar: java.security.PublicKey = publica) {
                try {
                    val cifrador = Cipher.getInstance(transformacion).apply {
                        if (spec != null) init(Cipher.ENCRYPT_MODE, publicaProbar, spec)
                        else init(Cipher.ENCRYPT_MODE, publicaProbar)
                    }
                    val ct = cifrador.doFinal(dato)
                    val descifrador = Cipher.getInstance(transformacion).apply {
                        if (spec != null) init(Cipher.DECRYPT_MODE, privada, spec)
                        else init(Cipher.DECRYPT_MODE, privada)
                    }
                    val claro = descifrador.doFinal(ct)
                    Log.i(
                        "SelloSigning",
                        "diag $nombre: ${if (claro.contentEquals(dato)) "FUNCIONA" else "descifra pero no coincide"}",
                    )
                } catch (e: Exception) {
                    Log.w("SelloSigning", "diag $nombre: ${causaDe(e)}")
                }
            }

            val d = PSource.PSpecified.DEFAULT
            Log.i("SelloSigning", "diag ── clave temporal SIN autenticación, TEE ──")
            probar("OAEP-SHA256 / MGF1-SHA1 (spec)", "RSA/ECB/OAEPPadding",
                OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, d))
            probar("OAEP-SHA256 / MGF1-SHA256 (spec)", "RSA/ECB/OAEPPadding",
                OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA256, d))
            probar("OAEP-SHA1 / MGF1-SHA1 (spec)", "RSA/ECB/OAEPPadding",
                OAEPParameterSpec("SHA-1", "MGF1", MGF1ParameterSpec.SHA1, d))
            probar("OAEPWithSHA-256AndMGF1Padding (sin spec)",
                "RSA/ECB/OAEPWithSHA-256AndMGF1Padding", null)
            probar("OAEPWithSHA-1AndMGF1Padding (sin spec)",
                "RSA/ECB/OAEPWithSHA-1AndMGF1Padding", null)

            ks2.deleteEntry(ALIAS_DIAG)

            // Segunda ronda: misma combinación ganadora (OAEP-SHA256/MGF1-SHA1,
            // sin autenticación), pero con la clave en StrongBox. Si el equipo
            // no tiene StrongBox, se salta sin más.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                try {
                    if (ks2.containsAlias(ALIAS_DIAG)) ks2.deleteEntry(ALIAS_DIAG)
                    KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEYSTORE)
                        .apply {
                            initialize(
                                KeyGenParameterSpec.Builder(ALIAS_DIAG, KeyProperties.PURPOSE_DECRYPT)
                                    .setKeySize(2048)
                                    .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1)
                                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
                                    .setIsStrongBoxBacked(true)
                                    .build(),
                            )
                        }
                        .generateKeyPair()

                    val ks3 = keystore()
                    val privadaSb = (ks3.getEntry(ALIAS_DIAG, null) as KeyStore.PrivateKeyEntry).privateKey
                    val publicaSb = KeyFactory.getInstance("RSA").generatePublic(
                        X509EncodedKeySpec(ks3.getCertificate(ALIAS_DIAG).publicKey.encoded),
                    )

                    Log.i("SelloSigning", "diag ── clave temporal SIN autenticación, StrongBox ──")
                    try {
                        val cifrador = Cipher.getInstance("RSA/ECB/OAEPPadding").apply {
                            init(
                                Cipher.ENCRYPT_MODE, publicaSb,
                                OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, d),
                            )
                        }
                        val ct = cifrador.doFinal(dato)
                        val descifrador = Cipher.getInstance("RSA/ECB/OAEPPadding").apply {
                            init(
                                Cipher.DECRYPT_MODE, privadaSb,
                                OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, d),
                            )
                        }
                        val claro = descifrador.doFinal(ct)
                        Log.i(
                            "SelloSigning",
                            "diag OAEP-SHA256 / MGF1-SHA1, StrongBox: ${if (claro.contentEquals(dato)) "FUNCIONA" else "descifra pero no coincide"}",
                        )
                    } catch (e: Exception) {
                        Log.w("SelloSigning", "diag OAEP-SHA256 / MGF1-SHA1, StrongBox: ${causaDe(e)}")
                    }

                    ks3.deleteEntry(ALIAS_DIAG)
                } catch (e: Exception) {
                    // Si el equipo dice tener StrongBox pero la generación en sí
                    // falla, es un dato distinto y también vale la pena verlo.
                    Log.w("SelloSigning", "diag StrongBox: no se pudo generar la clave temporal: ${causaDe(e)}")
                }
            }
        } catch (e: Exception) {
            Log.w("SelloSigning", "no se pudo diagnosticar: ${causaDe(e)}")
        }
    }

    /**
     * §10.1, punto 7 — mide, en vez de dar por bueno, que AES-GCM con clave
     * autenticada funciona en este keymaster. Es la misma pregunta que
     * diagnosticarOaep() responde para RSA, pero esa función usa una clave
     * SIN autenticación porque corre en un hilo de fondo sin prompt; aquí no
     * hay atajo: lo que hace falta comprobar es justo la ruta CON
     * autenticación — la misma que generarBoveda() va a usar en producción
     * — y eso exige un BiometricPrompt real.
     *
     * Genera una clave AES temporal con los MISMOS parámetros que
     * generarBoveda(), pide autenticación una vez y cifra/descifra contra
     * ella. La clave temporal se borra al terminar; no toca la bóveda real.
     *
     * Expuesto como método nativo para poder invocarse desde una pantalla de
     * diagnóstico (ver "Comprobar la bóveda" en Dispositivo.tsx) en vez de
     * darse por sentado.
     */
    @ReactMethod
    fun probarBoveda(titulo: String, subtitulo: String, promesa: Promise) {
        val actividad = reactApplicationContext.currentActivity as? FragmentActivity
        if (actividad == null) {
            promesa.reject("E_SIN_ACTIVIDAD", "La app no está en primer plano.")
            return
        }

        try {
            val ks = keystore()
            if (ks.containsAlias(ALIAS_DIAG_BOVEDA)) ks.deleteEntry(ALIAS_DIAG_BOVEDA)

            val spec = KeyGenParameterSpec.Builder(
                ALIAS_DIAG_BOVEDA, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .apply {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        setUserAuthenticationParameters(
                            VENTANA_BOVEDA_S,
                            KeyProperties.AUTH_BIOMETRIC_STRONG or KeyProperties.AUTH_DEVICE_CREDENTIAL,
                        )
                    } else {
                        @Suppress("DEPRECATION")
                        setUserAuthenticationValidityDurationSeconds(VENTANA_BOVEDA_S)
                    }
                }
                .build()
            KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
                .apply { init(spec) }
                .generateKey()
        } catch (e: Exception) {
            promesa.reject("E_KEYGEN", fallo("probarBoveda/keygen", e), e)
            return
        }

        fun limpiar() {
            try {
                val ks = keystore()
                if (ks.containsAlias(ALIAS_DIAG_BOVEDA)) ks.deleteEntry(ALIAS_DIAG_BOVEDA)
            } catch (e: Exception) {
                Log.w("SelloSigning", "no se pudo borrar la clave de diagnóstico: ${e.message}")
            }
        }

        actividad.runOnUiThread {
            val prompt = BiometricPrompt(
                actividad,
                ContextCompat.getMainExecutor(actividad),
                object : BiometricPrompt.AuthenticationCallback() {

                    override fun onAuthenticationSucceeded(resultado: BiometricPrompt.AuthenticationResult) {
                        val (funciona, detalle) = try {
                            val entrada = keystore().getEntry(ALIAS_DIAG_BOVEDA, null) as KeyStore.SecretKeyEntry
                            val dato = ByteArray(32).also { SecureRandom().nextBytes(it) }

                            val cifrador = Cipher.getInstance("AES/GCM/NoPadding")
                                .apply { init(Cipher.ENCRYPT_MODE, entrada.secretKey) }
                            val ct = cifrador.doFinal(dato)

                            val descifrador = Cipher.getInstance("AES/GCM/NoPadding").apply {
                                init(Cipher.DECRYPT_MODE, entrada.secretKey, GCMParameterSpec(128, cifrador.iv))
                            }
                            val claro = descifrador.doFinal(ct)

                            val ok = claro.contentEquals(dato)
                            Log.i(
                                "SelloSigning",
                                "diag AES-GCM con autenticación: " +
                                    if (ok) "FUNCIONA" else "descifra pero no coincide",
                            )
                            ok to (if (ok) "" else "el resultado no coincide con el original")
                        } catch (e: Exception) {
                            val causa = causaDe(e)
                            Log.w("SelloSigning", "diag AES-GCM con autenticación: $causa")
                            false to causa
                        } finally {
                            limpiar()
                        }

                        promesa.resolve(Arguments.createMap().apply {
                            putBoolean("funciona", funciona)
                            putString("detalle", detalle)
                        })
                    }

                    override fun onAuthenticationError(codigo: Int, mensaje: CharSequence) {
                        limpiar()
                        when (codigo) {
                            BiometricPrompt.ERROR_USER_CANCELED,
                            BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                            BiometricPrompt.ERROR_CANCELED,
                            -> promesa.reject("E_USER_CANCELED", "Cancelado por el usuario.")
                            else -> promesa.reject("E_BIOMETRIA", mensaje.toString())
                        }
                    }
                },
            )

            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(titulo)
                .setSubtitle(subtitulo)
                .setDescription("Comprueba, con una operación real, que la bóveda funciona en este equipo.")
                .setAllowedAuthenticators(AUTENTICADORES)
                .setConfirmationRequired(true)
                .build()

            prompt.authenticate(info)
        }
    }

    // ── firma ────────────────────────────────────────────

    /**
     * El reto llega en base64 y se firma dentro del chip. El texto del prompt
     * lleva el contexto (qué y para quién) para que el usuario no apruebe a ciegas.
     */
    @ReactMethod
    fun firmar(retoB64: String, titulo: String, subtitulo: String, promesa: Promise) {
        val actividad = reactApplicationContext.currentActivity as? FragmentActivity
        if (actividad == null) {
            promesa.reject("E_SIN_ACTIVIDAD", "La app no está en primer plano.")
            return
        }

        val reto = try {
            Base64.decode(retoB64, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            promesa.reject("E_RETO", "El reto no es base64 válido.", e); return
        }

        val firma: Signature = try {
            val entrada = keystore().getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry
                ?: run { promesa.reject("E_SIN_IDENTIDAD", "No hay identidad de firma."); return }
            Signature.getInstance("SHA256withECDSA").apply { initSign(entrada.privateKey) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            promesa.reject("E_KEY_INVALIDATED", "La biometría del dispositivo cambió.", e); return
        } catch (e: Exception) {
            promesa.reject("E_KEYSTORE", e.message, e); return
        }

        val keyId = prefs.getString(PREF_KEY_ID, "") ?: ""

        actividad.runOnUiThread {
            val prompt = BiometricPrompt(
                actividad,
                ContextCompat.getMainExecutor(actividad),
                object : BiometricPrompt.AuthenticationCallback() {

                    override fun onAuthenticationSucceeded(resultado: BiometricPrompt.AuthenticationResult) {
                        try {
                            // Solo la Signature que salió del CryptoObject está desbloqueada.
                            val s = resultado.cryptoObject?.signature
                                ?: throw IllegalStateException("El prompt no devolvió la firma vinculada.")
                            s.update(reto)
                            promesa.resolve(Arguments.createMap().apply {
                                putString("firmaDerB64", b64(s.sign()))
                                putString("keyId", keyId)
                            })
                        } catch (e: Exception) {
                            promesa.reject("E_FIRMA", fallo("firmar", e), e)
                        }
                    }

                    override fun onAuthenticationError(codigo: Int, mensaje: CharSequence) {
                        when (codigo) {
                            BiometricPrompt.ERROR_USER_CANCELED,
                            BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                            BiometricPrompt.ERROR_CANCELED,
                            -> promesa.reject("E_USER_CANCELED", "Cancelado por el usuario.")
                            else -> promesa.reject("E_BIOMETRIA", mensaje.toString())
                        }
                    }

                    // No resolvemos nada en onAuthenticationFailed: el prompt sigue abierto.
                },
            )

            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(titulo)
                .setSubtitle(subtitulo)
                .setDescription("La aprobación se genera dentro del chip seguro. Nada sale del teléfono.")
                // Sin setNegativeButtonText: con DEVICE_CREDENTIAL permitido, el
                // sistema pone su propio botón y declarar uno propio lanza excepción.
                .setAllowedAuthenticators(AUTENTICADORES)
                .setConfirmationRequired(true)
                .build()

            prompt.authenticate(info, BiometricPrompt.CryptoObject(firma))
        }
    }

    // ── autenticación genérica ─────────────────────────────

    /**
     * §10.1 — autenticación "a secas": sin CryptoObject, no ata la
     * aprobación a ninguna operación concreta. Su único efecto es desbloquear,
     * durante VENTANA_BOVEDA_S segundos, las claves con autenticación por
     * ventana — hoy, únicamente la bóveda.
     *
     * Se llama antes de cifrarEnBoveda() o descifrarDeBoveda(); si esas
     * llamadas ocurren dentro de la ventana no hace falta repetirla.
     */
    @ReactMethod
    fun autenticar(titulo: String, subtitulo: String, promesa: Promise) {
        val actividad = reactApplicationContext.currentActivity as? FragmentActivity
        if (actividad == null) {
            promesa.reject("E_SIN_ACTIVIDAD", "La app no está en primer plano.")
            return
        }

        actividad.runOnUiThread {
            val prompt = BiometricPrompt(
                actividad,
                ContextCompat.getMainExecutor(actividad),
                object : BiometricPrompt.AuthenticationCallback() {

                    override fun onAuthenticationSucceeded(resultado: BiometricPrompt.AuthenticationResult) {
                        promesa.resolve(null)
                    }

                    override fun onAuthenticationError(codigo: Int, mensaje: CharSequence) {
                        when (codigo) {
                            BiometricPrompt.ERROR_USER_CANCELED,
                            BiometricPrompt.ERROR_NEGATIVE_BUTTON,
                            BiometricPrompt.ERROR_CANCELED,
                            -> promesa.reject("E_USER_CANCELED", "Cancelado por el usuario.")
                            else -> promesa.reject("E_BIOMETRIA", mensaje.toString())
                        }
                    }
                },
            )

            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(titulo)
                .setSubtitle(subtitulo)
                .setAllowedAuthenticators(AUTENTICADORES)
                .setConfirmationRequired(true)
                .build()

            prompt.authenticate(info)
        }
    }

    // ── descifrado ───────────────────────────────────────

    /**
     * §10 / §10.1 — abre un sobre cifrado híbrido, todo dentro del módulo
     * nativo, SIN pedir autenticación.
     *
     * Antes este paso pedía BiometricPrompt + CryptoObject sobre la clave
     * RSA. Se quitó porque en este keymaster esa combinación no funciona
     * (ver generarCifrado()) y, mirado con calma, porque no hacía falta: lo
     * que autoriza recibir un secreto nuevo es la firma de la prueba de
     * posesión, que ya viajó un instante antes en pruebaDePosesion() y esa sí
     * funciona. Pedir otra vez aquí era repetir la misma comprobación con
     * otro nombre, no añadir una nueva. La autenticación real de este flujo
     * vive ahora en la bóveda — ver cifrarEnBoveda()/descifrarDeBoveda() y
     * §10.1 de diseno_app.md.
     *
     * El dato se abre en dos pasos, igual que antes: la clave AES se
     * desenvuelve con la privada RSA y el dato se abre con AES-GCM, los dos
     * aquí mismo. Ni la privada RSA ni la clave AES cruzan el puente a
     * JavaScript; solo sale el claro.
     *
     * MGF1 va con SHA-1, no con SHA-256 — ver generarCifrado() para el
     * porqué.
     */
    @ReactMethod
    fun abrirSobre(
        claveEnvueltaB64: String,
        ivB64: String,
        cifradoB64: String,
        tagB64: String,
        promesa: Promise,
    ) {
        val partes = try {
            listOf(claveEnvueltaB64, ivB64, cifradoB64, tagB64).map { Base64.decode(it, Base64.NO_WRAP) }
        } catch (e: IllegalArgumentException) {
            promesa.reject("E_CIFRADO", "El sobre cifrado no es base64 válido.", e); return
        }
        val (claveEnvuelta, iv, cifrado, tag) = partes

        // Los tamaños delatan la mitad de los fallos: la clave envuelta tiene que
        // medir exactamente lo que el módulo RSA (256 bytes con RSA-2048), el IV
        // 12 y el tag 16. Si alguno no cuadra, el problema está en el transporte
        // o en el emisor, no en el chip.
        Log.i(
            "SelloSigning",
            "abrirSobre: claveEnvuelta=${claveEnvuelta.size}B iv=${iv.size}B " +
                "cifrado=${cifrado.size}B tag=${tag.size}B",
        )

        var claveAes: ByteArray? = null
        try {
            val entrada = keystore().getEntry(ALIAS_CIFRADO, null) as? KeyStore.PrivateKeyEntry
                ?: run { promesa.reject("E_SIN_IDENTIDAD", "No hay clave de cifrado."); return }
            describirClave(ALIAS_CIFRADO, entrada.privateKey)

            // 1. La clave AES se desenvuelve dentro del chip.
            val rsa = Cipher.getInstance("RSA/ECB/OAEPPadding").apply {
                init(
                    Cipher.DECRYPT_MODE,
                    entrada.privateKey,
                    OAEPParameterSpec("SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT),
                )
            }
            claveAes = rsa.doFinal(claveEnvuelta)

            // 2. Y el dato se abre aquí mismo, en Kotlin. Hacerlo en JavaScript
            //    obligaría a pasar la clave AES en claro por el puente, que es
            //    justo lo que este diseño evita.
            val gcm = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(
                    Cipher.DECRYPT_MODE,
                    SecretKeySpec(claveAes, "AES"),
                    // El tag va al final del texto cifrado en la API de
                    // Java; por eso se concatena en vez de pasarse aparte.
                    GCMParameterSpec(tag.size * 8, iv),
                )
            }
            val claro = gcm.doFinal(cifrado + tag)

            promesa.resolve(Arguments.createMap().apply {
                putString("claroB64", b64(claro))
            })
        } catch (e: javax.crypto.AEADBadTagException) {
            // GCM autentica: si el tag no cuadró, alguien alteró el dato por
            // el camino. No se devuelve nada a medias.
            promesa.reject("E_ALTERADO", "El secreto llegó alterado.", e)
        } catch (e: Exception) {
            // Ya no debería pasar por autenticación ni por StrongBox — eran
            // justo los dos fallos que este código corrige — pero si algo más
            // rompe esta combinación de parámetros, el diagnóstico de siempre
            // sigue disponible.
            promesa.reject("E_DESCIFRADO", fallo("abrirSobre", e), e)
            Thread { diagnosticarOaep() }.start()
        } finally {
            // La clave AES no tiene por qué seguir en memoria.
            claveAes?.fill(0)
        }
    }

    // ── bóveda ───────────────────────────────────────────

    /**
     * §10.1 / §11 — cifra un dato para la bóveda local con la clave AES-GCM
     * `sello.boveda.v1`. Pide autenticación reciente (ver autenticar()); si
     * la ventana ya expiró, el Keystore lanza UserNotAuthenticatedException
     * y se traduce a E_SIN_AUTENTICAR para que el lado JS pueda llamar a
     * autenticar() y reintentar.
     *
     * El IV no se elige aquí a mano: para una clave del Keystore,
     * AndroidKeyStore genera uno nuevo en cada cifrado y lo expone en
     * `cipher.iv` después de init(). Fijarlo a mano sería reutilizar nonces
     * con GCM, justo lo que el documento prohíbe en su §20.
     */
    @ReactMethod
    fun cifrarEnBoveda(claroB64: String, promesa: Promise) {
        try {
            val claro = try {
                Base64.decode(claroB64, Base64.NO_WRAP)
            } catch (e: IllegalArgumentException) {
                promesa.reject("E_CIFRADO", "El dato a guardar no es base64 válido.", e); return
            }
            val entrada = keystore().getEntry(ALIAS_BOVEDA, null) as? KeyStore.SecretKeyEntry
                ?: run { promesa.reject("E_SIN_IDENTIDAD", "No hay clave de bóveda."); return }

            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.ENCRYPT_MODE, entrada.secretKey)
            }
            val salida = cipher.doFinal(claro)
            val corte = salida.size - 16

            promesa.resolve(Arguments.createMap().apply {
                putString("ivB64", b64(cipher.iv))
                putString("cifradoB64", b64(salida.copyOfRange(0, corte)))
                putString("tagB64", b64(salida.copyOfRange(corte, salida.size)))
            })
        } catch (e: UserNotAuthenticatedException) {
            promesa.reject("E_SIN_AUTENTICAR", "Hay que autenticar antes de guardar en la bóveda.", e)
        } catch (e: KeyPermanentlyInvalidatedException) {
            promesa.reject("E_KEY_INVALIDATED", "La biometría del dispositivo cambió.", e)
        } catch (e: Exception) {
            promesa.reject("E_CIFRADO", fallo("cifrarEnBoveda", e), e)
        }
    }

    /** §10.1 / §14 — el inverso: lee un secreto de la bóveda. Misma regla de autenticación. */
    @ReactMethod
    fun descifrarDeBoveda(ivB64: String, cifradoB64: String, tagB64: String, promesa: Promise) {
        try {
            val partes = try {
                listOf(ivB64, cifradoB64, tagB64).map { Base64.decode(it, Base64.NO_WRAP) }
            } catch (e: IllegalArgumentException) {
                promesa.reject("E_DESCIFRADO", "El sobre guardado no es base64 válido.", e); return
            }
            val (iv, cifrado, tag) = partes

            val entrada = keystore().getEntry(ALIAS_BOVEDA, null) as? KeyStore.SecretKeyEntry
                ?: run { promesa.reject("E_SIN_IDENTIDAD", "No hay clave de bóveda."); return }

            val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.DECRYPT_MODE, entrada.secretKey, GCMParameterSpec(tag.size * 8, iv))
            }
            val claro = cipher.doFinal(cifrado + tag)

            promesa.resolve(Arguments.createMap().apply { putString("claroB64", b64(claro)) })
        } catch (e: javax.crypto.AEADBadTagException) {
            promesa.reject("E_ALTERADO", "El secreto guardado llegó alterado.", e)
        } catch (e: UserNotAuthenticatedException) {
            promesa.reject("E_SIN_AUTENTICAR", "Hay que autenticar antes de leer la bóveda.", e)
        } catch (e: KeyPermanentlyInvalidatedException) {
            promesa.reject("E_KEY_INVALIDATED", "La biometría del dispositivo cambió.", e)
        } catch (e: Exception) {
            promesa.reject("E_DESCIFRADO", fallo("descifrarDeBoveda", e), e)
        }
    }

    // ── cifrado ──────────────────────────────────────────

    /**
     * §14 — cierra un sobre cifrado para el dominio. El inverso de abrirSobre().
     *
     * Aquí solo se usa la clave PÚBLICA del dominio, así que no hay nada del
     * Keystore de por medio y no se pide biometría: la autenticación ya la
     * exigió la firma que va dentro del sobre. Pedirla otra vez sería un
     * segundo prompt para una operación que cualquiera podría hacer con datos
     * públicos.
     *
     * Mismo esquema que en sentido contrario, y por los mismos motivos: la
     * clave AES envuelta con RSA-OAEP y el dato con AES-256-GCM. RSA-2048
     * solo admitiría unos 190 bytes directos, y GCM autentica: si alguien
     * altera el texto cifrado, el servidor lo detecta en vez de descifrar
     * basura.
     *
     * OAEP va con SHA-256 y MGF1 con SHA-1, igual que al descifrar. Aquí la
     * clave no es del Keystore, así que el proveedor sí admitiría MGF1-SHA256,
     * pero se mantiene la misma combinación en los dos sentidos: un solo
     * conjunto de parámetros que recordar, y el mismo que ya está probado en
     * hardware. El servidor tiene que descifrar con exactamente estos.
     */
    @ReactMethod
    fun cerrarSobre(clavePublicaSpkiB64: String, claroB64: String, promesa: Promise) {
        var claveAes: ByteArray? = null
        try {
            val spki = try {
                Base64.decode(clavePublicaSpkiB64, Base64.NO_WRAP)
            } catch (e: IllegalArgumentException) {
                promesa.reject("E_CLAVE_DOMINIO", "La clave del dominio no es base64 válida.", e); return
            }
            val claro = try {
                Base64.decode(claroB64, Base64.NO_WRAP)
            } catch (e: IllegalArgumentException) {
                promesa.reject("E_CIFRADO", "El dato a cifrar no es base64 válido.", e); return
            }

            // La clave llega de la verificación del dominio, no de un sitio de
            // confianza absoluta: se comprueba que sea lo que dice ser antes de
            // usarla. Una clave corta cifraría, y el resultado sería inútil.
            val publica = try {
                KeyFactory.getInstance("RSA").generatePublic(X509EncodedKeySpec(spki))
            } catch (e: Exception) {
                promesa.reject("E_CLAVE_DOMINIO", "La clave del dominio no es una clave RSA válida.", e); return
            }
            if (publica !is RSAPublicKey || publica.modulus.bitLength() < 2048) {
                promesa.reject("E_CLAVE_DOMINIO", "La clave del dominio es demasiado corta.")
                return
            }

            val azar = SecureRandom()
            claveAes = ByteArray(32).also { azar.nextBytes(it) }
            val iv = ByteArray(12).also { azar.nextBytes(it) }

            val gcm = Cipher.getInstance("AES/GCM/NoPadding").apply {
                init(Cipher.ENCRYPT_MODE, SecretKeySpec(claveAes, "AES"), GCMParameterSpec(128, iv))
            }
            // La API de Java devuelve texto cifrado y tag pegados; se separan
            // porque el otro lado los recibe como campos distintos.
            val salida = gcm.doFinal(claro)
            val corte = salida.size - 16
            val cifrado = salida.copyOfRange(0, corte)
            val tag = salida.copyOfRange(corte, salida.size)

            val rsa = Cipher.getInstance("RSA/ECB/OAEPPadding").apply {
                init(
                    Cipher.ENCRYPT_MODE,
                    publica,
                    OAEPParameterSpec(
                        "SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT,
                    ),
                )
            }
            val envuelta = rsa.doFinal(claveAes)

            promesa.resolve(Arguments.createMap().apply {
                // El nombre dice la combinación exacta, para que el otro lado
                // no tenga que adivinar los parámetros.
                putString("alg", "RSA-OAEP-256-MGF1SHA1+A256GCM")
                putString("claveEnvueltaB64", b64(envuelta))
                putString("ivB64", b64(iv))
                putString("cifradoB64", b64(cifrado))
                putString("tagB64", b64(tag))
            })
        } catch (e: Exception) {
            promesa.reject("E_CIFRADO", fallo("cerrarSobre", e), e)
        } finally {
            // El claro sigue en JavaScript, pero la clave AES no tiene por qué
            // seguir en memoria aquí.
            claveAes?.fill(0)
        }
    }

    // ── borrado ──────────────────────────────────────────

    @ReactMethod
    fun borrarIdentidad(promesa: Promise) {
        try {
            val ks = keystore()
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
            if (ks.containsAlias(ALIAS_CIFRADO)) ks.deleteEntry(ALIAS_CIFRADO)
            if (ks.containsAlias(ALIAS_BOVEDA)) ks.deleteEntry(ALIAS_BOVEDA)
            prefs.edit().clear().apply()
            promesa.resolve(null)
        } catch (e: Exception) {
            promesa.reject("E_KEYSTORE", e.message, e)
        }
    }

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)
}

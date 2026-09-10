package io.sello.app.signing

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
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
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource
import javax.crypto.spec.SecretKeySpec

/**
 * Identidad criptográfica del dispositivo.
 *
 * Son DOS claves, y la separación no es capricho:
 *
 *   - EC P-256 (PURPOSE_SIGN) para firmar: identidad, prueba de posesión y
 *     aprobaciones.
 *   - RSA-2048 (PURPOSE_DECRYPT, OAEP-SHA256) para recibir secretos cifrados
 *     por el dominio.
 *
 * Se descartó ECDH con una sola clave porque PURPOSE_AGREE_KEY exige API 31 y,
 * sobre todo, porque BiometricPrompt.CryptoObject no admite KeyAgreement: la
 * clave de acuerdo solo puede protegerse con una VENTANA DE TIEMPO, no por
 * operación. RSA usa Cipher, que sí entra en CryptoObject, así que cada
 * descifrado sigue exigiendo autenticación explícita — que es la propiedad
 * sobre la que se apoya todo este diseño.
 *
 * Ninguna privada cruza el puente a JavaScript: por aquí salen firmas, claves
 * públicas y texto en claro ya descifrado.
 */
class SigningModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "SelloSigning"

    private companion object {
        const val ALIAS = "sello.identidad.v1"
        const val ALIAS_CIFRADO = "sello.cifrado.v1"
        const val ALIAS_DIAG = "sello.diagnostico.v1"
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
    }

    private val prefs by lazy { ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    private fun keystore(): KeyStore =
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    // ── consulta ───────────────────────────────────────────

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

    // ── creación ──────────────────────────────────────────

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

            val keyId = UUID.randomUUID().toString()
            // StrongBox primero; si el equipo no lo tiene, TEE. Si ambos fallan se
            // propaga la causa real en vez de reportar un genérico.
            val conStrongBox = try {
                generar(keyId, strongBox = true); true
            } catch (e: Exception) {
                generar(keyId, strongBox = false); false
            }

            // La de cifrado va aparte: RSA en StrongBox no está en todos los
            // chips, así que se intenta y se cae al TEE sin arrastrar a la otra.
            try {
                generarCifrado(strongBox = true)
            } catch (e: Exception) {
                generarCifrado(strongBox = false)
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
     * Ojo con OAEP: el AndroidKeyStore solo admite MGF1 con SHA-1, aunque el
     * hash de OAEP sea SHA-256. Lo comprobamos en hardware: con MGF1-SHA256
     * lanza "Unsupported MGF1 digest". El emisor tiene que cifrar con esa
     * misma combinación. Ver abrirSobre().
     */
    private fun generarCifrado(strongBox: Boolean) {
        if (strongBox && Build.VERSION.SDK_INT < Build.VERSION_CODES.P) {
            throw UnsupportedOperationException("StrongBox exige API 28+")
        }

        val hayBiometriaFuerte = BiometricManager.from(ctx)
            .canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

        val spec = KeyGenParameterSpec.Builder(ALIAS_CIFRADO, KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(2048)
            // Los DOS digests. El de OAEP es SHA-256, pero MGF1 usa SHA-1 y el
            // Keystore comprueba que la clave autorice ambos: declarando solo
            // SHA-256, el descifrado falla con IllegalBlockSizeException, que
            // no dice nada de la causa real.
            .setDigests(KeyProperties.DIGEST_SHA256, KeyProperties.DIGEST_SHA1)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_RSA_OAEP)
            .setUserAuthenticationRequired(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && hayBiometriaFuerte) {
                    setInvalidatedByBiometricEnrollment(true)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
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

        KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, ANDROID_KEYSTORE)
            .apply { initialize(spec) }
            .generateKeyPair()
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

    // ── diagnóstico ───────────────────────────────

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
     * verdad.
     *
     * El keymaster devuelve KM_ERROR_UNKNOWN_ERROR para cualquier fallo
     * interno, así que desde fuera no hay forma de distinguir "este digest no
     * me lo soporta el TEE" de "la autenticación no se aplicó bien". Esto lo
     * separa: genera una clave temporal con los MISMOS parámetros pero SIN
     * autenticación de usuario, y cifra y descifra contra ella con cada
     * variante.
     *
     * Así la lectura es directa:
     *   - si fallan las variantes con SHA-256, es que el TEE no las soporta
     *     aunque acepte declararlas al generar la clave;
     *   - si funcionan todas, el problema no es OAEP sino la autenticación
     *     por operación de la clave real.
     *
     * La clave temporal se borra al terminar. Es diagnóstico, no camino de
     * producción: no cifra nada real ni toca las claves de la identidad.
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

            fun probar(nombre: String, transformacion: String, spec: OAEPParameterSpec?) {
                try {
                    val cifrador = Cipher.getInstance(transformacion).apply {
                        if (spec != null) init(Cipher.ENCRYPT_MODE, publica, spec)
                        else init(Cipher.ENCRYPT_MODE, publica)
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
            Log.i("SelloSigning", "diag ── clave temporal SIN autenticación ──")
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
        } catch (e: Exception) {
            Log.w("SelloSigning", "no se pudo diagnosticar: ${causaDe(e)}")
        }
    }

    // ── firma ─────────────────────────────────

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

    // ── descifrado ────────────────────────────────

    /**
     * §10 — abre un sobre cifrado híbrido, todo dentro del módulo nativo.
     *
     * El dominio cifra el dato con AES-256-GCM y envuelve la clave AES con la
     * clave pública RSA de esta app. Aquí se hacen los dos pasos: la clave se
     * desenvuelve en el chip y el dato se abre en Kotlin. Ni la privada RSA ni
     * la clave AES cruzan el puente a JavaScript; solo sale el claro.
     *
     * MGF1 va con SHA-1, no con SHA-256. El AndroidKeyStore rechaza MGF1-SHA256
     * con "Unsupported MGF1 digest: SHA-256. Only SHA-1 supported" — lo
     * comprobamos en hardware, no en la documentación. El hash de OAEP sí es
     * SHA-256; MGF1 es un parámetro aparte, y el emisor debe cifrar con esta
     * misma combinación o el descifrado falla.
     *
     * Además hay que inicializar el Cipher con el spec ANTES de meterlo en el
     * CryptoObject: lo que el prompt desbloquea es esa instancia concreta.
     */
    @ReactMethod
    fun abrirSobre(
        claveEnvueltaB64: String,
        ivB64: String,
        cifradoB64: String,
        tagB64: String,
        titulo: String,
        subtitulo: String,
        promesa: Promise,
    ) {
        val actividad = reactApplicationContext.currentActivity as? FragmentActivity
        if (actividad == null) {
            promesa.reject("E_SIN_ACTIVIDAD", "La app no está en primer plano.")
            return
        }

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

        val cipher: Cipher = try {
            val entrada = keystore().getEntry(ALIAS_CIFRADO, null) as? KeyStore.PrivateKeyEntry
                ?: run { promesa.reject("E_SIN_IDENTIDAD", "No hay clave de cifrado."); return }
            describirClave(ALIAS_CIFRADO, entrada.privateKey)
            Cipher.getInstance("RSA/ECB/OAEPPadding").apply {
                init(
                    Cipher.DECRYPT_MODE,
                    entrada.privateKey,
                    OAEPParameterSpec(
                        "SHA-256", "MGF1", MGF1ParameterSpec.SHA1, PSource.PSpecified.DEFAULT,
                    ),
                )
            }
        } catch (e: KeyPermanentlyInvalidatedException) {
            promesa.reject("E_KEY_INVALIDATED", "La biometría del dispositivo cambió.", e); return
        } catch (e: Exception) {
            promesa.reject("E_KEYSTORE", fallo("abrirSobre/init", e), e); return
        }

        actividad.runOnUiThread {
            val prompt = BiometricPrompt(
                actividad,
                ContextCompat.getMainExecutor(actividad),
                object : BiometricPrompt.AuthenticationCallback() {

                    override fun onAuthenticationSucceeded(resultado: BiometricPrompt.AuthenticationResult) {
                        var claveAes: ByteArray? = null
                        try {
                            // Solo el Cipher que salió del CryptoObject está desbloqueado.
                            val c = resultado.cryptoObject?.cipher
                                ?: throw IllegalStateException("El prompt no devolvió el cifrador vinculado.")

                            // 1. La clave AES se desenvuelve DENTRO del chip.
                            claveAes = c.doFinal(claveEnvuelta)

                            // 2. Y el dato se abre aquí mismo, en Kotlin. Hacerlo en
                            //    JavaScript obligaría a pasar la clave AES en claro por
                            //    el puente, que es justo lo que este diseño evita.
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
                            // GCM autentica: si el tag no cuadra, alguien alteró el
                            // dato por el camino. No se devuelve nada a medias.
                            promesa.reject("E_ALTERADO", "El secreto llegó alterado.", e)
                        } catch (e: Exception) {
                            // Un fallo aquí suele ser padding: el emisor cifró con
                            // otros parámetros OAEP que los que espera esta clave.
                            promesa.reject("E_DESCIFRADO", fallo("abrirSobre", e), e)
                            // En un hilo aparte: genera una clave y hace cinco
                            // operaciones, demasiado para el hilo principal.
                            Thread { diagnosticarOaep() }.start()
                        } finally {
                            // La clave AES no tiene por qué seguir en memoria.
                            claveAes?.fill(0)
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
                },
            )

            val info = BiometricPrompt.PromptInfo.Builder()
                .setTitle(titulo)
                .setSubtitle(subtitulo)
                .setDescription("Se abre dentro del chip seguro. La clave no sale del teléfono.")
                .setAllowedAuthenticators(AUTENTICADORES)
                .setConfirmationRequired(true)
                .build()

            prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
        }
    }

    // ── cifrado ───────────────────────────────

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

    // ── borrado ───────────────────────────────

    @ReactMethod
    fun borrarIdentidad(promesa: Promise) {
        try {
            val ks = keystore()
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
            if (ks.containsAlias(ALIAS_CIFRADO)) ks.deleteEntry(ALIAS_CIFRADO)
            prefs.edit().clear().apply()
            promesa.resolve(null)
        } catch (e: Exception) {
            promesa.reject("E_KEYSTORE", e.message, e)
        }
    }

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)
}

package io.sello.app.signing

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.*
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.MGF1ParameterSpec
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.OAEPParameterSpec
import javax.crypto.spec.PSource

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

    // ── consulta ────────────────────────────────────────────────────────────

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

    // ── creación ────────────────────────────────────────────────────────────

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
     * Ojo con OAEP: el AndroidKeyStore usa MGF1-SHA1 si no se le pasa un
     * OAEPParameterSpec explícito, aunque el padding diga SHA-256. WebCrypto
     * usa MGF1 con el mismo hash que OAEP, así que sin el spec explícito el
     * descifrado falla sin decir por qué. Ver descifrar().
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
            .setDigests(KeyProperties.DIGEST_SHA256)
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
                putString("algoritmoCifrado", "RSA-OAEP-256")
            }
            putBoolean("strongBox", prefs.getBoolean(PREF_STRONGBOX, false))
            putDouble("creadaEn", prefs.getLong(PREF_CREADA, 0L).toDouble())
            putArray("attestationB64", attestation)
        }
    }

    // ── firma ───────────────────────────────────────────────────────────────

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
                            promesa.reject("E_FIRMA", e.message, e)
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

    // ── descifrado ──────────────────────────────────────────────────────────

    /**
     * Descifra con la clave RSA del chip, tras autenticación del usuario.
     *
     * El OAEPParameterSpec explícito NO es decorativo: el AndroidKeyStore
     * asume MGF1-SHA1 aunque el padding declare SHA-256, mientras que
     * WebCrypto usa MGF1 con el mismo hash que OAEP. Sin pasar el spec, el
     * descifrado falla con un error genérico y sin pista de la causa.
     *
     * Además hay que inicializar el Cipher con el spec ANTES de meterlo en el
     * CryptoObject: lo que el prompt desbloquea es esa instancia concreta.
     */
    @ReactMethod
    fun descifrar(cifradoB64: String, titulo: String, subtitulo: String, promesa: Promise) {
        val actividad = reactApplicationContext.currentActivity as? FragmentActivity
        if (actividad == null) {
            promesa.reject("E_SIN_ACTIVIDAD", "La app no está en primer plano.")
            return
        }

        val cifrado = try {
            Base64.decode(cifradoB64, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            promesa.reject("E_CIFRADO", "El dato cifrado no es base64 válido.", e); return
        }

        val cipher: Cipher = try {
            val entrada = keystore().getEntry(ALIAS_CIFRADO, null) as? KeyStore.PrivateKeyEntry
                ?: run { promesa.reject("E_SIN_IDENTIDAD", "No hay clave de cifrado."); return }
            Cipher.getInstance("RSA/ECB/OAEPPadding").apply {
                init(
                    Cipher.DECRYPT_MODE,
                    entrada.privateKey,
                    OAEPParameterSpec(
                        "SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT,
                    ),
                )
            }
        } catch (e: KeyPermanentlyInvalidatedException) {
            promesa.reject("E_KEY_INVALIDATED", "La biometría del dispositivo cambió.", e); return
        } catch (e: Exception) {
            promesa.reject("E_KEYSTORE", e.message, e); return
        }

        actividad.runOnUiThread {
            val prompt = BiometricPrompt(
                actividad,
                ContextCompat.getMainExecutor(actividad),
                object : BiometricPrompt.AuthenticationCallback() {

                    override fun onAuthenticationSucceeded(resultado: BiometricPrompt.AuthenticationResult) {
                        try {
                            // Solo el Cipher que salió del CryptoObject está desbloqueado.
                            val c = resultado.cryptoObject?.cipher
                                ?: throw IllegalStateException("El prompt no devolvió el cifrador vinculado.")
                            promesa.resolve(Arguments.createMap().apply {
                                putString("claroB64", b64(c.doFinal(cifrado)))
                            })
                        } catch (e: Exception) {
                            // Un fallo aquí suele ser padding: el emisor cifró con
                            // otros parámetros OAEP que los que espera esta clave.
                            promesa.reject("E_DESCIFRADO", e.message, e)
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

    // ── borrado ─────────────────────────────────────────────────────────────

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

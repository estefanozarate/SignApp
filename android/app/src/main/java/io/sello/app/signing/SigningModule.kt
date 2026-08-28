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
import java.util.UUID

/**
 * Módulo B — identidad de firma.
 *
 * La clave privada se genera dentro del AndroidKeyStore y nunca cruza el puente
 * a JavaScript: por aquí solo salen firmas y metadatos públicos. Cada uso exige
 * autenticación del usuario (BiometricPrompt + CryptoObject): biometría fuerte
 * si el equipo la tiene, o el PIN/patrón del dispositivo si no. En equipos con
 * biometría fuerte, registrar una huella nueva invalida la clave.
 */
class SigningModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "SelloSigning"

    private companion object {
        const val ALIAS = "sello.identidad.v1"
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

    // ── consulta ──────────────────────────────────────────────────────

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

    // ── creación ─────────────────────────────────────────────────────

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

            val keyId = UUID.randomUUID().toString()
            // StrongBox primero; si el equipo no lo tiene, TEE. Si ambos fallan se
            // propaga la causa real en vez de reportar un genérico.
            val conStrongBox = try {
                generar(keyId, strongBox = true); true
            } catch (e: Exception) {
                generar(keyId, strongBox = false); false
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
            putBoolean("strongBox", prefs.getBoolean(PREF_STRONGBOX, false))
            putDouble("creadaEn", prefs.getLong(PREF_CREADA, 0L).toDouble())
            putArray("attestationB64", attestation)
        }
    }

    // ── firma ───────────────────────────────────────────────────────

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
                .setDescription("Se firmará dentro del chip seguro. Tu clave no sale del teléfono.")
                // Sin setNegativeButtonText: con DEVICE_CREDENTIAL permitido, el
                // sistema pone su propio botón y declarar uno propio lanza excepción.
                .setAllowedAuthenticators(AUTENTICADORES)
                .setConfirmationRequired(true)
                .build()

            prompt.authenticate(info, BiometricPrompt.CryptoObject(firma))
        }
    }

    // ── borrado ────────────────────────────────────────────────────

    @ReactMethod
    fun borrarIdentidad(promesa: Promise) {
        try {
            keystore().takeIf { it.containsAlias(ALIAS) }?.deleteEntry(ALIAS)
            prefs.edit().clear().apply()
            promesa.resolve(null)
        } catch (e: Exception) {
            promesa.reject("E_KEYSTORE", e.message, e)
        }
    }

    private fun b64(b: ByteArray) = Base64.encodeToString(b, Base64.NO_WRAP)
}

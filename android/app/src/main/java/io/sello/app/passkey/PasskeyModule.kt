package io.sello.app.passkey

import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.NoCredentialException
import androidx.fragment.app.FragmentActivity
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Módulo A — passkeys sobre androidx.credentials.
 *
 * El JSON que entra y sale es el de WebAuthn tal cual: aquí no se reinventa el
 * ceremonial, solo se pasa entre el backend (relying party) y el sistema.
 * La UI de esta parte la dibuja Android, no nosotros — por eso en el diseño
 * aparece con su propia tipografía, para que se note que es del sistema.
 */
class PasskeyModule(private val ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {

    override fun getName() = "SelloPasskey"

    private val manager by lazy { CredentialManager.create(ctx) }
    private val alcance = CoroutineScope(Dispatchers.Main)

    @ReactMethod
    fun disponible(promesa: Promise) {
        // Credential Manager llega hasta API 28 vía Play Services; el minSdk ya lo garantiza.
        promesa.resolve(true)
    }

    @ReactMethod
    fun registrar(opcionesJson: String, promesa: Promise) {
        val actividad = actividad(promesa) ?: return
        alcance.launch {
            try {
                val respuesta = manager.createCredential(
                    context = actividad,
                    request = CreatePublicKeyCredentialRequest(requestJson = opcionesJson),
                ) as CreatePublicKeyCredentialResponse
                promesa.resolve(respuesta.registrationResponseJson)
            } catch (e: CreateCredentialCancellationException) {
                promesa.reject("E_USER_CANCELED", "Cancelado por el usuario.")
            } catch (e: Exception) {
                promesa.reject("E_PASSKEY", e.message ?: "No se pudo crear la passkey.", e)
            }
        }
    }

    @ReactMethod
    fun autenticar(opcionesJson: String, promesa: Promise) {
        val actividad = actividad(promesa) ?: return
        alcance.launch {
            try {
                val peticion = GetCredentialRequest(
                    listOf(GetPublicKeyCredentialOption(requestJson = opcionesJson)),
                )
                val respuesta = manager.getCredential(context = actividad, request = peticion)
                val credencial = respuesta.credential as? PublicKeyCredential
                    ?: throw IllegalStateException("El sistema devolvió otro tipo de credencial.")
                promesa.resolve(credencial.authenticationResponseJson)
            } catch (e: GetCredentialCancellationException) {
                promesa.reject("E_USER_CANCELED", "Cancelado por el usuario.")
            } catch (e: NoCredentialException) {
                promesa.reject("E_NO_CREDENTIAL", "No hay ninguna passkey de Sello en este dispositivo.")
            } catch (e: Exception) {
                promesa.reject("E_PASSKEY", e.message ?: "No se pudo usar la passkey.", e)
            }
        }
    }

    private fun actividad(promesa: Promise): FragmentActivity? {
        val a = reactApplicationContext.currentActivity as? FragmentActivity
        if (a == null) promesa.reject("E_SIN_ACTIVIDAD", "La app no está en primer plano.")
        return a
    }
}

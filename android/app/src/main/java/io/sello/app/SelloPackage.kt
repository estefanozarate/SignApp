package io.sello.app

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager
import io.sello.app.cose.CoseModule
import io.sello.app.passkey.PasskeyModule
import io.sello.app.signing.SigningModule

class SelloPackage : ReactPackage {

    override fun createNativeModules(ctx: ReactApplicationContext): List<NativeModule> =
        listOf(
            SigningModule(ctx),   // Módulo B — Keystore
            PasskeyModule(ctx),   // Módulo A — Credential Manager
            CoseModule(ctx),      // Módulo C — verificación del QR
        )

    override fun createViewManagers(ctx: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

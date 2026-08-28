# Sello

App Android (React Native 0.87) para aprobar acciones de un sitio web escaneando
un QR firmado y devolviendo una firma hecha dentro del chip seguro del teléfono.

Implementa la arquitectura del documento: passkey (A), identidad de firma en el
Keystore (B), verificación criptográfica del QR (C), aprobación por WebRTC (D)
y logout con des-pareo separado (E).

---

## 1. Arrancar

```bash
npm install
npm run android          # con un emulador o teléfono conectado
```

Requisitos: JDK 17, Android SDK 37, NDK 27.1.12297006, Node 20+.
`minSdk` es **28** (lo exige Credential Manager), no 24.

El backend se apunta en `src/services/config.ts`. En debug, `10.0.2.2` es el
host desde el emulador.

## 2. Qué es nativo y por qué

Tres módulos Kotlin en `android/app/src/main/java/io/sello/app/`:

| Módulo | Archivo | Qué hace |
|---|---|---|
| A · Passkey | `passkey/PasskeyModule.kt` | `androidx.credentials`. Pasa el JSON WebAuthn entre tu backend y el sistema, sin reinventar el ceremonial. |
| B · Firma | `signing/SigningModule.kt` | Genera EC P-256 en `AndroidKeyStore` y firma con `BiometricPrompt` + `CryptoObject`. |
| C · COSE | `cose/CoseModule.kt` | Base45 → zlib → `COSE_Sign1` → ECDSA/EdDSA contra la trust-list. |

**No se usó `react-native-passkeys`.** Arrastra Expo Modules y ya teníamos que
bajar a Kotlin para el Keystore, así que la capa nativa quedó consistente y sin
dependencias extra.

Sobre el Módulo B, lo que importa:

- `setUserAuthenticationRequired(true)` + `setUserAuthenticationParameters(0, AUTH_BIOMETRIC_STRONG)`:
  autenticación **por operación**, no por ventana de tiempo.
- `setInvalidatedByBiometricEnrollment(true)`: si alguien registra una huella o
  un rostro nuevos, la clave muere. La app lo detecta como `E_KEY_INVALIDATED`
  y manda a re-emparejar.
- Se intenta primero **StrongBox** y se cae al TEE si el equipo no lo tiene.
- `setAttestationChallenge(keyId)`: la cadena de certificados va al backend en
  `POST /dispositivos` para que verifique que la clave nació en hardware real.
  **Valídala en el servidor** — sin eso, la attestation no sirve de nada.
- La clave privada nunca cruza el puente a JS. Solo salen firmas.

## 3. Formato del QR

```
"SL1:" + Base45( zlib( COSE_Sign1 ) )

COSE_Sign1 = 18([ protected, unprotected, payload, signature ])
protected  = { 1: alg (-7 ES256 | -8 EdDSA), 4: kid (bstr) }
payload    = { "sid": string,   // session_id
               "org": string,   // dominio que muestra el QR
               "iat": int,
               "exp": int,
               "sgu": string }  // wss:// del signaling — se rechaza si no es wss
```

Base45 (RFC 9285) en vez de Base64 porque el modo alfanumérico del QR lo
codifica más denso: menos módulos, código legible desde más lejos.

Se rechaza el código si el emisor no está en la trust-list, si el `alg` no
coincide con el registrado para ese emisor, si la firma no cubre exactamente
esos bytes, si caducó (con 60 s de margen de reloj) o si el signaling no es TLS.
No hay modo permisivo.

## 4. Contrato del backend

```
POST   /webauthn/registro/opciones   { username }        → { publicKey }
POST   /webauthn/registro/verificar  { credential }      → { token }
POST   /webauthn/login/opciones                          → { publicKey }
POST   /webauthn/login/verificar     { credential }      → { token }

POST   /dispositivos   { key_id, public_key, alg, strongbox, attestation[] }
DELETE /dispositivos/:key_id
DELETE /sesion

GET    /trust-list     → { issuers: [{ kid, alg, spkiB64, nombre }] }
GET    /actividad?limit=5 → { events: [{ id, que, cuando, resultado }] }

WS     {sgu}?session_id=…    Authorization: Bearer <token>
```

Sobre el WebSocket, el teléfono siempre **contesta**: el navegador crea la
oferta y el DataChannel.

```
navegador → { type: "offer", sdp }
teléfono  → { type: "answer", sdp }
ambos     → { type: "ice", candidate }

por el DataChannel:
navegador → { type: "challenge", origin, action, account, browser, location, challenge, exp }
teléfono  → { type: "signature", signature, key_id }   // DER en base64
          o { type: "denied", reason }
```

La firma se valida contra la clave pública de ese `key_id` sobre el nonce que
mandaste. El teléfono cierra DataChannel, PeerConnection y WebSocket en cuanto
termina; no deja nada abierto.

## 5. Tipografías

El diseño usa Bodoni Moda (display), IBM Plex Sans (UI) e IBM Plex Mono
(material criptográfico). No van incluidas por licencia/tamaño:

1. Baja los `.ttf` y ponlos en `android/app/src/main/assets/fonts/`
   con los nombres `BodoniModa-Regular.ttf`, `BodoniModa-Medium.ttf`,
   `IBMPlexSans-Regular.ttf`, `IBMPlexSans-Medium.ttf`,
   `IBMPlexSans-SemiBold.ttf`, `IBMPlexMono-Regular.ttf`.
2. `npx react-native-asset`
3. Pon `FUENTES_INSTALADAS = true` en `src/theme.ts`.

Mientras esté en `false` la app corre con la tipografía del sistema. Todo el
resto del diseño (color, escala, espaciado) sale de `src/theme.ts`.

## 6. Estado

Verificado en este repo: `npx tsc --noEmit` limpio y `react-native bundle`
completo para Android. El Kotlin **no** está compilado — hace falta el Android
SDK. La primera vez que corras `npm run android`, revisa ahí.

Pendientes conscientes, en orden de importancia:

1. **Validar la attestation en el backend.** Ahora se envía pero no sirve de
   nada si el servidor no comprueba la cadena contra las raíces de Google.
2. **Revocación del `session_id`.** El módulo C valida firma y vigencia; la
   comprobación contra el backend de que la sesión sigue abierta (paso 4 del
   documento) hoy la cubre implícitamente el signaling al rechazar la conexión.
   Si quieres protección fuerte contra replay, añade un `GET /sesiones/:sid`
   antes de abrir WebRTC.
3. **Firmar la trust-list.** Se cachea para verificar offline, pero el módulo
   nativo todavía la acepta tal cual llega del backend. Hay que firmarla y
   verificar esa firma antes de guardarla.
4. Fijar el certificado del backend (pinning) para el signaling.

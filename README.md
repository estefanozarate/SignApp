# Sello

App Android (React Native 0.87) que implementa `diseno_app.md`: un protocolo
de emparejamiento web↔app por QR con verificación HTTPS del dominio, y
transferencia de secretos ligados a ese dominio.

El teléfono es la identidad: no hay cuenta ni contraseña. Al primer arranque
genera sus claves en el Keystore de Android y no salen de ahí.

---

## 1. Arrancar

```bash
npm install
npm run android          # con un emulador o teléfono conectado
```

Requisitos: JDK 17, Android SDK 37, NDK 27.1.12297006, Node 20+.
`minSdk` es **28**.

Para probar de punta a punta hace falta el dominio de referencia:

```bash
cd server && npm start        # ver server/README.md
adb reverse tcp:8787 tcp:8787 # para que el teléfono lo alcance
```

Y, en un navegador, `web/index.html` (ábrelo con cualquier servidor
estático; no tiene build).

## 2. El protocolo, en una vuelta

```
1. El navegador pide al dominio una petición de emparejamiento (§4.1)
   y muestra el QR que devuelve (§4.2).
2. La app lo escanea y verifica el request_id directamente contra el
   dominio por HTTPS (§5) — nunca contra una URL que traiga el QR.
3. El dominio consume la petición (un solo uso) y devuelve su identidad
   pública (§6).
4. La app firma una prueba de posesión con su clave privada (§7) y se la
   entrega al dominio junto con sus claves públicas (§9).
5. El dominio verifica la prueba, registra la identidad de la app y le
   entrega un secreto cifrado para su clave pública (§10).
6. La app lo descifra en el Keystore y lo guarda cifrado en su bóveda
   local, ligado a la identidad de ESE dominio (§10.1, §11).
7. Más tarde, el dominio pide el secreto de vuelta con otro QR de un solo
   uso (§12). La app repite la verificación, comprueba que el dominio
   verificado es el mismo al que pertenece el secreto guardado (§13) y
   se lo devuelve firmado y cifrado para el dominio (§14).
```

Las peticiones son de un solo uso, caducan y llevan un nonce (§15); un
secreto guardado para un dominio no se libera para otro aunque el nombre
coincida, porque la comparación es contra la identidad criptográfica del
dominio, no contra el texto (§16).

El transporte entre app y dominio es HTTP normal (`POST /peticion`,
`GET /verificar/:id`, `POST/GET /respuesta/:id`), no WebRTC — ver
`server/README.md` § "Por qué esto es HTTP y no WebRTC" para el porqué;
es una decisión de implementación (§26.4), no un cambio al protocolo.

## 3. Qué es nativo y por qué

Un módulo Kotlin en `android/app/src/main/java/io/sello/app/signing/SigningModule.kt`
concentra todo el Keystore:

| Clave | Uso | Autenticación |
|---|---|---|
| EC P-256 | firma (prueba de posesión §7, respuesta §14) | biometría **por operación** |
| RSA-2048 | abrir el sobre que el dominio cifra al emparejar (§10) | ninguna — ver §10.1 |
| AES-256-GCM | bóveda local de secretos (§10.1, §11) | biometría **por ventana de validez** |

Ninguna es exportable; se intenta StrongBox y se cae al TEE si el equipo no
lo tiene. La sección §10.1 de `diseno_app.md` documenta por qué la clave RSA
no pide autenticación por operación (un Keymaster concreto no completaba el
descifrado con clave autenticada) y qué SÍ sigue exigiendo autenticación: la
prueba de posesión, la firma de la respuesta y el acceso a la bóveda.

La clave privada nunca cruza el puente a JS: `src/native/Signing.ts` solo
expone firmas, claves públicas y texto ya descifrado. `src/services/peticion.ts`
implementa el protocolo del lado app (lectura y verificación del QR, prueba
de posesión, apertura del sobre, respuesta firmada y cifrada);
`src/services/boveda.ts` guarda los secretos, siempre cifrados con la clave
de la bóveda, indexados por identidad de dominio.

## 4. Formato del QR

Exactamente el que pide §4.2 — JSON, sin firmar (la app no confía en el QR,
confía en lo que el dominio responde por HTTPS al verificarlo):

```json
{ "version": 1, "action": "PAIR" | "SECRET_REQUEST",
  "domain": "...", "request_id": "...", "nonce": "..." }
```

No lleva URL de verificación: la app construye `https://{domain}/verificar/{request_id}`
ella misma (`http://` solo se tolera contra loopback, para desarrollo).

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

## 6. Estructura

```
android/app/src/main/java/io/sello/app/
  signing/SigningModule.kt   único módulo nativo — Keystore completo
src/
  native/Signing.ts          puente tipado al módulo nativo
  services/
    peticion.ts              protocolo: leer QR, verificar, prueba de
                              posesión, abrir/cerrar sobres, §4–§16
    identidad.ts             alta/baja de la identidad de la app
    boveda.ts                secretos guardados, indexados por domain_id
    actividad.ts             historial local para la pantalla de Inicio
  screens/                   Bienvenida → Inicio → Escaner → Aprobacion
                              → Firmado; Boveda y Dispositivo aparte
server/
  servidor.mjs                el dominio de referencia (§4–§10, §14)
web/
  index.html, vendor-qrcode.js  demo mínima del lado navegador
tools/
  simular-app.mjs             simula el teléfono contra server/, sin
                               dispositivo — reproduce la misma
                               criptografía que el módulo Kotlin
```

## 7. Estado

`npx tsc --noEmit` limpio. `node tools/simular-app.mjs` (contra
`server/servidor.mjs` corriendo) pasa el emparejamiento, la devolución del
secreto y varios de los 25 casos del §24 que el servidor debe rechazar — ver
la lista completa en `diseno_app.md` para lo que falta cubrir con pruebas
automáticas (algunos, como el rechazo de un `request_id`/`domain` mal
formado en el QR, ya los valida `leerQr()` en `src/services/peticion.ts`,
pero solo del lado del cliente).

El Kotlin **no** está compilado aquí — hace falta el Android SDK. La primera
vez que corras `npm run android`, revisa ahí.

Pendiente consciente: fijar el certificado del dominio (pinning) para
`fetch()` en producción; hoy la app solo exige `https://` fuera de loopback.

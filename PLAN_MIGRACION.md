# Plan de migración a Arquitectura v2

> Aplica la visión de `ARQUITECTURA_V2.md` sobre el despliegue real que
> existe hoy en `https://fileserver.locker/localvault/` (documentado en
> `PROTOCOLO_REAL.md`). El servidor actual (`server/servidor.mjs`) se
> mantiene como **servidor intermedio** — deja de verificar identidad en
> vivo y pasa a hacer señalización WebRTC.
>
> **Regla del plan:** antes de arrancar cada fase, se hace un repaso
> juntos de qué se va a tocar, qué podría fallar y qué se dejó pendiente
> de la fase anterior. Ninguna fase empieza sin ese repaso.
>
> **Regla de no ruptura:** en cada fase, lo que ya funciona en
> `fileserver.locker/localvault/` sigue funcionando hasta que la fase
> siguiente explícitamente lo reemplaza. Nunca se deja el ambiente a
> medias entre una sesión de trabajo y la siguiente.

---

## Fase 0 — La credencial de dominio (manual)

**Objetivo:** que exista una credencial firmada para
`fileserver.locker/localvault`, publicada y verificable offline.

**Qué se genera:**
- Par de llaves de **autoridad** (Ed25519) — la privada vive fuera de
  `public_html`, en el servidor, fuera del repo; la pública se embebe
  más adelante en la app (Fase 1).
- Una credencial firmada:
  ```json
  {
    "domain": "fileserver.locker/localvault",
    "domain_id": "<el domain_id que ya expone servidor.mjs>",
    "domain_public_key": "<el mismo SPKI RSA que ya usa servidor.mjs>",
    "signaling_endpoint": "https://fileserver.locker/localvault/api",
    "issued_at": ...,
    "expires_at": ...,
    "issuer_signature": "..."
  }
  ```
- Se publica en `https://fileserver.locker/localvault/.well-known/sello-domain.json`
  (estático, fuera del alcance de `/api/`).

**Qué NO cambia:** nada del servidor ni de la app. Es generar y publicar
un archivo — se prueba de forma aislada, sin afectar el flujo actual.

**Entregable:** script `server/tools/emitir-credencial.mjs` que se corre
a mano cuando haga falta renovar.

**Riesgo:** ninguno — no toca nada en producción.

---

## Fase 1 — La app valida la credencial en vez de llamar a `/verificar`

**Objetivo:** que `verificar()` en `peticion.ts` deje de depender de una
llamada en vivo al servidor para confiar en el dominio.

**Cambios:**
- `src/services/peticion.ts`: nueva función `validarCredencial()` que
  verifica la firma de la autoridad y la vigencia, offline.
- La llave pública de la autoridad (Fase 0) se embebe como constante en
  la app.
- `POST /peticion` en `servidor.mjs` incluye la credencial (o su URL)
  en la respuesta del QR, junto a `request_id`+`nonce`.
- `GET /verificar/:id` se deja viva en paralelo — no se retira todavía.

**Entregable:** `tools/simular-app.mjs` actualizado para validar
credencial en vez de llamar a `/verificar`, como prueba de que el
cambio funciona antes de tocar la app real.

**Riesgo:** bajo — el camino viejo sigue disponible mientras se prueba
el nuevo.

---

## Fase 2 — Señalización WebRTC en el servidor actual

**Objetivo:** que `servidor.mjs` pueda iniciar y recibir el intercambio
SDP/ICE de una sesión WebRTC, sin tocar secretos.

**Cambios:**
- Elegir librería WebRTC para Node (candidatas: `node-datachannel`,
  `werift`) — decisión a tomar en el repaso previo a esta fase.
- `POST /peticion` genera también la sesión `RTCPeerConnection` del lado
  servidor y su SDP offer.
- Nueva ruta `POST /senal/:request_id` — la app entrega su SDP answer +
  candidatos ICE. Reemplaza, para este propósito, lo que hoy hace
  `POST /respuesta`.
- Consumo atómico de `request_id` se mantiene igual; cambia solo qué se
  guarda (SDP, no un sobre cifrado).
- `POST /peticion` ahora acepta un tercer valor de `purpose`, además de
  `PAIR` y `SECRET_REQUEST`: **`SECRET_VERIFY`** (sin cifrado — el
  dominio compara un hash contra el secreto que ya tiene) y
  **`SECRET_RECOVER`** (con sobre cifrado real — el dominio no tiene el
  valor y necesita recibirlo). Ver `ARQUITECTURA_V2.md` §3.5 para el
  detalle de cada uno; esta fase solo necesita que el servidor sepa
  distinguir cuál de los dos está pidiendo el sitio al generar el QR.
- Decidir STUN/TURN: STUN público para pruebas; TURN propio o de
  terceros pendiente para redes restrictivas en producción.

**Riesgo:** medio — dependencia nueva en Node; se agrega sin quitar las
rutas viejas, así que no rompe lo desplegado.

---

## Fase 3 — La Web abre el canal WebRTC

**Objetivo:** que `web/index.html` hable con la app por `DataChannel`
en vez de long-poll HTTP.

**Cambios:**
- Reemplaza `GET /respuesta/:id` (long-poll) por `RTCPeerConnection`
  nativo del navegador.
- Recibe el `sdp_offer` de `/peticion`, espera la `answer` vía un
  mecanismo corto de señalización, abre el `DataChannel`.
- Para `SECRET_VERIFY`: identidad + `secret_fingerprint` firmado viajan
  por el `DataChannel`, sin cifrado adicional — el navegador puede
  procesarlos directamente.
- Para `SECRET_RECOVER`: el navegador **reenvía** el sobre cifrado al
  backend del sitio (no lo abre él mismo — no tiene la clave privada de
  recuperación, ver `ARQUITECTURA_V2.md` §3.5).

**Riesgo:** medio — se prueba en paralelo; el long-poll viejo no se
apaga hasta confirmar que esto funciona.

---

## Fase 4 — La App abre el canal WebRTC

**Objetivo:** que la app Android establezca el lado app del canal
WebRTC y mueva ahí la entrega/devolución del secreto.

**Cambios:**
- Agregar `react-native-webrtc` (dependencia nativa — toca `android/`
  otra vez).
- `peticion.ts`: tras validar la credencial (Fase 1), generar
  `RTCPeerConnection`, procesar el offer, generar answer+ICE, mandarlo
  a `POST /senal/:id`.
- Mover `pruebaDePosesion()` para que opere sobre el `DataChannel` en
  vez de `fetch()` contra `/respuesta`.
- **Para `SECRET_VERIFY`:** nueva función que firma
  `{request_id, nonce, domain_id, app_id, secret_fingerprint}` — sin
  ningún paso de cifrado.
- **Para `SECRET_RECOVER`:** mantener `entregarSecreto()` como está
  hoy (firma + `cerrarSobre()`), decidiendo si `cerrarSobre()` sigue en
  RSA-OAEP o migra a HPKE (pregunta abierta #4 de `ARQUITECTURA_V2.md`
  — no bloquea esta fase, se puede empezar con RSA y migrar después).

**Riesgo:** alto — es el cambio de mayor esfuerzo; toca la parte nativa
de la app. Requiere el repaso más detallado de todo el plan antes de
empezar.

---

## Fase 4.5 — Diagnóstico multi-dispositivo (independiente, recomendable junto a la Fase 4)

**Objetivo:** que la app deje de asumir, para todos los equipos, la
política de Keystore inferida de un solo dispositivo de referencia
(Samsung SM-T545) — ver `ARQUITECTURA_V2.md` §7 para el detalle
completo.

Esta fase **no depende de WebRTC** — es una corrección al flujo ya
existente de `crearIdentidad()` (§10, la app descifrando lo que el
dominio entrega al emparejar). Se agrupa junto a la Fase 4 porque
ambas tocan la parte nativa de Android y conviene probarlas juntas en
dispositivos reales.

**Cambios:**
- Convertir `diagnosticarOaep()` y `autoconsistenciaCifrado()` de
  herramientas de debug manual a parte del flujo normal de
  `crearIdentidad()`: probar en el dispositivo real qué combinación de
  StrongBox/autenticación/MGF1 funciona, **antes** de generar la clave
  real.
- Ampliar lo que se guarda en preferencias tras crear identidad (hoy
  solo `strongBox: boolean`) para registrar también si la clave RSA
  quedó con o sin autenticación, y qué MGF1 se usó.
- Definir el comportamiento si ninguna combinación funciona en un
  equipo nuevo (degradar a la más permisiva conocida, o informar
  incompatibilidad en vez de fallar en medio de un emparejamiento).

**Entregable:** probar en al menos un representante de cada familia de
chip común — Google Pixel (Titan M), Samsung (ya se tiene), un
Qualcomm genérico, un MediaTek. Requiere hardware físico — los
emuladores no reproducen estos bugs.

**Riesgo:** medio — no rompe nada desplegado (es una mejora al flujo
de creación de identidad), pero requiere acceso a varios dispositivos
físicos para validarse en serio.

---

## Fase 5 — Retirar lo que ya no se usa

**Objetivo:** dejar el sistema limpio, sin caminos duplicados.

**Cambios:**
- Apagar `GET /verificar/:id` y el viejo `POST/GET /respuesta/:id`,
  solo después de confirmar que las Fases 1-4 funcionan de punta a
  punta en `fileserver.locker/localvault/`.
- Actualizar `server/README.md` y `PROTOCOLO_REAL.md` para reflejar el
  nuevo comportamiento (dejan de describir HTTP puro como transporte,
  y pasan a documentar los dos tipos de operación sobre el secreto).

**Riesgo:** bajo en sí mismo, pero es la única fase que **rompe
deliberadamente** el camino viejo — se hace al final, con todo lo
demás ya probado.

---

## Resumen

| Fase | Qué cambia | Riesgo | ¿Rompe lo desplegado hoy? |
|---|---|---|---|
| 0 | Generar credencial | Ninguno | No |
| 1 | App valida credencial offline | Bajo | No — `/verificar` sigue viva |
| 2 | Servidor: señalización WebRTC + tipos `SECRET_VERIFY`/`SECRET_RECOVER` | Medio | No — se agrega sin quitar nada |
| 3 | Web: canal WebRTC | Medio | No — hasta apagar el long-poll viejo |
| 4 | App: canal WebRTC | **Alto** | No — hasta el cutover final |
| 4.5 | Diagnóstico multi-dispositivo | Medio | No — mejora al flujo existente |
| 5 | Retirar rutas legacy | Bajo | Sí, deliberadamente — al final |

---

## Estado actual

- [ ] Fase 0 — Credencial de dominio
- [ ] Fase 1 — App valida credencial offline
- [ ] Fase 2 — Señalización WebRTC + tipos de secreto en el servidor
- [ ] Fase 3 — Web abre canal WebRTC
- [ ] Fase 4 — App abre canal WebRTC
- [ ] Fase 4.5 — Diagnóstico multi-dispositivo
- [ ] Fase 5 — Retirar rutas legacy

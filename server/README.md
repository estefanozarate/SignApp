# Dominio de referencia

Implementación mínima del lado "dominio" de `diseno_app.md`: crea peticiones,
las verifica por HTTPS, guarda la identidad del dominio y hace de buzón entre
el navegador y el teléfono. Sin dependencias: solo `node:*`.

## Levantarlo

```bash
cd server
npm start          # node servidor.mjs
```

No hace falta `npm install`. Escucha por defecto en `http://127.0.0.1:8787`.

Variables de entorno:

```
PORT      puerto (8787)
HOST      interfaz (127.0.0.1)
DOMINIO   el "domain" que se pone en cada petición (host:puerto por defecto)
CLAVE     ruta de la clave privada del dominio (server/datos/dominio.pem)
MGF1      sha1 (por defecto) o sha256 — el digest de MGF1 al envolver la
          clave AES para la app; ver la nota en servidor.mjs si un Keymaster
          concreto necesita sha256
```

La clave del dominio se genera en el primer arranque y se guarda en
`server/datos/dominio.pem` (0600); no se sube al repo. El `domain_id` se
deriva de ella, así que si cambia hay que volver a emparejar todas las apps.

## Que el teléfono llegue hasta aquí

El teléfono no puede usar `localhost`/`127.0.0.1` para hablar con tu
computadora. La salida limpia es reenviar el puerto por USB:

```bash
adb reverse tcp:8787 tcp:8787
```

Hay que repetirlo cada vez que reconectes el cable. En producción esto va
detrás de TLS: la app solo acepta `https://`, salvo loopback para desarrollo.

## Protocolo

```
POST /peticion              el sitio crea una petición de emparejamiento
                             o de recuperación de secreto (§4.1)
                             body: { purpose: "PAIR"|"SECRET_REQUEST", ttl?, action?, account? }
                             → { request_id, nonce, purpose, qr, expires_at }

GET  /verificar/:id         la app la verifica y el dominio la consume,
                             de forma atómica (§5)
                             → { status: "authorized", domain, domain_id,
                                 domain_public_key, request_id, nonce,
                                 purpose, action, account, issued_at, expires_at }

POST /respuesta/:id         la app entrega su respuesta (§9/§14)
                             body: { type: "APP_IDENTITY"|"SECRET_RESPONSE"|"DENIED", ... }
                             → en PAIR: { ok, secret } — el secreto cifrado para la app (§10)
                             → en SECRET_REQUEST: { ok, signature_valid, matches, secret_fingerprint }

GET  /respuesta/:id         el sitio recoge lo que dejó la app (§14)
                             espera larga: hasta 25 s abierta, 204 si vence
```

Un segundo `POST /respuesta/:id` sobre la misma petición devuelve 409: se
responde una vez. Una petición ya consumida en `/verificar` devuelve 409 si
se reintenta. Caducada, 410. Inexistente, 404.

## Por qué esto es HTTP y no WebRTC

`diseno_app.md` (§8, §17) pide WebRTC como transporte P2P. La primera versión
de este proyecto lo tenía: un relay de WebSocket que emparejaba oferta y
respuesta SDP entre navegador y teléfono.

Se quitó porque no aportaba lo que parecía. Lo que viaja en cada paso ya está
protegido por su propia criptografía, no por el canal:

- Al emparejar, la prueba de posesión (§7) y el secreto cifrado (§10) no
  dependen de que el canal sea P2P: la firma no se puede falsificar sin la
  clave privada de la app, y el secreto va cifrado para su clave pública.
- Al devolver el secreto (§14), lo que llega es una firma sobre un contexto
  de un solo uso (`request_id` + `nonce`) más un sobre cifrado para el
  dominio. Un atacante que controle este servidor no puede falsificar la
  firma ni descifrar sin la clave privada del dominio; como mucho puede
  negar el servicio, no suplantar a ninguna de las dos partes.

A cambio, WebRTC costaba NAT, STUN, TURN y fallos intermitentes según la red
de cada usuario, por una garantía de transporte que aquí ya daba la
criptografía de la aplicación. `/peticion`, `/verificar` y `/respuesta` son
HTTP corriente; el `GET /respuesta` usa espera larga en vez de sondeo en
bucle para no hacer polling activo.

## Herramientas

```bash
node tools/simular-app.mjs
```

Reproduce lo que hace el teléfono (misma criptografía: EC P-256 para firmar,
RSA-OAEP-SHA256/MGF1-SHA1 + AES-256-GCM para el sobre) contra este servidor,
sin necesidad de un dispositivo. Cubre el emparejamiento, la devolución del
secreto y varios de los casos que el §24 exige rechazar.

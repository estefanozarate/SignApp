# Buzón de respuestas

El teléfono deja aquí su respuesta y el navegador la recoge. Nada más.

## Levantarlo

```bash
cd server
npm start
```

Sin dependencias: solo `node:http`. No hace falta `npm install`.
Escucha en `http://127.0.0.1:8787`.

## Que el teléfono llegue hasta aquí

El teléfono no puede usar `localhost` para hablar con tu computadora, y la
app rechaza `http://` que no sea loopback. La salida limpia es reenviar el
puerto por USB:

```bash
adb reverse tcp:8787 tcp:8787
```

Hay que repetirlo cada vez que reconectes el cable.

## Protocolo

```
POST /respuesta?session_id=<32 hex>   el teléfono deja su respuesta
GET  /respuesta?session_id=<32 hex>   el navegador la recoge
```

El GET es una **espera larga**: la petición queda abierta hasta 25 s
esperando que llegue algo, y devuelve 204 si vence. El navegador reintenta
hasta que caduca el QR. Es HTTP corriente, sin sondeo en bucle.

Un segundo POST sobre la misma sesión devuelve 409: una petición se responde
una vez.

## Por qué esto no necesita ser cifrado ni P2P

Antes esto era un relay de WebRTC. Se quitó porque no aportaba lo que
parecía.

Lo que viaja de vuelta es una **firma**, y su valor está en la criptografía,
no en el canal. Este servidor no puede falsificarla: no tiene la clave, que
vive en el chip del teléfono. Tampoco puede reutilizarla, porque cubre un
reto que solo sirve para esa petición. Y no hay nada confidencial que
ocultar: lo otro que viaja es una clave pública.

Lo que sí gana un atacante que controle este servidor es **impedir** que la
respuesta llegue. Puede denegar el servicio, no suplantarte.

El P2P costaba NAT, STUN, TURN y fallos intermitentes según la red de cada
usuario, a cambio de una garantía que aquí no hacía falta.

## Por qué el session_id tiene que parecer aleatorio

Sin backend no hay token: quien conozca el `session_id` puede dejar una
respuesta. Por eso se exigen 32 caracteres hexadecimales —los 128 bits que
genera el navegador— y se rechaza cualquier otra cosa.

Aun así, colarse no permite suplantarte: haría falta una firma válida sobre
el reto, y eso solo lo produce el chip de tu teléfono.

## En producción

Detrás de TLS. La app solo acepta `https://` o `http://` en loopback, así
que en cuanto salga de tu máquina tendrá que ir cifrado — no porque el
contenido sea secreto, sino para que nadie pueda interponerse y bloquear o
alterar el tráfico.

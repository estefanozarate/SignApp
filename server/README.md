# Relay de signaling

Junta dos conexiones con el mismo `session_id` y reenvía lo que una manda a
la otra. Nada más: no entiende el contenido ni guarda nada.

Lo único que pasa por aquí es el handshake de WebRTC. **El reto y la firma
no lo tocan** — van por el DataChannel, cifrado extremo a extremo. Si apagas
este proceso justo después de que el canal abre, la aprobación se completa.

## Levantarlo

```bash
cd server
npm install
npm start
```

Escucha en `ws://127.0.0.1:8787`.

## Que el teléfono llegue hasta aquí

El teléfono no puede usar `localhost` para hablar con tu computadora, y la
app rechaza `ws://` que no sea loopback. La salida limpia es reenviar el
puerto por USB:

```bash
adb reverse tcp:8787 tcp:8787
```

Con eso, `127.0.0.1:8787` en el teléfono llega a tu Mac. No hace falta
exponer nada en la red ni relajar la comprobación de la app.

Hay que repetirlo cada vez que reconectes el cable.

## Por qué el session_id tiene que parecer aleatorio

Sin backend no hay token: quien conozca el `session_id` entra a esa sala.
Por eso el relay exige 32 caracteres hexadecimales —los 128 bits que genera
el navegador— y rechaza cualquier otra cosa. También cierra la sala a los
cinco minutos y admite exactamente dos participantes: el tercero se rechaza.

Aun así, colarse en una sala no permite suplantarte: para conseguir una
firma habría que hacerte poner el PIN ante una pantalla que dice claramente
qué estás aprobando.

## En producción

Detrás de TLS (`wss://`), y con TURN si los dos extremos pueden estar en
redes distintas.

#!/usr/bin/env node
/**
 * Servidor de peticiones de un dominio. Sin dependencias: solo node:http.
 *
 * Tres cosas:
 *   POST /peticion              el sitio crea una petición y recibe su URL
 *   GET  /verificar/:id         la app pregunta qué pide realmente el dominio
 *   POST /respuesta/:id         la app entrega su respuesta; el sitio la recoge
 *
 * La verificación por HTTPS es el ancla de confianza. El QR no va firmado a
 * propósito: si la app va a consultar /verificar de todos modos, una firma en
 * el QR solo adelanta el rechazo unos milisegundos y a cambio obliga a
 * gestionar, distribuir y rotar una clave de emisor. La autenticidad la da el
 * certificado TLS del dominio, que el sistema ya valida.
 *
 * Consecuencia asumida: la app necesita red para verificar. No pierde nada
 * práctico, porque igual necesita red para recibir el secreto.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';

const PUERTO = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const ESPERA_MS = 25000;
const MAX_CUERPO = 64 * 1024;
const LIMPIEZA_MS = 60000;

/**
 * request_id → petición.
 *
 * `consumida` no se borra al usarse: se marca. Borrarla haría que un reintento
 * pareciera "nunca existió" en vez de "ya se usó", y son cosas distintas —
 * la segunda es un aviso de replay que el sitio debería poder ver.
 */
const peticiones = new Map();

const idValido = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v);

function responder(res, codigo, cuerpo) {
  res.writeHead(codigo, {
    'Content-Type': 'application/json; charset=utf-8',
    // El sitio y este servidor pueden estar en orígenes distintos.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Cache-Control': 'no-store',
  });
  res.end(cuerpo ? JSON.stringify(cuerpo) : '');
}

function leerCuerpo(req) {
  return new Promise((ok, falla) => {
    let datos = '';
    req.on('data', (c) => {
      datos += c;
      if (datos.length > MAX_CUERPO) { req.destroy(); falla(new Error('cuerpo demasiado grande')); }
    });
    req.on('end', () => {
      try { ok(datos ? JSON.parse(datos) : {}); } catch { falla(new Error('json inválido')); }
    });
  });
}

const ahora = () => Math.floor(Date.now() / 1000);

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'x'}`);
  const partes = url.pathname.split('/').filter(Boolean);

  if (req.method === 'OPTIONS') return responder(res, 204);

  // ── el sitio crea una petición ───────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/peticion') {
    let cuerpo;
    try { cuerpo = await leerCuerpo(req); } catch (e) { return responder(res, 400, { error: e.message }); }

    const id = randomBytes(16).toString('hex');
    const ttl = Math.min(Number(cuerpo.ttl) || 120, 600);
    const peticion = {
      request_id: id,
      // El dominio lo fija el servidor, no el cliente: si lo pusiera quien
      // llama, cualquiera podría emitir peticiones a nombre de otro.
      domain: process.env.DOMINIO ?? `${HOST}:${PUERTO}`,
      action: String(cuerpo.action ?? 'Aprobar una acción').slice(0, 120),
      account: cuerpo.account ? String(cuerpo.account).slice(0, 120) : undefined,
      nonce: randomBytes(32).toString('base64'),
      issued_at: ahora(),
      expires_at: ahora() + ttl,
    };

    peticiones.set(id, { ...peticion, consumida: false, respuesta: null, esperando: [] });
    return responder(res, 201, {
      request_id: id,
      // Lo que va dentro del QR. La app saca el dominio de esta misma URL,
      // así que no puede haber discrepancia entre lo que dice y dónde pregunta.
      url: `${process.env.BASE ?? `http://${HOST}:${PUERTO}`}/verificar/${id}`,
      expires_at: peticion.expires_at,
    });
  }

  // ── la app verifica qué pide el dominio ─────────────────────────────
  if (req.method === 'GET' && partes[0] === 'verificar' && idValido(partes[1])) {
    const p = peticiones.get(partes[1]);
    if (!p) return responder(res, 404, { error: 'no existe' });
    if (p.expires_at < ahora()) return responder(res, 410, { error: 'caducada' });
    if (p.consumida) return responder(res, 409, { error: 'ya usada' });

    const { consumida, respuesta, esperando, ...publica } = p;
    return responder(res, 200, publica);
  }

  // ── la app responde ───────────────────────────────────────────
  if (req.method === 'POST' && partes[0] === 'respuesta' && idValido(partes[1])) {
    const p = peticiones.get(partes[1]);
    if (!p) return responder(res, 404, { error: 'no existe' });
    if (p.expires_at < ahora()) return responder(res, 410, { error: 'caducada' });
    if (p.consumida) return responder(res, 409, { error: 'ya usada' });

    let cuerpo;
    try { cuerpo = await leerCuerpo(req); } catch (e) { return responder(res, 400, { error: e.message }); }

    p.consumida = true;
    p.respuesta = cuerpo;
    log(partes[1], `respuesta ${cuerpo.type ?? '?'}`);
    for (const espera of p.esperando) responder(espera, 200, cuerpo);
    p.esperando = [];
    return responder(res, 200, { ok: true });
  }

  // ── el sitio recoge la respuesta ─────────────────────────────────
  if (req.method === 'GET' && partes[0] === 'respuesta' && idValido(partes[1])) {
    const p = peticiones.get(partes[1]);
    if (!p) return responder(res, 404, { error: 'no existe' });
    if (p.respuesta) return responder(res, 200, p.respuesta);
    if (p.expires_at < ahora()) return responder(res, 410, { error: 'caducada' });

    // Espera larga: la petición queda abierta hasta que llegue algo.
    p.esperando.push(res);
    const corte = setTimeout(() => {
      p.esperando = p.esperando.filter((r) => r !== res);
      responder(res, 204);
    }, ESPERA_MS);
    res.on('close', () => clearTimeout(corte));
    return;
  }

  responder(res, 404, { error: 'ruta desconocida' });
});

// Las peticiones caducadas se retiran con retraso, para que un reintento
// tardío reciba 410 (caducada) y no 404 (no existe): dice más.
setInterval(() => {
  const limite = ahora() - 300;
  for (const [id, p] of peticiones) if (p.expires_at < limite) peticiones.delete(id);
}, LIMPIEZA_MS).unref();

const log = (id, msg) => console.log(`[${id.slice(0, 8)}…] ${msg}`);

servidor.listen(PUERTO, HOST, () => {
  console.log(`Servidor de peticiones en http://${HOST}:${PUERTO}`);
  console.log('Para que el teléfono llegue hasta aquí:  adb reverse tcp:8787 tcp:8787');
});

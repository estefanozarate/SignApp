#!/usr/bin/env node
/**
 * Dominio participante del protocolo. Sin dependencias: solo node:*.
 *
 * Implementa §4 (creación de peticiones), §5 (verificación) y §6 (respuesta
 * con la identidad del dominio) de diseno_app.md.
 *
 *   POST /peticion              el sitio crea una petición (PAIR o SECRET_REQUEST)
 *   GET  /verificar/:id         la app verifica; el dominio consume la petición
 *   POST /respuesta/:id         la app entrega su respuesta
 *   GET  /respuesta/:id         el sitio la recoge
 *
 *   node servidor.mjs
 */
import { createServer } from 'node:http';
import { randomBytes, generateKeyPairSync, createHash } from 'node:crypto';

const PUERTO = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const ESPERA_MS = 25000;
const MAX_CUERPO = 64 * 1024;
const LIMPIEZA_MS = 60000;

/** §15: los propósitos válidos. Una petición de un tipo no sirve para el otro. */
const PROPOSITOS = new Set(['PAIR', 'SECRET_REQUEST']);

/**
 * §3.2 — Identidad del dominio.
 *
 * En un despliegue real esta clave se carga de disco y persiste entre
 * reinicios: si cambia, las apps que ya emparejaron dejan de reconocer al
 * dominio. Aquí se genera al arrancar porque es un servidor de desarrollo,
 * y eso implica que hay que volver a emparejar tras cada reinicio.
 *
 * RSA-2048 para poder descifrar lo que la app cifre para el dominio (§14),
 * simétrico a la clave que la app usa para recibir secretos.
 */
const { privateKey: domainPriv, publicKey: domainPub } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const domainSpki = domainPub.export({ type: 'spki', format: 'der' });
const DOMAIN_ID = createHash('sha256').update(domainSpki).digest('hex').slice(0, 32);
const DOMAIN = process.env.DOMINIO ?? `${HOST}:${PUERTO}`;

/** request_id → petición */
const peticiones = new Map();

const idValido = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v);
const ahora = () => Math.floor(Date.now() / 1000);

function responder(res, codigo, cuerpo) {
  res.writeHead(codigo, {
    'Content-Type': 'application/json; charset=utf-8',
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

const servidor = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'x'}`);
  const partes = url.pathname.split('/').filter(Boolean);

  if (req.method === 'OPTIONS') return responder(res, 204);

  // ── §4.1 el sitio crea la petición ────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/peticion') {
    let cuerpo;
    try { cuerpo = await leerCuerpo(req); } catch (e) { return responder(res, 400, { error: e.message }); }

    const purpose = String(cuerpo.purpose ?? 'PAIR');
    if (!PROPOSITOS.has(purpose)) return responder(res, 400, { error: 'purpose desconocido' });

    const id = randomBytes(16).toString('hex');
    const ttl = Math.min(Number(cuerpo.ttl) || 120, 600);
    const peticion = {
      version: 1,
      request_id: id,
      // §4.1: el dominio lo fija el servidor, nunca quien llama. Si lo pusiera
      // el cliente, cualquiera podría emitir peticiones a nombre de otro.
      domain: DOMAIN,
      nonce: randomBytes(32).toString('base64'),
      purpose,
      action: String(cuerpo.action ?? (purpose === 'PAIR' ? 'Vincular este dispositivo' : 'Recuperar tu acceso')).slice(0, 120),
      account: cuerpo.account ? String(cuerpo.account).slice(0, 120) : undefined,
      issued_at: ahora(),
      expires_at: ahora() + ttl,
    };

    peticiones.set(id, { ...peticion, consumida: false, respuesta: null, esperando: [] });
    log(id, `creada ${purpose}`);

    return responder(res, 201, {
      request_id: id,
      nonce: peticion.nonce,
      purpose,
      // §4.2 — el QR lleva versión, acción, dominio, request_id y nonce.
      // Va como URL para que la app saque el dominio de donde va a preguntar:
      // así no puede haber discrepancia entre lo que dice y a quién consulta.
      qr: `${process.env.BASE ?? `http://${HOST}:${PUERTO}`}/verificar/${id}`,
      expires_at: peticion.expires_at,
    });
  }

  // ── §5 la app verifica; §6 el dominio devuelve su identidad ───────────
  if (req.method === 'GET' && partes[0] === 'verificar' && idValido(partes[1])) {
    const p = peticiones.get(partes[1]);
    // §19: los errores no distinguen más de lo necesario para el usuario.
    if (!p) return responder(res, 404, { error: 'no existe' });
    if (p.expires_at < ahora()) return responder(res, 410, { error: 'caducada' });

    // §5: el consumo es atómico. Node es de un solo hilo aquí, así que marcar
    // antes de responder basta para que dos verificaciones simultáneas no
    // puedan tener éxito las dos.
    if (p.consumida) return responder(res, 409, { error: 'ya usada' });
    p.consumida = true;
    log(partes[1], 'verificada y consumida');

    return responder(res, 200, {
      status: 'authorized',
      version: 1,
      domain: p.domain,
      domain_id: DOMAIN_ID,
      domain_public_key: domainSpki.toString('base64'),
      request_id: p.request_id,
      nonce: p.nonce,
      purpose: p.purpose,
      action: p.action,
      account: p.account,
      issued_at: p.issued_at,
      expires_at: p.expires_at,
    });
  }

  // ── la app entrega su respuesta ───────────────────────────────────────
  if (req.method === 'POST' && partes[0] === 'respuesta' && idValido(partes[1])) {
    const p = peticiones.get(partes[1]);
    if (!p) return responder(res, 404, { error: 'no existe' });
    if (p.expires_at < ahora()) return responder(res, 410, { error: 'caducada' });
    if (p.respuesta) return responder(res, 409, { error: 'ya respondida' });

    let cuerpo;
    try { cuerpo = await leerCuerpo(req); } catch (e) { return responder(res, 400, { error: e.message }); }

    // §15: la respuesta tiene que traer el contexto de ESTA petición. Una de
    // otra sesión no vale aunque venga firmada.
    if (cuerpo.request_id !== p.request_id || cuerpo.nonce !== p.nonce) {
      log(partes[1], 'respuesta con contexto que no cuadra: rechazada');
      return responder(res, 400, { error: 'contexto incorrecto' });
    }

    p.respuesta = cuerpo;
    log(partes[1], `respuesta ${cuerpo.type ?? '?'}`);
    for (const espera of p.esperando) responder(espera, 200, cuerpo);
    p.esperando = [];
    return responder(res, 200, { ok: true });
  }

  // ── el sitio recoge la respuesta ──────────────────────────────────────
  if (req.method === 'GET' && partes[0] === 'respuesta' && idValido(partes[1])) {
    const p = peticiones.get(partes[1]);
    if (!p) return responder(res, 404, { error: 'no existe' });
    if (p.respuesta) return responder(res, 200, p.respuesta);
    if (p.expires_at < ahora()) return responder(res, 410, { error: 'caducada' });

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

// Las caducadas se retiran con retraso: un reintento tardío debe recibir 410
// (caducada) y no 404 (no existe), que dice menos.
setInterval(() => {
  const limite = ahora() - 300;
  for (const [id, p] of peticiones) if (p.expires_at < limite) peticiones.delete(id);
}, LIMPIEZA_MS).unref();

const log = (id, msg) => console.log(`[${id.slice(0, 8)}…] ${msg}`);

servidor.listen(PUERTO, HOST, () => {
  console.log(`Dominio ${DOMAIN} escuchando en http://${HOST}:${PUERTO}`);
  console.log(`domain_id ${DOMAIN_ID}`);
  console.log('AVISO: la clave del dominio se genera al arrancar. Al reiniciar');
  console.log('       habrá que volver a emparejar, porque cambia su identidad.');
  console.log('Para que el teléfono llegue hasta aquí:  adb reverse tcp:8787 tcp:8787');
});

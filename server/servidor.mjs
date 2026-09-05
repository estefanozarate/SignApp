#!/usr/bin/env node
/**
 * Dominio participante del protocolo. Sin dependencias: solo node:*.
 *
 * Implementa §4 (peticiones), §5 (verificación), §6 (identidad del dominio)
 * y §9 (registro de la app con prueba de posesión) de diseno_app.md.
 *
 *   POST /peticion              el sitio crea una petición
 *   GET  /verificar/:id         la app verifica; el dominio consume la petición
 *   POST /respuesta/:id         la app entrega su respuesta
 *   GET  /respuesta/:id         el sitio la recoge
 *
 *   node servidor.mjs
 */
import { createServer } from 'node:http';
import {
  randomBytes, generateKeyPairSync, createHash,
  createPrivateKey, createPublicKey, createVerify,
} from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUERTO = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const ESPERA_MS = 25000;
const MAX_CUERPO = 64 * 1024;
const LIMPIEZA_MS = 60000;

/** §15: los propósitos válidos. Una petición de un tipo no sirve para el otro. */
const PROPOSITOS = new Set(['PAIR', 'SECRET_REQUEST']);

// ── §3.2 identidad del dominio, persistida ────────────────────────────────

/**
 * El domain_id se deriva de esta clave. Si cambiara entre reinicios, las apps
 * ya emparejadas dejarían de reconocer al dominio y habría que emparejarlas
 * todas otra vez. Por eso vive en disco y no en memoria.
 */
const DIR = dirname(fileURLToPath(import.meta.url));
const RUTA_CLAVE = process.env.CLAVE ?? join(DIR, 'datos', 'dominio.pem');

function cargarClaveDominio() {
  if (existsSync(RUTA_CLAVE)) {
    return { clave: createPrivateKey(readFileSync(RUTA_CLAVE, 'utf8')), nueva: false };
  }
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  mkdirSync(dirname(RUTA_CLAVE), { recursive: true });
  // 0600: la privada del dominio no la lee nadie más que este proceso.
  writeFileSync(RUTA_CLAVE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { clave: privateKey, nueva: true };
}

const { clave: domainPriv, nueva: claveNueva } = cargarClaveDominio();
const domainSpki = createPublicKey(domainPriv).export({ type: 'spki', format: 'der' });
const DOMAIN_ID = createHash('sha256').update(domainSpki).digest('hex').slice(0, 32);
const DOMAIN = process.env.DOMINIO ?? `${HOST}:${PUERTO}`;

/** request_id → petición */
const peticiones = new Map();

/**
 * app_id → identidad registrada (§9).
 *
 * En producción esto va a una base de datos. Aquí en memoria, así que al
 * reiniciar hay que volver a emparejar aunque la clave del dominio persista.
 */
const apps = new Map();

const idValido = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v);
const ahora = () => Math.floor(Date.now() / 1000);

// ── §7 y §9 verificación de la prueba de posesión ─────────────────────────

/**
 * La app firma los bytes UTF-8 de estos campos unidos por 0x1f. Reconstruimos
 * exactamente la misma cadena: si difiriera en un solo byte, la firma no
 * verificaría y el fallo sería incomprensible.
 *
 * Que la prueba cubra domain, request_id y nonce es lo que la ata a ESTE
 * emparejamiento: una prueba capturada de otro no sirve aquí.
 */
function bytesDeLaPrueba(p, contexto) {
  return Buffer.from(
    ['sello/prueba/v1', contexto, p.domain, p.request_id, p.nonce].join('\u001f'),
    'utf8',
  );
}

/**
 * Sin esto, el dominio aceptaría cualquier clave pública que alguien le
 * presentase, incluida la de otra persona. La prueba demuestra que quien
 * envía la clave controla la privada correspondiente.
 */
function pruebaValida(peticion, spkiB64, firmaDerB64, contexto) {
  try {
    const clave = createPublicKey({
      key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki',
    });
    return createVerify('SHA256')
      .update(bytesDeLaPrueba(peticion, contexto))
      .verify(clave, Buffer.from(firmaDerB64, 'base64'));
  } catch {
    return false;
  }
}

// ── utilidades HTTP ───────────────────────────────────────────────────────

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

  // ── §4.1 el sitio crea la petición ──────────────────────────────────────
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
      // §4.2 — el QR lleva exactamente estos campos. No lleva la URL de
      // verificación: el §5 dice que la app no debe fiarse de una URL que le
      // suministre el QR, así que la construye ella a partir del dominio.
      qr: JSON.stringify({
        version: 1,
        action: purpose,
        domain: peticion.domain,
        request_id: id,
        nonce: peticion.nonce,
      }),
      expires_at: peticion.expires_at,
    });
  }

  // ── §5 la app verifica; §6 el dominio devuelve su identidad ─────────────
  if (req.method === 'GET' && partes[0] === 'verificar' && idValido(partes[1])) {
    const p = peticiones.get(partes[1]);
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

  // ── §9 la app entrega su identidad; el dominio la verifica ──────────────
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
      log(partes[1], 'contexto que no cuadra: rechazada');
      return responder(res, 400, { error: 'contexto incorrecto' });
    }

    if (cuerpo.type === 'APP_IDENTITY') {
      if (!cuerpo.app_id || !cuerpo.app_public_key || !cuerpo.proof_of_possession) {
        return responder(res, 400, { error: 'faltan datos de identidad' });
      }
      // §9 — el paso que hace que registrar una clave signifique algo.
      if (!pruebaValida(p, cuerpo.app_public_key, cuerpo.proof_of_possession, p.purpose)) {
        log(partes[1], 'PRUEBA DE POSESIÓN INVÁLIDA: rechazada');
        return responder(res, 403, { error: 'prueba de posesión inválida' });
      }

      // §13: re-emparejar sustituye la identidad anterior de ese app_id.
      apps.set(cuerpo.app_id, {
        app_id: cuerpo.app_id,
        app_public_key: cuerpo.app_public_key,
        app_encryption_key: cuerpo.app_encryption_key,
        registrada_en: ahora(),
      });
      log(partes[1], `identidad verificada y registrada: ${cuerpo.app_id.slice(0, 8)}…`);
    }

    p.respuesta = { ...cuerpo, verified: cuerpo.type === 'APP_IDENTITY' };
    for (const espera of p.esperando) responder(espera, 200, p.respuesta);
    p.esperando = [];
    return responder(res, 200, { ok: true });
  }

  // ── el sitio recoge la respuesta ────────────────────────────────────────
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
  console.log(claveNueva
    ? `Clave del dominio creada en ${RUTA_CLAVE}`
    : `Clave del dominio cargada de ${RUTA_CLAVE}`);
  console.log('Para que el teléfono llegue hasta aquí:  adb reverse tcp:8787 tcp:8787');
});

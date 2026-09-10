#!/usr/bin/env node
/**
 * Dominio participante del protocolo. Sin dependencias: solo node:*.
 *
 * Implementa §4 (peticiones), §5 (verificación), §6 (identidad del dominio),
 * §9 (registro con prueba de posesión), §10 (entrega del secreto al
 * emparejar) y §14 (descifrado y verificación de la firma cuando la app lo
 * devuelve) de diseno_app.md.
 *
 * El sentido importa y antes estaba invertido: el §10 dice que el secreto lo
 * ENTREGA el dominio al emparejar, y el §12/§14 que después es la APP quien
 * lo devuelve firmado y cifrado. El dominio ya no manda el secreto en un
 * SECRET_REQUEST; lo recibe y lo comprueba.
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
  publicEncrypt, privateDecrypt, createCipheriv, createDecipheriv,
  timingSafeEqual, constants,
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

/**
 * Qué digest usa MGF1 al envolver la clave AES para la app.
 *
 * Debería ser un detalle cerrado, y no lo es. El framework de Android solo
 * acepta MGF1ParameterSpec.SHA1 en el spec del Cipher — rechaza SHA-256 con
 * "Unsupported MGF1 digest". Pero varios keymaster ignoran ese parámetro y
 * aplican MGF1 con el MISMO digest que OAEP, o sea SHA-256. En esos equipos
 * el emisor tiene que envolver con SHA-256 aunque la app pida SHA-1; si no,
 * el chip falla al deshacer el padding con un "Unknown error" que no dice
 * nada, porque el keymaster no tiene código para "el padding no cuadra".
 *
 * Por eso es conmutable: es la única forma de averiguar qué hace un TEE
 * concreto sin recompilar la app.
 *
 *   MGF1=sha256 npm start
 */
const MGF1_APP = process.env.MGF1 === 'sha256' ? 'sha256' : 'sha1';

// ── §3.2 identidad del dominio, persistida ──────────────────────────

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

/**
 * app_id → secreto que el dominio le entregó (§10).
 *
 * Se crea al emparejar y se entrega ahí mismo, cifrado para la app. El
 * dominio conserva su copia por un motivo concreto: es contra ella que
 * comprueba, en el §14, que lo que la app devuelve es lo que él dio.
 *
 * En un producto real esto vive en la base de datos del dominio. Aquí, en
 * memoria: al reiniciar el proceso hay que volver a emparejar, aunque la
 * clave del dominio persista.
 */
const secretos = new Map();

const idValido = (v) => typeof v === 'string' && /^[0-9a-f]{32}$/i.test(v);
const ahora = () => Math.floor(Date.now() / 1000);

// ── §7 y §9 verificación de la prueba de posesión ─────────────────────

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

// ── §10 cifrado del secreto para la app ─────────────────────────────

/**
 * Cifrado híbrido: AES-256-GCM para el dato, y la clave AES envuelta con la
 * clave pública RSA de la app.
 *
 * No se cifra el dato directamente con RSA porque RSA-2048 solo admite unos
 * 190 bytes; y aunque cupiera, sería mucho más lento. GCM además autentica:
 * si alguien altera el texto cifrado por el camino, el descifrado falla en
 * vez de devolver basura silenciosamente.
 *
 * El hash de OAEP es SHA-256 y no se discute. El de MGF1 depende del equipo:
 * ver MGF1_APP arriba. Los dos lados tienen que coincidir o el descifrado
 * falla sin decir por qué.
 */
function cifrarParaLaApp(secreto, spkiB64) {
  const claveApp = createPublicKey({
    key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki',
  });

  const claveAes = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', claveAes, iv);
  const ct = Buffer.concat([c.update(Buffer.from(secreto, 'utf8')), c.final()]);

  return {
    // El nombre dice la combinación exacta, para que un cliente futuro
    // no tenga que adivinar los parámetros.
    alg: `RSA-OAEP-256-MGF1${MGF1_APP.toUpperCase()}+A256GCM`,
    encrypted_key: publicEncrypt(
      {
        key: claveApp,
        padding: constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
        mgf1Hash: MGF1_APP,
      },
      claveAes,
    ).toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ct.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
  };
}

// ── §14 la app devuelve el secreto: abrir y verificar ───────────────────

/**
 * Abre el sobre que la app cifró para este dominio. El inverso exacto de
 * cerrarSobre() en Kotlin, con los mismos parámetros OAEP: SHA-256 para el
 * hash y SHA-1 para MGF1. Si no coincidieran, esto fallaría con un error de
 * padding que no dice nada de la causa.
 *
 * Aquí MGF1 sí es SHA-1 fijo, y no sigue a MGF1_APP: este sobre lo cierra
 * Conscrypt con una clave pública normal, no el Keystore, y ese proveedor sí
 * respeta el parámetro que se le pasa.
 *
 * Lanza si algo no cuadra — y que lance es la respuesta correcta: GCM
 * autentica, así que un fallo aquí significa que el dato llegó alterado o que
 * no iba dirigido a este dominio. En ningún caso hay algo que aprovechar.
 */
function abrirDeLaApp(sobre) {
  const claveAes = privateDecrypt(
    {
      key: domainPriv,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
      mgf1Hash: 'sha1',
    },
    Buffer.from(sobre.encrypted_key, 'base64'),
  );

  try {
    const d = createDecipheriv('aes-256-gcm', claveAes, Buffer.from(sobre.iv, 'base64'));
    d.setAuthTag(Buffer.from(sobre.tag, 'base64'));
    const claro = Buffer.concat([
      d.update(Buffer.from(sobre.ciphertext, 'base64')),
      d.final(),
    ]);
    return JSON.parse(claro.toString('utf8'));
  } finally {
    claveAes.fill(0);
  }
}

/**
 * §14 — los bytes que la app firmó. Se reconstruyen campo a campo, en el
 * mismo orden y con el mismo separador que usa canonicoDeLaRespuesta() en la
 * app: no se firma el JSON, porque dos serializaciones del mismo objeto
 * pueden diferir en el orden de las claves y entonces la firma no verifica
 * por un motivo que no tiene nada que ver con la seguridad.
 */
function bytesDeLaRespuesta(r, domain) {
  return Buffer.from(
    ['sello/secreto/v1', domain, r.request_id, r.nonce, r.domain_id, r.app_id, r.secret]
      .join('\u001f'),
    'utf8',
  );
}

function firmaValida(bytes, spkiB64, firmaDerB64) {
  try {
    const clave = createPublicKey({
      key: Buffer.from(spkiB64, 'base64'), format: 'der', type: 'spki',
    });
    return createVerify('SHA256').update(bytes).verify(clave, Buffer.from(firmaDerB64, 'base64'));
  } catch {
    return false;
  }
}

/** Comparación en tiempo constante: comparar secretos con === filtra información. */
function iguales(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Huella corta del secreto, para que el navegador pueda enseñar algo sin ver
 * el secreto. El §14 lo entrega al dominio, no a la página: una página
 * estática no tiene dónde custodiarlo.
 */
const huella = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);

// ── utilidades HTTP ───────────────────────────────────────────

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

  // ── §4.1 el sitio crea la petición ───────────────────────────────
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

  // ── §9 la app entrega su identidad; §14 devuelve el secreto ─────────────
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

    // §19 "wrong operation/purpose": cada propósito admite un tipo de
    // respuesta y solo uno. Un DENIED se acepta siempre — es la app diciendo
    // que el usuario no quiso.
    const ESPERADO = { PAIR: 'APP_IDENTITY', SECRET_REQUEST: 'SECRET_RESPONSE' };
    if (cuerpo.type !== 'DENIED' && cuerpo.type !== ESPERADO[p.purpose]) {
      log(partes[1], `tipo ${cuerpo.type} no corresponde a ${p.purpose}: rechazada`);
      return responder(res, 400, { error: 'tipo de respuesta incorrecto' });
    }

    let acuse = { ok: true };

    // ── §9 y §10 emparejamiento ─────────────────────────────────
    if (cuerpo.type === 'APP_IDENTITY') {
      if (!cuerpo.app_id || !cuerpo.app_public_key || !cuerpo.proof_of_possession) {
        return responder(res, 400, { error: 'faltan datos de identidad' });
      }
      // §9 — el paso que hace que registrar una clave signifique algo.
      if (!pruebaValida(p, cuerpo.app_public_key, cuerpo.proof_of_possession, p.purpose)) {
        log(partes[1], 'PRUEBA DE POSESION INVALIDA: rechazada');
        return responder(res, 403, { error: 'prueba de posesión inválida' });
      }
      // §10 — sin clave de cifrado no hay forma de entregarle el secreto, y
      // el emparejamiento sin secreto dejaría la fase siguiente sin objeto.
      if (!cuerpo.app_encryption_key) {
        return responder(res, 400, { error: 'la app no envió clave de cifrado' });
      }

      // §13: re-emparejar sustituye la identidad anterior de ese app_id.
      apps.set(cuerpo.app_id, {
        app_id: cuerpo.app_id,
        app_public_key: cuerpo.app_public_key,
        app_encryption_key: cuerpo.app_encryption_key,
        registrada_en: ahora(),
      });
      log(partes[1], `identidad verificada y registrada: ${cuerpo.app_id.slice(0, 8)}…`);

      // §10 — el secreto se crea y se ENTREGA aquí, al emparejar. Volver a
      // emparejar genera uno nuevo: la app se queda con el último, y así los
      // dos lados siguen teniendo el mismo dato.
      const secreto = `sello-demo-${randomBytes(24).toString('base64url')}`;
      secretos.set(cuerpo.app_id, secreto);

      try {
        acuse = { ok: true, secret: cifrarParaLaApp(secreto, cuerpo.app_encryption_key) };
      } catch (e) {
        log(partes[1], `no se pudo cifrar: ${e.message}`);
        return responder(res, 400, { error: 'clave de cifrado no válida' });
      }
      log(partes[1], `secreto entregado cifrado con MGF1-${MGF1_APP} (${huella(secreto)}…)`);

      p.resultadoParaElSitio = {
        type: 'APP_IDENTITY',
        verified: true,
        app_id: cuerpo.app_id,
        secret_delivered: true,
        secret_fingerprint: huella(secreto),
      };
    }

    // ── §14 la app devuelve el secreto ─────────────────────────────
    if (cuerpo.type === 'SECRET_RESPONSE') {
      const sobre = cuerpo.envelope;
      if (!sobre?.encrypted_key || !sobre.iv || !sobre.ciphertext || !sobre.tag) {
        return responder(res, 400, { error: 'sobre incompleto' });
      }

      let claro;
      try {
        claro = abrirDeLaApp(sobre);
      } catch (e) {
        // §19 "decryption failure" / "authentication tag failure". No se
        // distingue cuál de los dos en la respuesta: al que lo intenta no le
        // conviene saber en qué paso falló.
        log(partes[1], `no se pudo abrir el sobre: ${e.message}`);
        return responder(res, 400, { error: 'no se pudo abrir la respuesta' });
      }

      // El contexto va DENTRO del sobre, no solo fuera. Lo de fuera lo puede
      // escribir cualquiera; esto está cubierto por la firma.
      if (claro.request_id !== p.request_id || claro.nonce !== p.nonce) {
        log(partes[1], 'el contexto firmado no cuadra: rechazada');
        return responder(res, 400, { error: 'contexto incorrecto' });
      }
      // §16 — la respuesta iba dirigida a ESTE dominio, no a otro.
      if (claro.domain_id !== DOMAIN_ID) {
        log(partes[1], 'la respuesta iba dirigida a otro dominio: rechazada');
        return responder(res, 400, { error: 'dominio incorrecto' });
      }

      // §19 "unknown App identity": solo se acepta de una app emparejada, y
      // se verifica con la clave que se registró entonces — no con una que
      // venga en este mensaje.
      const app = apps.get(claro.app_id);
      if (!app) {
        log(partes[1], `app desconocida: ${String(claro.app_id).slice(0, 8)}…`);
        return responder(res, 403, { error: 'identidad desconocida' });
      }

      if (!claro.signature ||
          !firmaValida(bytesDeLaRespuesta(claro, p.domain), app.app_public_key, claro.signature)) {
        log(partes[1], 'FIRMA DE LA RESPUESTA INVALIDA: rechazada');
        return responder(res, 403, { error: 'firma inválida' });
      }

      // Que el secreto sea el que este dominio entregó es una comprobación
      // de la aplicación, no del protocolo: la firma ya demuestra quién
      // responde. Sirve para ver que el viaje de ida y vuelta fue íntegro.
      const esperado = secretos.get(claro.app_id);
      const coincide = esperado !== undefined && iguales(esperado, claro.secret);
      log(partes[1], coincide
        ? `secreto recuperado y verificado (${huella(claro.secret)}…)`
        : 'firma válida pero el secreto NO coincide con el entregado');

      acuse = {
        ok: true,
        signature_valid: true,
        matches: coincide,
        secret_fingerprint: huella(claro.secret),
      };

      // El secreto en claro no se le devuelve al navegador: el §14 lo entrega
      // al dominio, y el dominio es este proceso. La página ve la huella.
      p.resultadoParaElSitio = {
        type: 'SECRET_RESPONSE',
        verified: true,
        app_id: claro.app_id,
        signature_valid: true,
        matches: coincide,
        secret_fingerprint: huella(claro.secret),
      };
    }

    // Lo que recoge el sitio va aparte de lo que responde la app: el sobre
    // cifrado no tiene por qué llegar al navegador.
    p.respuesta = p.resultadoParaElSitio ?? { type: cuerpo.type, verified: false, reason: cuerpo.reason };
    for (const espera of p.esperando) responder(espera, 200, p.respuesta);
    p.esperando = [];

    return responder(res, 200, acuse);
  }

  // ── el sitio recoge la respuesta ─────────────────────────────────
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
  console.log(`MGF1 al cifrar para la app: ${MGF1_APP}  (cambia con MGF1=sha256 npm start)`);
  console.log('Para que el teléfono llegue hasta aquí:  adb reverse tcp:8787 tcp:8787');
});

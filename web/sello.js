/**
 * Sello — lado navegador. Sin dependencias, sin build, sin servidor.
 *
 * El navegador tiene su propio par de claves (guardado en IndexedDB como
 * CryptoKey no exportable) y firma los QR con él. El teléfono, tras
 * vincularse, solo acepta QR firmados por navegadores que conoce.
 *
 * Nada secreto viaja: en la vinculación se intercambian claves PÚBLICAS, y
 * en la aprobación vuelve una firma. La privada del navegador no sale de
 * IndexedDB y la del teléfono no sale del chip.
 */

// ── CBOR mínimo ────────────────────────────────────────────────
const cab = (mayor, n) => {
  if (n < 24) return new Uint8Array([(mayor << 5) | n]);
  if (n < 256) return new Uint8Array([(mayor << 5) | 24, n]);
  if (n < 65536) return new Uint8Array([(mayor << 5) | 25, n >> 8, n & 255]);
  const b = new Uint8Array(5);
  b[0] = (mayor << 5) | 26;
  new DataView(b.buffer).setUint32(1, n);
  return b;
};
const unir = (...xs) => {
  const total = xs.reduce((n, x) => n + x.length, 0);
  const out = new Uint8Array(total);
  let i = 0;
  for (const x of xs) { out.set(x, i); i += x.length; }
  return out;
};
const cEnt = (n) => (n >= 0 ? cab(0, n) : cab(1, -n - 1));
const cBytes = (b) => unir(cab(2, b.length), b);
const cTexto = (s) => { const b = new TextEncoder().encode(s); return unir(cab(3, b.length), b); };
const cArr = (xs) => unir(cab(4, xs.length), ...xs);
const cMapa = (ps) => unir(cab(5, ps.length), ...ps.flat());

// ── Base45 (RFC 9285) ────────────────────────────────────────
const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
function base45(buf) {
  let s = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const n = buf[i] * 256 + buf[i + 1];
    s += B45[n % 45] + B45[Math.floor(n / 45) % 45] + B45[Math.floor(n / 2025)];
  }
  if (buf.length % 2) {
    const n = buf[buf.length - 1];
    s += B45[n % 45] + B45[Math.floor(n / 45)];
  }
  return s;
}

// ── zlib: el teléfono acepta CBOR sin comprimir si no hay CompressionStream ─
async function comprimir(bytes) {
  if (typeof CompressionStream === 'undefined') return bytes;
  const cs = new CompressionStream('deflate');
  const w = cs.writable.getWriter();
  w.write(bytes); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

const b64 = (b) => btoa(String.fromCharCode(...b));
const deB64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = (b) => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const hexABytes = (h) => h.match(/.{2}/g).map(x => parseInt(x, 16));

// ── identidad del navegador ────────────────────────────────────
const DB = 'sello', TIENDA = 'claves';

function abrirDb() {
  return new Promise((ok, err) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(TIENDA);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => err(r.error);
  });
}
async function guardar(clave, valor) {
  const db = await abrirDb();
  return new Promise((ok, err) => {
    const tx = db.transaction(TIENDA, 'readwrite');
    tx.objectStore(TIENDA).put(valor, clave);
    tx.oncomplete = () => ok();
    tx.onerror = () => err(tx.error);
  });
}
async function leer(clave) {
  const db = await abrirDb();
  return new Promise((ok, err) => {
    const tx = db.transaction(TIENDA, 'readonly');
    const q = tx.objectStore(TIENDA).get(clave);
    q.onsuccess = () => ok(q.result);
    q.onerror = () => err(q.error);
  });
}

/** El par del navegador se genera una vez y NO es exportable. */
export async function identidadNavegador() {
  let par = await leer('par');
  if (!par) {
    par = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'],
    );
    await guardar('par', par);
  }
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', par.publicKey));
  const huella = new Uint8Array(await crypto.subtle.digest('SHA-256', spki));
  return { par, spki, kid: hex(huella.slice(0, 8)) };
}

// ── emisión de QR ────────────────────────────────────────────
async function emitir(claims, ident) {
  const payload = cMapa(claims);
  const protegido = cMapa([
    [cEnt(1), cEnt(-7)],
    [cEnt(4), cBytes(new Uint8Array(hexABytes(ident.kid)))],
  ]);
  const aFirmar = cArr([cTexto('Signature1'), cBytes(protegido), cBytes(new Uint8Array(0)), cBytes(payload)]);
  // WebCrypto devuelve r||s crudos, que es justo lo que COSE espera.
  const firma = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, ident.par.privateKey, aFirmar,
  ));
  const sign1 = unir(cab(6, 18), cArr([cBytes(protegido), cMapa([]), cBytes(payload), cBytes(firma)]));
  return 'SL1:' + base45(await comprimir(sign1));
}

const ahora = () => Math.floor(Date.now() / 1000);
const sid = () => hex(crypto.getRandomValues(new Uint8Array(16)));

/** QR de vinculación: lleva dentro la clave pública del navegador. */
export async function qrVinculacion({ origen, signaling, ttl = 300 }) {
  const ident = await identidadNavegador();
  const sesion = sid();
  const payload = await emitir([
    [cTexto('typ'), cTexto('pair')],
    [cTexto('org'), cTexto(origen)],
    [cTexto('sid'), cTexto(sesion)],
    [cTexto('iat'), cEnt(ahora())],
    [cTexto('exp'), cEnt(ahora() + ttl)],
    [cTexto('sgu'), cTexto(signaling)],
    [cTexto('bpk'), cBytes(ident.spki)],
    [cTexto('act'), cTexto(navigator.userAgent.slice(0, 40))],
  ], ident);
  return { payload, sessionId: sesion, kid: ident.kid };
}

/** QR de aprobación: el teléfono lo verifica contra la clave ya vinculada. */
export async function qrAprobacion({ origen, signaling, accion, cuenta, ttl = 120 }) {
  const ident = await identidadNavegador();
  const sesion = sid();
  const reto = crypto.getRandomValues(new Uint8Array(32));
  const claims = [
    [cTexto('typ'), cTexto('aprb')],
    [cTexto('org'), cTexto(origen)],
    [cTexto('sid'), cTexto(sesion)],
    [cTexto('iat'), cEnt(ahora())],
    [cTexto('exp'), cEnt(ahora() + ttl)],
    [cTexto('sgu'), cTexto(signaling)],
    [cTexto('act'), cTexto(accion)],
    ...(cuenta ? [[cTexto('acc'), cTexto(cuenta)]] : []),
    [cTexto('chl'), cBytes(reto)],
  ];
  const payload = await emitir(claims, ident);
  // El teléfono firma: "sello/aprobacion/v1" + los bytes del payload.
  // Para verificar hay que reconstruir exactamente eso.
  const bytesPayload = cMapa(claims);
  const aVerificar = unir(new TextEncoder().encode('sello/aprobacion/v1'), bytesPayload);
  return { payload, sessionId: sesion, aVerificar };
}

// ── verificación de la respuesta del teléfono ────────────────────────

/**
 * Comprueba que la firma la produjo el teléfono vinculado y que cubre
 * exactamente el reto que emitimos. Sin esto, un "aprobado: true" sería un
 * mensaje que cualquiera podría mandar.
 */
export async function verificarFirma({ firmaDerB64, spkiB64, aVerificar }) {
  const clave = await crypto.subtle.importKey(
    'spki', deB64(spkiB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'],
  );
  // El Keystore de Android firma en DER; WebCrypto espera r||s crudos.
  const crudo = derACrudo(deB64(firmaDerB64));
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, clave, crudo, aVerificar);
}

function derACrudo(der) {
  let i = 2;
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const leer = () => {
    if (der[i++] !== 0x02) throw new Error('DER inesperado');
    const len = der[i++];
    let v = der.slice(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  return unir(leer(), leer());
}

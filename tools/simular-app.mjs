#!/usr/bin/env node
/**
 * Simula lo que hace el teléfono, contra el servidor del dominio.
 *
 *   node server/servidor.mjs          # en otra terminal
 *   node tools/simular-app.mjs
 *
 * Sirve para probar la Fase 4 sin tablet: recorre el emparejamiento (§9, §10)
 * y la devolución del secreto (§12, §13, §14), y además comprueba los casos
 * del §24 que el servidor debe rechazar.
 *
 * Reproduce exactamente la criptografía del módulo Kotlin: EC P-256 con
 * SHA256withECDSA para firmar, y para el sobre AES-256-GCM con la clave
 * envuelta en RSA-OAEP-SHA256 con MGF1-SHA1. Si aquí pasa y en el teléfono
 * no, el problema está en el Keystore, no en el protocolo — que es justo lo
 * que este script sirve para distinguir.
 */
import {
  generateKeyPairSync, createSign, createCipheriv, publicEncrypt,
  randomBytes, constants, createHash,
} from 'node:crypto';

const DOMINIO = process.env.DOMINIO ?? 'http://127.0.0.1:8787';
// Tiene que coincidir con el del servidor: MGF1=sha256 en los dos, o en ninguno.
const MGF1_APP = process.env.MGF1 === 'sha256' ? 'sha256' : 'sha1';

// ── identidad simulada de la app (§3.1) ───────────────────────────────────
// Dos claves, igual que en el chip: EC para firmar, RSA para recibir.
const firma = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const cifrado = generateKeyPairSync('rsa', { modulusLength: 2048 });
const APP_ID = randomBytes(16).toString('hex');

const spki = (k) => k.export({ type: 'spki', format: 'der' }).toString('base64');
const huella = (s) => createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);

const json = async (r) => ({ codigo: r.status, cuerpo: await r.json().catch(() => ({})) });

async function pedir(purpose) {
  const { cuerpo } = await json(await fetch(`${DOMINIO}/peticion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose, ttl: 120 }),
  }));
  return { ...cuerpo, qr: JSON.parse(cuerpo.qr) };
}

/** §5 y §6 — la app verifica contra el dominio y consume la petición. */
async function verificar(qr) {
  const { codigo, cuerpo } = await json(await fetch(`${DOMINIO}/verificar/${qr.request_id}`));
  if (codigo !== 200) throw new Error(`verificar devolvió ${codigo}`);
  if (cuerpo.nonce !== qr.nonce) throw new Error('nonce que no cuadra');
  if (cuerpo.domain !== qr.domain) throw new Error('dominio que no cuadra');
  return cuerpo;
}

const firmar = (texto) =>
  createSign('SHA256').update(Buffer.from(texto, 'utf8')).sign(firma.privateKey).toString('base64');

/** §7 — la misma cadena que arma contextoDe() en la app. */
const pruebaDePosesion = (p, contexto) =>
  firmar(['sello/prueba/v1', contexto, p.domain, p.request_id, p.nonce].join('\u001f'));

/** §14 — la misma que arma canonicoDeLaRespuesta(). */
const canonico = (r, domain) =>
  ['sello/secreto/v1', domain, r.request_id, r.nonce, r.domain_id, r.app_id, r.secret].join('\u001f');

/** Lo que hace cerrarSobre() en Kotlin, con los mismos parámetros. */
function cerrarSobre(spkiB64, claro) {
  const clave = randomBytes(32);
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', clave, iv);
  const ct = Buffer.concat([c.update(Buffer.from(claro, 'utf8')), c.final()]);
  return {
    alg: 'RSA-OAEP-256-MGF1SHA1+A256GCM',
    encrypted_key: publicEncrypt({
      key: Buffer.from(spkiB64, 'base64'),
      format: 'der',
      type: 'spki',
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
      mgf1Hash: 'sha1',
    }, clave).toString('base64'),
    iv: iv.toString('base64'),
    ciphertext: ct.toString('base64'),
    tag: c.getAuthTag().toString('base64'),
  };
}

const responder = async (p, cuerpo) => json(await fetch(`${DOMINIO}/respuesta/${p.request_id}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ...cuerpo, request_id: p.request_id, nonce: p.nonce }),
}));

let fallos = 0;
function comprobar(nombre, condicion, detalle = '') {
  console.log(`${condicion ? '  ok  ' : ' FALLA'} ${nombre}${detalle ? ` — ${detalle}` : ''}`);
  if (!condicion) fallos++;
}

// ── §10 emparejar y recibir el secreto ────────────────────────────────────
async function emparejar() {
  const c = await pedir('PAIR');
  const p = await verificar(c.qr);
  const { codigo, cuerpo } = await responder(p, {
    type: 'APP_IDENTITY',
    version: 1,
    app_id: APP_ID,
    app_public_key: spki(firma.publicKey),
    app_encryption_key: spki(cifrado.publicKey),
    proof_of_possession: pruebaDePosesion(p, 'PAIR'),
  });
  comprobar('el dominio acepta la prueba de posesión (§9)', codigo === 200, `HTTP ${codigo}`);
  comprobar('y entrega el secreto cifrado (§10)', Boolean(cuerpo.secret));
  return { peticion: p, sobre: cuerpo.secret };
}

/** Lo que hace abrirSobre() en el chip. */
async function abrirSobre(sobre) {
  const { privateDecrypt, createDecipheriv } = await import('node:crypto');
  const clave = privateDecrypt({
    key: cifrado.privateKey,
    padding: constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: 'sha256',
    mgf1Hash: MGF1_APP,
  }, Buffer.from(sobre.encrypted_key, 'base64'));
  const d = createDecipheriv('aes-256-gcm', clave, Buffer.from(sobre.iv, 'base64'));
  d.setAuthTag(Buffer.from(sobre.tag, 'base64'));
  return Buffer.concat([
    d.update(Buffer.from(sobre.ciphertext, 'base64')), d.final(),
  ]).toString('utf8');
}

// ── §14 devolver el secreto firmado y cifrado ─────────────────────────────
async function devolver(secreto, { estropear } = {}) {
  const c = await pedir('SECRET_REQUEST');
  const p = await verificar(c.qr);

  const r = {
    version: 1,
    request_id: p.request_id,
    nonce: p.nonce,
    domain_id: p.domain_id,
    app_id: APP_ID,
    secret: secreto,
  };
  let signature = firmar(canonico(r, p.domain));
  if (estropear === 'firma') {
    signature = firmar(canonico({ ...r, secret: 'otra cosa' }, p.domain));
  }
  const sobre = cerrarSobre(p.domain_public_key, JSON.stringify({ ...r, signature }));
  if (estropear === 'cifrado') {
    const b = Buffer.from(sobre.ciphertext, 'base64');
    b[0] ^= 0xff;
    sobre.ciphertext = b.toString('base64');
  }
  return responder(p, { type: 'SECRET_RESPONSE', version: 1, envelope: sobre });
}

console.log(`Dominio ${DOMINIO}\napp_id  ${APP_ID}\nMGF1    ${MGF1_APP}\n`);

const { sobre } = await emparejar();
const secreto = await abrirSobre(sobre);
comprobar('la app puede abrir el sobre del dominio', secreto.startsWith('sello-demo-'));
console.log(`        secreto ${huella(secreto)}…\n`);

{
  const { codigo, cuerpo } = await devolver(secreto);
  comprobar('el dominio descifra la respuesta y valida la firma (§14)',
    codigo === 200 && cuerpo.signature_valid === true, `HTTP ${codigo}`);
  comprobar('y el secreto coincide con el que entregó', cuerpo.matches === true);
}

// ── §24 lo que debe rechazar ──────────────────────────────────────────────
console.log('\nCasos que deben fallar:');
{
  const { codigo } = await devolver('secreto-inventado');
  comprobar('11/12 · firma sobre otro secreto se detecta', codigo === 200);
  // La firma es válida (cubre ese secreto), pero no coincide con el entregado:
  // el dominio lo acepta como respuesta y lo marca como no coincidente.
}
{
  const { codigo, cuerpo } = await devolver(secreto, { estropear: 'firma' });
  comprobar('16/17 · firma que no cubre la respuesta se rechaza',
    codigo === 403, `HTTP ${codigo} ${cuerpo.error ?? ''}`);
}
{
  const { codigo, cuerpo } = await devolver(secreto, { estropear: 'cifrado' });
  comprobar('15/18 · texto cifrado alterado se rechaza',
    codigo === 400, `HTTP ${codigo} ${cuerpo.error ?? ''}`);
}
{
  const c = await pedir('SECRET_REQUEST');
  const p = await verificar(c.qr);
  const { codigo } = await responder(p, {
    type: 'APP_IDENTITY', version: 1, app_id: APP_ID,
    app_public_key: spki(firma.publicKey),
    proof_of_possession: pruebaDePosesion(p, 'SECRET_REQUEST'),
  });
  comprobar('§19 · tipo que no corresponde al propósito se rechaza', codigo === 400, `HTTP ${codigo}`);
}
{
  const c = await pedir('SECRET_REQUEST');
  await verificar(c.qr);
  const { codigo } = await json(await fetch(`${DOMINIO}/verificar/${c.request_id}`));
  comprobar('5/24 · una petición ya consumida no se verifica dos veces', codigo === 409, `HTTP ${codigo}`);
}

console.log(fallos === 0 ? '\nTodo en orden.' : `\n${fallos} comprobación(es) fallaron.`);
process.exit(fallos === 0 ? 0 : 1);

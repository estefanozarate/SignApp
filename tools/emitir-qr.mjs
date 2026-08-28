#!/usr/bin/env node
/**
 * Emite un QR de Sello firmado. Sin dependencias: Node >= 20.
 *
 *   node tools/emitir-qr.mjs --key emisor.pem --kid ab25... \
 *        --org xami.run --sgu wss://relay.example/signal [--ttl 120]
 *
 * Imprime el payload "SL1:..." que el sitio debe pintar como QR.
 * El formato está documentado en el README §3 y lo verifica CoseModule.kt.
 */
import { createPrivateKey, sign, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

// ── CBOR mínimo: solo lo que necesita este payload ───────────────────────
const cabecera = (mayor, n) => {
  if (n < 24) return Buffer.from([(mayor << 5) | n]);
  if (n < 256) return Buffer.from([(mayor << 5) | 24, n]);
  if (n < 65536) return Buffer.from([(mayor << 5) | 25, n >> 8, n & 255]);
  const b = Buffer.alloc(5);
  b[0] = (mayor << 5) | 26;
  b.writeUInt32BE(n, 1);
  return b;
};
const cEntero = (n) => (n >= 0 ? cabecera(0, n) : cabecera(1, -n - 1));
const cBytes = (b) => Buffer.concat([cabecera(2, b.length), b]);
const cTexto = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([cabecera(3, b.length), b]); };
const cArray = (xs) => Buffer.concat([cabecera(4, xs.length), ...xs]);
const cMapa = (pares) => Buffer.concat([cabecera(5, pares.length), ...pares.flat()]);

// ── Base45 (RFC 9285) ───────────────────────────────────────────
const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
function base45(buf) {
  let salida = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    let n = buf[i] * 256 + buf[i + 1];
    salida += B45[n % 45] + B45[Math.floor(n / 45) % 45] + B45[Math.floor(n / 2025)];
  }
  if (buf.length % 2) {
    const n = buf[buf.length - 1];
    salida += B45[n % 45] + B45[Math.floor(n / 45)];
  }
  return salida;
}

// ── argumentos ───────────────────────────────────────────────
const arg = (nombre, pordefecto) => {
  const i = process.argv.indexOf('--' + nombre);
  return i > -1 ? process.argv[i + 1] : pordefecto;
};
const pem = arg('key');
const kidHex = arg('kid');
const org = arg('org');
const sgu = arg('sgu');
const ttl = Number(arg('ttl', '120'));

if (!pem || !kidHex || !org || !sgu) {
  console.error('Faltan argumentos. Uso:\n  node tools/emitir-qr.mjs --key emisor.pem --kid <hex> --org <dominio> --sgu wss://... [--ttl 120]');
  process.exit(1);
}
if (!sgu.startsWith('wss://')) {
  console.error('El signaling tiene que ser wss://; la app rechaza cualquier otra cosa.');
  process.exit(1);
}

// ── payload ──────────────────────────────────────────────────
const ahora = Math.floor(Date.now() / 1000);
// 128 bits de un CSPRNG: sin backend, el session_id es la única credencial
// del canal de signaling.
const sid = randomBytes(16).toString('hex');

const payload = cMapa([
  [cTexto('sid'), cTexto(sid)],
  [cTexto('org'), cTexto(org)],
  [cTexto('iat'), cEntero(ahora)],
  [cTexto('exp'), cEntero(ahora + ttl)],
  [cTexto('sgu'), cTexto(sgu)],
]);

// protected = { 1: -7 (ES256), 4: kid }
const protegido = cMapa([
  [cEntero(1), cEntero(-7)],
  [cEntero(4), cBytes(Buffer.from(kidHex, 'hex'))],
]);

// Sig_structure = [ "Signature1", protected, external_aad(vacío), payload ]
const aFirmar = cArray([
  cTexto('Signature1'),
  cBytes(protegido),
  cBytes(Buffer.alloc(0)),
  cBytes(payload),
]);

const clave = createPrivateKey(readFileSync(pem));
// COSE espera r||s crudos; Node firma en DER, así que hay que convertir.
const der = sign('sha256', aFirmar, clave);
const firma = derACrudo(der);

function derACrudo(der) {
  let i = 2;
  if (der[1] & 0x80) i = 2 + (der[1] & 0x7f);
  const leer = () => {
    if (der[i++] !== 0x02) throw new Error('DER inesperado');
    const len = der[i++];
    let v = der.subarray(i, i + len);
    i += len;
    while (v.length > 32 && v[0] === 0) v = v.subarray(1);
    return Buffer.concat([Buffer.alloc(32 - v.length), v]);
  };
  return Buffer.concat([leer(), leer()]);
}

// COSE_Sign1 = 18([ protected, {}, payload, signature ])
const sign1 = Buffer.concat([
  cabecera(6, 18),
  cArray([cBytes(protegido), cMapa([]), cBytes(payload), cBytes(firma)]),
]);

const salida = 'SL1:' + base45(deflateSync(sign1, { level: 9 }));

console.error(`session_id : ${sid}`);
console.error(`caduca en  : ${ttl}s`);
console.error(`longitud   : ${salida.length} caracteres`);
console.log(salida);

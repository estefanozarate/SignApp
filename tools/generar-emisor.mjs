#!/usr/bin/env node
/**
 * Genera un par de claves de emisor y su entrada para src/emisores.json.
 *
 *   node tools/generar-emisor.mjs --org xami.run --out emisor.pem
 *
 * La privada NUNCA va al repo: vive donde tu sitio firma los QR.
 */
import { generateKeyPairSync, createHash } from 'node:crypto';
import { writeFileSync, existsSync } from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > -1 ? process.argv[i + 1] : d; };
const org = arg('org');
const out = arg('out', 'emisor.pem');
if (!org) { console.error('Uso: node tools/generar-emisor.mjs --org <dominio> [--out emisor.pem]'); process.exit(1); }
if (existsSync(out)) { console.error(`${out} ya existe. No lo sobrescribo.`); process.exit(1); }

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const spki = publicKey.export({ type: 'spki', format: 'der' });
const kid = createHash('sha256').update(spki).digest('hex').slice(0, 16);

writeFileSync(out, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });

console.log(`Clave privada escrita en ${out} (modo 600). No la subas al repo.\n`);
console.log('Añade esta entrada a src/emisores.json:\n');
console.log(JSON.stringify({ kid, alg: 'ES256', spkiB64: spki.toString('base64'), nombre: org }, null, 2));
console.log(`\nY emite QR con:\n  node tools/emitir-qr.mjs --key ${out} --kid ${kid} --org ${org} --sgu wss://tu-relay/signal`);

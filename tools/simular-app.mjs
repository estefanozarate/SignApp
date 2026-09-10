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

// ── identidad simulada de la app (§3.1) ────────────────────────────────
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

// ── §10 emparejar y recibir el secreto ──────────────────────────────
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

// ── §14 devolver el secreto firmado y cifrado ────────────────────────
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

// ── §24 lo que debe rechazar ──────────────────────────────────────
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
{
  // 3/24 — request_id que no existe.
  const { codigo } = await json(await fetch(`${DOMINIO}/verificar/${'0'.repeat(32)}`));
  comprobar('3/24 · request_id inexistente se rechaza', codigo === 404, `HTTP ${codigo}`);
}
{
  // 4/24 — petición caducada. ttl=1 y se espera a que pase.
  const { cuerpo } = await json(await fetch(`${DOMINIO}/peticion`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'PAIR', ttl: 1 }),
  }));
  // expires_at trunca a segundos; hace falta más de un segundo entero de
  // margen para que "ahora > expires_at" sea cierto sin ambigüedad.
  await new Promise((r) => setTimeout(r, 2200));
  const { codigo } = await json(await fetch(`${DOMINIO}/verificar/${cuerpo.request_id}`));
  comprobar('4/24 · petición caducada se rechaza', codigo === 410, `HTTP ${codigo}`);
}
{
  // 6/24 — nonce que no coincide con el de la petición, en la respuesta.
  const c = await pedir('SECRET_REQUEST');
  const p = await verificar(c.qr);
  const { codigo, cuerpo } = await json(await fetch(`${DOMINIO}/respuesta/${p.request_id}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'APP_IDENTITY', version: 1, request_id: p.request_id,
      nonce: 'otro-nonce-que-no-es-el-de-la-peticion',
      app_id: APP_ID, app_public_key: spki(firma.publicKey),
      app_encryption_key: spki(cifrado.publicKey),
      proof_of_possession: pruebaDePosesion(p, 'SECRET_REQUEST'),
    }),
  }));
  comprobar('6/24 · nonce que no cuadra en la respuesta se rechaza',
    codigo === 400, `HTTP ${codigo} ${cuerpo.error ?? ''}`);
}
{
  // §16 — el sobre firmado va dirigido a un domain_id que no es el de este
  // dominio: se rechaza antes incluso de mirar quién firma.
  const c = await pedir('SECRET_REQUEST');
  const p = await verificar(c.qr);
  const r = {
    version: 1, request_id: p.request_id, nonce: p.nonce,
    domain_id: 'domain-id-equivocado', app_id: APP_ID, secret: secreto,
  };
  const signature = firmar(canonico(r, p.domain));
  const sobre = cerrarSobre(p.domain_public_key, JSON.stringify({ ...r, signature }));
  const { codigo, cuerpo } = await responder(p, { type: 'SECRET_RESPONSE', version: 1, envelope: sobre });
  comprobar('§16 · respuesta dirigida a otro domain_id se rechaza',
    codigo === 400, `HTTP ${codigo} ${cuerpo.error ?? ''}`);
}
{
  // §19 "unknown App identity" — firma válida, pero de un app_id que nunca
  // se emparejó, así que el dominio no tiene con qué clave verificarla.
  const otraFirma = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const otroAppId = randomBytes(16).toString('hex');
  const c = await pedir('SECRET_REQUEST');
  const p = await verificar(c.qr);
  const r = { version: 1, request_id: p.request_id, nonce: p.nonce, domain_id: p.domain_id, app_id: otroAppId, secret: secreto };
  const signature = createSign('SHA256').update(Buffer.from(canonico(r, p.domain), 'utf8'))
    .sign(otraFirma.privateKey).toString('base64');
  const sobre = cerrarSobre(p.domain_public_key, JSON.stringify({ ...r, signature }));
  const { codigo, cuerpo } = await responder(p, { type: 'SECRET_RESPONSE', version: 1, envelope: sobre });
  comprobar('§19 · app_id nunca emparejado se rechaza',
    codigo === 403, `HTTP ${codigo} ${cuerpo.error ?? ''}`);
}
{
  // Una petición no se responde dos veces, aunque la segunda sea válida.
  const c = await pedir('SECRET_REQUEST');
  const p = await verificar(c.qr);
  const r = { version: 1, request_id: p.request_id, nonce: p.nonce, domain_id: p.domain_id, app_id: APP_ID, secret: secreto };
  const cuerpoResp = { type: 'SECRET_RESPONSE', version: 1, envelope: cerrarSobre(p.domain_public_key, JSON.stringify({ ...r, signature: firmar(canonico(r, p.domain)) })) };
  const primera = await responder(p, cuerpoResp);
  const segunda = await responder(p, cuerpoResp);
  comprobar('§15 · una petición no se responde dos veces',
    primera.codigo === 200 && segunda.codigo === 409, `HTTP ${primera.codigo} luego ${segunda.codigo}`);
}
{
  // §22 "Concurrent consumption" — dos verificaciones a la vez sobre la
  // misma petición: solo una debe ganar.
  const c = await pedir('SECRET_REQUEST');
  const [a, b] = await Promise.all([
    json(await fetch(`${DOMINIO}/verificar/${c.request_id}`)),
    json(await fetch(`${DOMINIO}/verificar/${c.request_id}`)),
  ]);
  const codigos = [a.codigo, b.codigo].sort();
  comprobar('§22 · verificación concurrente: solo una gana', codigos[0] === 200 && codigos[1] === 409,
    `HTTP ${a.codigo} y ${b.codigo}`);
}

{
  // 2/24 y 7/24 — QR con domain o nonce alterados. verificar() de este
  // script reproduce la misma comparación que hace la app en §6: si lo que
  // el dominio confirma no coincide con lo que decía el QR, se rechaza
  // ANTES de confiar en nada de lo que venga después.
  const c = await pedir('PAIR');
  let lanzo1 = false;
  try { await verificar({ ...c.qr, domain: 'otro-dominio.evil' }); } catch { lanzo1 = true; }
  comprobar('2/24 · QR con domain alterado se detecta antes de confiar en la respuesta', lanzo1);

  const c2 = await pedir('PAIR');
  let lanzo2 = false;
  try { await verificar({ ...c2.qr, nonce: 'un-nonce-que-no-es-el-real' }); } catch { lanzo2 = true; }
  comprobar('7/24 · QR con nonce alterado se detecta antes de confiar en la respuesta', lanzo2);
}
{
  // 8/24 — prueba de posesión que no es una firma válida sobre el contexto
  // correcto (aquí, una firma sobre un texto cualquiera).
  const c = await pedir('PAIR');
  const p = await verificar(c.qr);
  const { codigo } = await responder(p, {
    type: 'APP_IDENTITY', version: 1, app_id: randomBytes(16).toString('hex'),
    app_public_key: spki(firma.publicKey),
    app_encryption_key: spki(cifrado.publicKey),
    proof_of_possession: firmar('esto no es el contexto que se debía firmar'),
  });
  comprobar('8/24 · prueba de posesión que no cubre el contexto correcto se rechaza', codigo === 403, `HTTP ${codigo}`);
}
{
  // 9/24 — la prueba se firma con una clave, pero se anuncia la pública de
  // OTRA: la verificación tiene que fallar porque no son el mismo par.
  const otraFirma = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const c = await pedir('PAIR');
  const p = await verificar(c.qr);
  const { codigo } = await responder(p, {
    type: 'APP_IDENTITY', version: 1, app_id: randomBytes(16).toString('hex'),
    app_public_key: spki(otraFirma.publicKey),   // la pública que se anuncia…
    app_encryption_key: spki(cifrado.publicKey),
    proof_of_possession: pruebaDePosesion(p, 'PAIR'),   // …no es la que firmó esto
  });
  comprobar('9/24 · app_public_key que no corresponde a quien firmó se rechaza', codigo === 403, `HTTP ${codigo}`);
}
{
  // 12/24 — una respuesta firmada y cifrada, capturada de una petición A, se
  // reenvía contra una petición B distinta. El sobre descifra bien (es el
  // mismo dominio), pero el contexto que va DENTRO —firmado— es el de A, y
  // no coincide con el de B: eso es lo que impide el reuso.
  const cA = await pedir('SECRET_REQUEST');
  const pA = await verificar(cA.qr);
  const rA = { version: 1, request_id: pA.request_id, nonce: pA.nonce, domain_id: pA.domain_id, app_id: APP_ID, secret: secreto };
  const sobreDeA = cerrarSobre(pA.domain_public_key, JSON.stringify({ ...rA, signature: firmar(canonico(rA, pA.domain)) }));

  const cB = await pedir('SECRET_REQUEST');
  const pB = await verificar(cB.qr);
  const { codigo, cuerpo } = await responder(pB, { type: 'SECRET_RESPONSE', version: 1, envelope: sobreDeA });
  comprobar('12/24 · una respuesta capturada de otra petición no sirve para esta',
    codigo === 400, `HTTP ${codigo} ${cuerpo.error ?? ''}`);
}
{
  // 16/24 — no ya una firma sobre otro contenido (eso ya se prueba arriba),
  // sino los bytes crudos de la firma alterados un bit.
  const c = await pedir('SECRET_REQUEST');
  const p = await verificar(c.qr);
  const r = { version: 1, request_id: p.request_id, nonce: p.nonce, domain_id: p.domain_id, app_id: APP_ID, secret: secreto };
  const bytes = Buffer.from(firmar(canonico(r, p.domain)), 'base64');
  bytes[0] ^= 0xff;
  const sobre = cerrarSobre(p.domain_public_key, JSON.stringify({ ...r, signature: bytes.toString('base64') }));
  const { codigo, cuerpo } = await responder(p, { type: 'SECRET_RESPONSE', version: 1, envelope: sobre });
  comprobar('16/24 · bytes de la firma alterados se rechazan', codigo === 403, `HTTP ${codigo} ${cuerpo.error ?? ''}`);
}
{
  // 18/24 — el sobre se cifra para una clave RSA que no es la del dominio
  // (una ajena, no la que devolvió /verificar). El dominio intenta abrirlo
  // con SU privada real y el desenvuelto falla: ni el padding OAEP ni la
  // autenticación de GCM van a cuadrar con una clave que no es la suya.
  const ajena = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const c = await pedir('SECRET_REQUEST');
  const p = await verificar(c.qr);
  const r = { version: 1, request_id: p.request_id, nonce: p.nonce, domain_id: p.domain_id, app_id: APP_ID, secret: secreto };
  const sobre = cerrarSobre(spki(ajena.publicKey), JSON.stringify({ ...r, signature: firmar(canonico(r, p.domain)) }));
  const { codigo, cuerpo } = await responder(p, { type: 'SECRET_RESPONSE', version: 1, envelope: sobre });
  comprobar('18/24 · sobre cifrado para una clave que no es la del dominio se rechaza',
    codigo === 400, `HTTP ${codigo} ${cuerpo.error ?? ''}`);
}
{
  // 21/24 — lo que recoge el navegador (GET /respuesta/:id) no debe traer el
  // secreto en claro en ningún campo, ni siquiera envuelto: el §14 se lo
  // entrega al DOMINIO, y una página estática no tiene dónde custodiarlo.
  const c = await pedir('SECRET_REQUEST');
  const p = await verificar(c.qr);
  const r = { version: 1, request_id: p.request_id, nonce: p.nonce, domain_id: p.domain_id, app_id: APP_ID, secret: secreto };
  const sobre = cerrarSobre(p.domain_public_key, JSON.stringify({ ...r, signature: firmar(canonico(r, p.domain)) }));
  await responder(p, { type: 'SECRET_RESPONSE', version: 1, envelope: sobre });
  const textoParaElNavegador = await (await fetch(`${DOMINIO}/respuesta/${p.request_id}`)).text();
  comprobar('21/24 · el secreto en claro nunca llega a lo que ve el navegador',
    !textoParaElNavegador.includes(secreto));
}
{
  // 23/24 — caducidad, pero específicamente en una petición de RECUPERACIÓN
  // de secreto (SECRET_REQUEST), no de emparejamiento: son dos propósitos
  // distintos y el §19 exige que cada uno se valide por su cuenta.
  const { cuerpo } = await json(await fetch(`${DOMINIO}/peticion`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'SECRET_REQUEST', ttl: 1 }),
  }));
  await new Promise((r) => setTimeout(r, 2200));
  const { codigo } = await json(await fetch(`${DOMINIO}/verificar/${cuerpo.request_id}`));
  comprobar('23/24 · petición de recuperación de secreto caducada se rechaza', codigo === 410, `HTTP ${codigo}`);
}

/*
 * Del §24 quedan sin ejercitar aquí, y por qué:
 *
 * 10/24 "Wrong domain public key" — es la clave del PROPIO dominio; este
 *   script solo levanta un dominio, así que no hay una "clave equivocada
 *   del dominio" que presentar sin montar un segundo servidor.
 * 11/24 "Wrong domain requesting another domain's secret" — el §13
 *   (dominio ≠ el que guardó el secreto) lo hace boveda.ts/paraDominio() en
 *   la APP, no este servidor: un servidor de un solo dominio no tiene con
 *   qué simular a "otro dominio" pidiendo. Se revisa por lectura de código,
 *   no por esta suite.
 * 14/24 y 25/24 (sesión WebRTC) — no aplican: el transporte de esta
 *   implementación es HTTP, no WebRTC (ver server/README.md "Por qué esto
 *   es HTTP y no WebRTC"). No hay sesión que inyectar ni con la que
 *   confundir un mensaje.
 * 19/24 y 20/24 (que las privadas nunca se transmitan) — son propiedades
 *   del CÓDIGO (qué cruza el puente nativo, qué campos manda cada mensaje),
 *   no algo observable desde fuera por HTTP: ninguna llamada al protocolo
 *   incluye jamás esos campos, así que no hay una petición que hacer para
 *   "probar que no pasa". Se verifica leyendo SigningModule.kt y
 *   servidor.mjs, no ejecutando este script.
 */

console.log(fallos === 0 ? '\nTodo en orden.' : `\n${fallos} comprobación(es) fallaron.`);
process.exit(fallos === 0 ? 0 : 1);

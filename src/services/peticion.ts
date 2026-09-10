import { Signing } from '../native/Signing';
import type { SecretoGuardado } from './boveda';
import { bytesAB64, textoABytes } from '../lib/aleatorio';
import { textoDeB64 } from '../lib/b64';

/**
 * Petición de un dominio, verificada contra el propio dominio por HTTPS.
 * Implementa §4.2, §5, §6, §7, §10 y §10.1 de diseno_app.md.
 */

/** §4.2 — lo que el QR contiene, y nada más. */
export type ContenidoQr = {
  version: number;
  action: 'PAIR' | 'SECRET_REQUEST';
  domain: string;
  request_id: string;
  nonce: string;
};

/** §6 — la identidad del dominio, tras verificar. */
export type Peticion = ContenidoQr & {
  domain_id: string;
  domain_public_key: string;
  purpose: 'PAIR' | 'SECRET_REQUEST';
  action_texto: string;
  account?: string;
  issued_at: number;
  expires_at: number;
  /** Base de la que se descargó, construida por la app a partir de domain. */
  origen: string;
};

export class PeticionInvalida extends Error {
  constructor(public codigo: string, mensaje: string) { super(mensaje); }
}

const TIEMPO_LIMITE_MS = 12000;
const ACCIONES = ['PAIR', 'SECRET_REQUEST'];

function conTope<T>(p: Promise<T>, ms: number, mensaje: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const tope = new Promise<never>((_, falla) => {
    t = setTimeout(() => falla(new PeticionInvalida('E_RED', mensaje)), ms);
  });
  return Promise.race([p, tope]).finally(() => clearTimeout(t)) as Promise<T>;
}

/** §4.2 — se lee el QR y se comprueba su forma antes de tocar la red. */
export function leerQr(texto: string): ContenidoQr {
  let q: any;
  try {
    q = JSON.parse(texto.trim());
  } catch {
    throw new PeticionInvalida('E_FORMATO', 'Este código no es de Sello.');
  }
  if (q?.version !== 1) {
    throw new PeticionInvalida('E_VERSION', 'Este código es de otra versión del protocolo.');
  }
  if (!ACCIONES.includes(q.action)) {
    throw new PeticionInvalida('E_FORMATO', 'Este código pide una operación desconocida.');
  }
  if (typeof q.domain !== 'string' || !q.domain ||
      typeof q.request_id !== 'string' || !/^[0-9a-f]{32}$/i.test(q.request_id) ||
      typeof q.nonce !== 'string' || q.nonce.length < 20) {
    throw new PeticionInvalida('E_FORMATO', 'A este código le faltan datos.');
  }
  return q as ContenidoQr;
}

/**
 * §5 — la app construye ella misma la dirección a partir del dominio del QR.
 *
 * El documento es explícito: no debe confiar en una URL de verificación
 * suministrada por el QR. Si el QR trajera la URL, un atacante podría poner
 * un dominio en el texto y mandar la consulta a otro servidor.
 *
 * http:// solo se tolera en loopback, para desarrollo local.
 */
function baseDe(dominio: string): string {
  const loopback = dominio.startsWith('127.0.0.1') || dominio.startsWith('localhost');
  const esquema = loopback ? 'http' : 'https';
  const limpio = dominio.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^[a-z0-9.\-]+(:\d+)?$/i.test(limpio)) {
    throw new PeticionInvalida('E_FORMATO', 'El dominio del código no es válido.');
  }
  return `${esquema}://${limpio}`;
}

/** §5 y §6 — verificar contra el dominio y comprobar que la respuesta cuadra. */
export async function verificar(textoQr: string): Promise<Peticion> {
  const qr = leerQr(textoQr);
  const origen = baseDe(qr.domain);

  // fetch lanza TypeError si no hay ruta al servidor. Sin envolverlo, ese
  // fallo llegaba arriba sin código y se clasificaba como E_FORMATO: la app
  // decía "este código no es de Sello" cuando el problema era la red.
  let res: Response;
  try {
    res = await conTope(
      fetch(`${origen}/verificar/${qr.request_id}`, { headers: { Accept: 'application/json' } }),
      TIEMPO_LIMITE_MS,
      'El sitio no respondió a tiempo.',
    );
  } catch (e) {
    if (e instanceof PeticionInvalida) throw e;
    throw new PeticionInvalida('E_RED', `No se pudo conectar con ${qr.domain}.`);
  }

  if (res.status === 404) throw new PeticionInvalida('E_NO_EXISTE', 'El sitio no reconoce esta petición.');
  if (res.status === 410) throw new PeticionInvalida('E_EXPIRADA', 'Este código ya caducó.');
  if (res.status === 409) throw new PeticionInvalida('E_USADA', 'Este código ya se usó una vez.');
  if (res.status === 403) throw new PeticionInvalida('E_NO_AUTORIZADA', 'El sitio no autorizó esta petición.');
  if (!res.ok) throw new PeticionInvalida('E_RED', `El sitio respondió ${res.status}.`);

  let r: any;
  try {
    r = await res.json();
  } catch {
    throw new PeticionInvalida('E_RED', 'El sitio respondió algo que no se pudo leer.');
  }

  // §6 — las comparaciones. Sin ellas, el dominio podría responder cualquier
  // cosa y la app se la creería.
  if (r.status !== 'authorized') {
    throw new PeticionInvalida('E_NO_AUTORIZADA', 'El sitio no autorizó esta petición.');
  }
  if (r.domain !== qr.domain) {
    throw new PeticionInvalida('E_DOMINIO', 'El sitio responde por un dominio distinto del que dice el código.');
  }
  if (r.request_id !== qr.request_id) {
    throw new PeticionInvalida('E_DOMINIO', 'El sitio responde sobre otra petición.');
  }
  if (r.nonce !== qr.nonce) {
    throw new PeticionInvalida('E_NONCE', 'El sitio devolvió un nonce que no coincide con el código.');
  }
  // §19 — el propósito debe ser el mismo: una petición de vinculación no
  // puede convertirse en una de entrega de secreto por el camino.
  if (r.purpose !== qr.action) {
    throw new PeticionInvalida('E_PROPOSITO', 'El sitio cambió el propósito de la petición.');
  }
  if (!r.domain_id || !r.domain_public_key) {
    throw new PeticionInvalida('E_FORMATO', 'El sitio no envió su identidad.');
  }
  if (Number(r.expires_at) < Math.floor(Date.now() / 1000)) {
    throw new PeticionInvalida('E_EXPIRADA', 'Este código ya caducó.');
  }

  return {
    ...qr,
    domain_id: r.domain_id,
    domain_public_key: r.domain_public_key,
    purpose: r.purpose,
    action_texto: r.action ?? 'Aprobar una acción',
    account: r.account,
    issued_at: Number(r.issued_at),
    expires_at: Number(r.expires_at),
    origen,
  };
}

/**
 * §7 — Prueba de posesión.
 *
 * Se firma dominio + request_id + nonce + contexto. Queda atada a ESTE
 * emparejamiento: una prueba de otro no vale, y no expone la clave privada.
 * El separador 0x1f no aparece en texto normal, así que dos contextos
 * distintos no pueden producir la misma cadena al concatenar campos.
 */
export function contextoDe(p: ContenidoQr, contexto: string): string {
  return bytesAB64(textoABytes([
    'sello/prueba/v1',
    contexto,
    p.domain,
    p.request_id,
    p.nonce,
  ].join('\u001f')));
}

/** Firma la prueba de posesión dentro del chip. */
export async function pruebaDePosesion(p: Peticion, contexto: string) {
  const { firmaDerB64, keyId } = await Signing.firmar(
    contextoDe(p, contexto),
    p.action_texto,
    p.domain,
  );
  return { proof: firmaDerB64, app_id: keyId };
}

/** §10 — el secreto que el dominio devuelve, cifrado para la clave de la app. */
export type SecretoCifrado = {
  alg: string;
  encrypted_key: string;
  iv: string;
  ciphertext: string;
  tag: string;
};

/**
 * Lo que el dominio contesta al recibir la respuesta de la app.
 *
 * En un PAIR trae el secreto cifrado (§10). En un SECRET_REQUEST trae el
 * veredicto del §14: si pudo descifrar, si la firma era válida y si el
 * secreto coincide con el que entregó en su día.
 */
export type Acuse = {
  ok?: boolean;
  /** §10 — solo en el emparejamiento. */
  secret?: SecretoCifrado;
  /** §14 — solo al devolver el secreto. */
  signature_valid?: boolean;
  matches?: boolean;
  secret_fingerprint?: string;
};

/** Entrega la respuesta al dominio, con el contexto de esta petición (§15). */
export async function responder(
  p: Peticion, cuerpo: Record<string, unknown>,
): Promise<Acuse> {
  let res: Response;
  try {
    res = await conTope(
      fetch(`${p.origen}/respuesta/${p.request_id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...cuerpo, request_id: p.request_id, nonce: p.nonce }),
      }),
      TIEMPO_LIMITE_MS,
      'El sitio no respondió a tiempo.',
    );
  } catch (e) {
    if (e instanceof PeticionInvalida) throw e;
    throw new PeticionInvalida('E_RED', `No se pudo conectar con ${p.domain}.`);
  }

  // §9 y §14: el dominio rechaza si la firma no cuadra. Merece su propio
  // motivo: significa que no se pudo validar, no que haya fallado la red.
  if (res.status === 403) {
    throw new PeticionInvalida(
      p.purpose === 'PAIR' ? 'E_PRUEBA' : 'E_FIRMA',
      p.purpose === 'PAIR'
        ? 'El sitio no aceptó la prueba de identidad.'
        : 'El sitio no aceptó la firma de la respuesta.',
    );
  }
  if (res.status === 409) throw new PeticionInvalida('E_USADA', 'El sitio ya recibió una respuesta.');
  if (res.status === 410) throw new PeticionInvalida('E_EXPIRADA', 'La petición caducó antes de enviarla.');
  if (!res.ok) throw new PeticionInvalida('E_RED', `El sitio no aceptó la respuesta (${res.status}).`);

  try {
    return await res.json();
  } catch {
    // El secreto es opcional: en un PAIR no viene ninguno.
    return {};
  }
}

export async function rechazar(p: Peticion) {
  await responder(p, { type: 'DENIED', reason: 'user_denied' }).catch(() => {});
}

/**
 * §10 — abre el secreto que el dominio cifró para esta app.
 *
 * Los dos pasos ocurren dentro del módulo nativo: la clave AES se desenvuelve
 * en el chip y el dato se abre en Kotlin. Ni la privada RSA ni la clave AES
 * cruzan el puente; aquí solo llega el claro ya descifrado.
 *
 * §10.1 — ya no pide autenticación: lo que autoriza este paso es la firma de
 * la prueba de posesión que ya viajó en pruebaDePosesion(), no un prompt
 * nuevo aquí. El secreto que sale de aquí todavía no está guardado; quien lo
 * guarda (Aprobacion.tsx) sí pasa por autenticar() al meterlo en la bóveda.
 */
export async function abrirSecreto(
  s: SecretoCifrado, p: Peticion,
): Promise<string> {
  if (!s?.encrypted_key || !s.iv || !s.ciphertext || !s.tag) {
    throw new PeticionInvalida('E_SECRETO', 'El sitio no envió el secreto completo.');
  }

  const { claroB64 } = await Signing.abrirSobre(s.encrypted_key, s.iv, s.ciphertext, s.tag);
  return textoDeB64(claroB64);
}

// ── §14 la app devuelve el secreto, firmado y cifrado ───────────────────

/**
 * §14 — los campos de la respuesta. Son exactamente los que el documento
 * enumera, y los que el dominio reconstruye para verificar la firma.
 */
export type RespuestaSecreto = {
  version: 1;
  request_id: string;
  nonce: string;
  domain_id: string;
  app_id: string;
  secret: string;
};

/**
 * Serialización canónica de lo que se firma.
 *
 * No se firma el JSON: dos serializaciones del mismo objeto pueden diferir en
 * el orden de las claves o en los espacios, y entonces la firma no verifica
 * por un motivo que no tiene nada que ver con la seguridad. Se firma una
 * cadena con los campos en orden fijo, unidos por 0x1f — el mismo separador
 * que ya usa la prueba de posesión, y por la misma razón: no aparece en texto
 * normal, así que no hay forma de que dos combinaciones distintas de campos
 * produzcan la misma cadena.
 *
 * Que la firma cubra request_id y nonce es lo que impide el §15: una
 * respuesta capturada de una petición anterior no vale para la siguiente.
 * Que cubra domain_id impide el §16: la respuesta va dirigida a ESE dominio.
 */
export function canonicoDeLaRespuesta(r: RespuestaSecreto, domain: string): string {
  return [
    'sello/secreto/v1',
    domain,
    r.request_id,
    r.nonce,
    r.domain_id,
    r.app_id,
    r.secret,
  ].join('\u001f');
}

/**
 * §13 y §14 — lee la bóveda, firma el secreto y lo cifra para el dominio.
 *
 * §10.1 — el orden es autenticar → leer la bóveda → firmar, y ese orden
 * importa: la firma tiene que cubrir el secreto ya leído, así que hace falta
 * tenerlo en claro antes de firmar. autenticar() desbloquea la ventana de
 * validez de la clave de la bóveda; leer dentro de esa ventana no pide nada
 * más. firmar() sigue pidiendo su propia autenticación por operación para la
 * clave EC — es un mecanismo distinto, y en la práctica el usuario nota un
 * solo gesto si ambas ocurren seguidas (ver generarBoveda() en el módulo
 * nativo). El cifrado final usa solo la clave pública del dominio, así que
 * no pide nada.
 */
export async function entregarSecreto(
  p: Peticion, guardado: SecretoGuardado,
): Promise<{ acuse: Acuse; firmaDerB64: string; appId: string }> {
  // §13 — se vuelve a comprobar aquí, no solo en la pantalla. La bóveda pudo
  // cambiar entre que se pintó la pantalla y que el usuario pulsó.
  if (guardado.domain_id !== p.domain_id || guardado.domain_public_key !== p.domain_public_key) {
    throw new PeticionInvalida(
      'E_SIN_SECRETO', 'El secreto guardado no pertenece a este dominio.',
    );
  }

  await Signing.autenticar('Devolver tu secreto', p.domain);
  const { claroB64 } = await Signing.descifrarDeBoveda(
    guardado.sobre.ivB64, guardado.sobre.cifradoB64, guardado.sobre.tagB64,
  );
  const secreto = textoDeB64(claroB64);

  const identidad = await Signing.identidad();
  const respuesta: RespuestaSecreto = {
    version: 1,
    request_id: p.request_id,
    nonce: p.nonce,
    domain_id: p.domain_id,
    app_id: identidad.keyId,
    secret: secreto,
  };

  const { firmaDerB64 } = await Signing.firmar(
    bytesAB64(textoABytes(canonicoDeLaRespuesta(respuesta, p.domain))),
    'Devolver tu secreto',
    p.domain,
  );

  // El sobre lleva la respuesta Y su firma: el dominio no puede verificar
  // nada hasta haberlo abierto con su clave privada.
  const claro = JSON.stringify({ ...respuesta, signature: firmaDerB64 });
  const sobre = await Signing.cerrarSobre(
    p.domain_public_key, bytesAB64(textoABytes(claro)),
  );

  const acuse = await responder(p, {
    type: 'SECRET_RESPONSE',
    version: 1,
    // Nombres en inglés, como el resto del protocolo del documento: este
    // objeto lo lee el servidor, no la app.
    envelope: {
      alg: sobre.alg,
      encrypted_key: sobre.claveEnvueltaB64,
      iv: sobre.ivB64,
      ciphertext: sobre.cifradoB64,
      tag: sobre.tagB64,
    },
  });

  return { acuse, firmaDerB64, appId: identidad.keyId };
}

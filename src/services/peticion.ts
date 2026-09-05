import { Signing } from '../native/Signing';
import { bytesAB64, textoABytes } from '../lib/aleatorio';

/**
 * Petición de un dominio, verificada contra el propio dominio por HTTPS.
 * Implementa §4.2, §5, §6 y §7 de diseno_app.md.
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

  // §6 — las tres comparaciones. Sin ellas, el dominio podría responder
  // cualquier cosa y la app se la creería.
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

/** Entrega la respuesta al dominio, con el contexto de esta petición (§15). */
export async function responder(p: Peticion, cuerpo: Record<string, unknown>) {
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

  // §9: el dominio rechaza la prueba si no cuadra. Merece su propio motivo:
  // significa que la firma no se pudo validar, no que haya fallado la red.
  if (res.status === 403) {
    throw new PeticionInvalida('E_PRUEBA', 'El sitio no aceptó la prueba de identidad.');
  }
  if (res.status === 409) throw new PeticionInvalida('E_USADA', 'El sitio ya recibió una respuesta.');
  if (res.status === 410) throw new PeticionInvalida('E_EXPIRADA', 'La petición caducó antes de enviarla.');
  if (!res.ok) throw new PeticionInvalida('E_RED', `El sitio no aceptó la respuesta (${res.status}).`);
}

export async function rechazar(p: Peticion) {
  await responder(p, { type: 'DENIED', reason: 'user_denied' }).catch(() => {});
}

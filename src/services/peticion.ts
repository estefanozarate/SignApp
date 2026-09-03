import { Signing } from '../native/Signing';
import { bytesAB64, textoABytes } from '../lib/aleatorio';

/**
 * Petición de un dominio, verificada por HTTPS.
 *
 * El QR ya no lleva firma ni CBOR: solo una URL. La app la consulta y el
 * dominio responde qué pide realmente. La autenticidad viene del certificado
 * TLS, que el sistema valida — no de una clave de emisor que habría que
 * distribuir y rotar.
 *
 * Lo que el usuario ve en pantalla sale SIEMPRE de esta respuesta, nunca del
 * QR. Si el QR mintiera sobre la acción, no serviría de nada: no es la fuente.
 */

export type Peticion = {
  request_id: string;
  domain: string;
  action: string;
  account?: string;
  nonce: string;
  issued_at: number;
  expires_at: number;
  /** Origen del que se descargó, para atarlo todo a un mismo sitio. */
  origen: string;
};

export class PeticionInvalida extends Error {
  constructor(public codigo: string, mensaje: string) { super(mensaje); }
}

const TIEMPO_LIMITE_MS = 12000;

function conTope<T>(p: Promise<T>, ms: number, mensaje: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  const tope = new Promise<never>((_, falla) => { t = setTimeout(() => falla(new PeticionInvalida('E_RED', mensaje)), ms); });
  return Promise.race([p, tope]).finally(() => clearTimeout(t)) as Promise<T>;
}

/**
 * Comprueba la URL antes de tocar la red.
 *
 * http:// solo se acepta en loopback, donde no hay red que espiar. Sin esto,
 * un QR podría mandar a la app a un servidor en claro y todo el modelo se
 * apoyaría en nada.
 */
export function urlDePeticion(qr: string): URL {
  let u: URL;
  try {
    u = new URL(qr.trim());
  } catch {
    throw new PeticionInvalida('E_FORMATO', 'Este código no contiene una dirección válida.');
  }

  const seguro = u.protocol === 'https:' ||
    (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost'));
  if (!seguro) {
    throw new PeticionInvalida('E_INSEGURO', 'Este código apunta a una dirección sin cifrar.');
  }
  if (!/^\/verificar\/[0-9a-f]{32}$/i.test(u.pathname)) {
    throw new PeticionInvalida('E_FORMATO', 'Este código no tiene el formato de Sello.');
  }
  return u;
}

/** Pregunta al dominio qué pide de verdad. */
export async function verificar(qr: string): Promise<Peticion> {
  const u = urlDePeticion(qr);

  const res = await conTope(
    fetch(u.toString(), { headers: { Accept: 'application/json' } }),
    TIEMPO_LIMITE_MS,
    'El sitio no respondió a tiempo.',
  );

  if (res.status === 404) throw new PeticionInvalida('E_NO_EXISTE', 'Este código ya no existe en el sitio.');
  if (res.status === 410) throw new PeticionInvalida('E_EXPIRADA', 'Este código ya caducó.');
  if (res.status === 409) throw new PeticionInvalida('E_USADA', 'Este código ya se usó una vez.');
  if (!res.ok) throw new PeticionInvalida('E_RED', `El sitio respondió ${res.status}.`);

  const p = await res.json();
  const origen = u.origin;

  // El dominio que declara la respuesta tiene que ser el mismo del que se
  // descargó. Si no, alguien está reenviando la petición de otro sitio.
  if (!p?.domain || !origen.includes(String(p.domain).split(':')[0])) {
    throw new PeticionInvalida('E_DOMINIO', 'El sitio declara un dominio que no es el suyo.');
  }
  if (!p.request_id || !p.nonce || !p.action) {
    throw new PeticionInvalida('E_FORMATO', 'Al sitio le faltan datos en la petición.');
  }
  if (Number(p.expires_at) < Math.floor(Date.now() / 1000)) {
    throw new PeticionInvalida('E_EXPIRADA', 'Este código ya caducó.');
  }

  return { ...p, origen };
}

/**
 * Lo que se firma: separador de dominio + los campos que el usuario vio.
 *
 * No se firma el nonce a secas. La firma queda atada al dominio, la acción y
 * la cuenta concretos, así que no vale para autorizar ninguna otra cosa —
 * y lo que se muestra en pantalla es exactamente lo que se aprueba.
 */
export function retoDe(p: Peticion): string {
  const partes = [
    'sello/aprobacion/v2',
    p.domain,
    p.request_id,
    p.action,
    p.account ?? '',
    String(p.expires_at),
    p.nonce,
  ];
  // El separador 0x1f no aparece en texto normal, así que dos peticiones
  // distintas no pueden producir la misma cadena juntando campos.
  return bytesAB64(textoABytes(partes.join('\u001f')));
}

/** Aprueba: firma dentro del chip y entrega la respuesta al dominio. */
export async function aprobar(p: Peticion) {
  const { firmaDerB64, keyId } = await Signing.firmar(
    retoDe(p),
    p.action,
    p.domain,
  );
  await entregar(p, { type: 'approved', signature: firmaDerB64, key_id: keyId });
  return { firmaDerB64, keyId };
}

export async function rechazar(p: Peticion) {
  await entregar(p, { type: 'denied', reason: 'user_denied' }).catch(() => {});
}

async function entregar(p: Peticion, cuerpo: unknown) {
  const res = await conTope(
    fetch(`${p.origen}/respuesta/${p.request_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    }),
    TIEMPO_LIMITE_MS,
    'El sitio no respondió a tiempo.',
  );
  if (res.status === 409) throw new PeticionInvalida('E_USADA', 'El sitio ya recibió una respuesta.');
  if (res.status === 410) throw new PeticionInvalida('E_EXPIRADA', 'La petición caducó antes de enviarla.');
  if (!res.ok) throw new PeticionInvalida('E_RED', `El sitio no aceptó la respuesta (${res.status}).`);
}

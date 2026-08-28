import emisoresEmbebidos from '../emisores.json';

export type Emisor = { kid: string; alg: 'ES256' | 'EdDSA'; spkiB64: string; nombre: string };

/**
 * Emisores autorizados a firmar QR.
 *
 * La lista va compilada dentro de la app, no se descarga. Es deliberado:
 * la alternativa (confiar en el primer emisor que aparece) acepta sin
 * preguntar justo en el momento en que un suplantador atacaría, que es el
 * primer escaneo. Aquí un emisor desconocido se rechaza siempre.
 *
 * El coste es que añadir un emisor exige publicar versión. Con emisores
 * propios eso pasa cada varios años.
 *
 * Cuando hagan falta emisores de terceros, el paso siguiente no es TOFU
 * sino una lista firmada que se descargue y se verifique contra una clave
 * raíz embebida aquí.
 */
export function emisores(): Emisor[] {
  return emisoresEmbebidos as Emisor[];
}

/** Para la pantalla de dispositivo: cuántos emisores reconoce esta versión. */
export const cuantosEmisores = () => emisoresEmbebidos.length;

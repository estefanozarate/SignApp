const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function b64ABytes(b64: string): Uint8Array {
  const limpio = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const salida = new Uint8Array(Math.floor((limpio.length * 3) / 4));
  let acc = 0, bits = 0, i = 0;
  for (const ch of limpio) {
    acc = (acc << 6) | ALFABETO.indexOf(ch);
    bits += 6;
    if (bits >= 8) { bits -= 8; salida[i++] = (acc >> bits) & 0xff; }
  }
  return salida.subarray(0, i);
}

export const bytesAHex = (b: Uint8Array) =>
  Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** El reto agrupado en bloques de 2 bytes, para compararlo de un vistazo con el sitio. */
export function retoLegible(b64: string, maxBloques = 16) {
  const hex = bytesAHex(b64ABytes(b64));
  return (hex.match(/.{1,4}/g) ?? []).slice(0, maxBloques).join(' ');
}

/**
 * base64 → texto UTF-8, sin depender de atob ni TextDecoder (no están
 * disponibles en todos los entornos RN).
 *
 * Contrastado contra Buffer.from(...,'utf8') con acentos y emoji. Vivía
 * solo en services/peticion.ts; se movió aquí porque services/boveda.ts y
 * las pantallas que revelan secretos de la bóveda (§10.1) también lo
 * necesitan, y duplicarlo era la alternativa.
 */
export function textoDeB64(b64: string): string {
  const bytes = b64ABytes(b64);
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b < 0x80) s += String.fromCharCode(b);
    else if (b < 0xe0) s += String.fromCharCode(((b & 31) << 6) | (bytes[++i] & 63));
    else if (b < 0xf0) {
      s += String.fromCharCode(((b & 15) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63));
    } else {
      const cp = ((b & 7) << 18) | ((bytes[++i] & 63) << 12) | ((bytes[++i] & 63) << 6) | (bytes[++i] & 63);
      const u = cp - 0x10000;
      s += String.fromCharCode(0xd800 + (u >> 10), 0xdc00 + (u & 1023));
    }
  }
  return s;
}

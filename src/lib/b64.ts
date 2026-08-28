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

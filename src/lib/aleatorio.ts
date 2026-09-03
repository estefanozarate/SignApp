const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function bytesAB64(b: Uint8Array): string {
  let salida = '', i = 0;
  for (; i + 2 < b.length; i += 3) {
    const n = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2];
    salida += ALFABETO[(n >> 18) & 63] + ALFABETO[(n >> 12) & 63] +
              ALFABETO[(n >> 6) & 63] + ALFABETO[n & 63];
  }
  const resto = b.length - i;
  if (resto === 1) {
    const n = b[i] << 16;
    salida += ALFABETO[(n >> 18) & 63] + ALFABETO[(n >> 12) & 63] + '==';
  } else if (resto === 2) {
    const n = (b[i] << 16) | (b[i + 1] << 8);
    salida += ALFABETO[(n >> 18) & 63] + ALFABETO[(n >> 12) & 63] + ALFABETO[(n >> 6) & 63] + '=';
  }
  return salida;
}

/**
 * Reto aleatorio para la aprobación de prueba.
 *
 * Math.random NO es un CSPRNG. Aquí da igual: este reto solo sirve para
 * comprobar que el chip responde, nunca para autenticar nada. Los retos reales
 * los genera el sitio que pide la aprobación, no la app.
 */
export function retoDePrueba(bytes = 32): string {
  const b = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) b[i] = Math.floor(Math.random() * 256);
  return bytesAB64(b);
}

/**
 * UTF-8 a bytes. TextEncoder no está disponible en todos los entornos RN.
 *
 * Se contrastó byte a byte contra TextEncoder con acentos y emoji: si
 * difiriera, la app firmaría bytes distintos de los que el servidor verifica
 * y el fallo sería incomprensible.
 */
export function textoABytes(s: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c >= 0xd800 && c <= 0xdbff) {
      // par suplente: se combinan los dos code units en un solo punto
      const bajo = s.charCodeAt(++i);
      c = 0x10000 + ((c - 0xd800) << 10) + (bajo - 0xdc00);
      out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return Uint8Array.from(out);
}

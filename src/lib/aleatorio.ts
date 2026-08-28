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
 * Reto aleatorio para la firma de prueba.
 *
 * Math.random NO es un CSPRNG. Aquí da igual: este reto solo sirve para
 * comprobar que el chip firma, nunca para autenticar nada. Los retos reales
 * los genera el sitio que pide la aprobación, no la app.
 */
export function retoDePrueba(bytes = 32): string {
  const b = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) b[i] = Math.floor(Math.random() * 256);
  return bytesAB64(b);
}

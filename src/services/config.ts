/**
 * Sin backend: la identidad es local y no hay a quién registrarse.
 * Lo único que queda del servidor es el relay de signaling, y su URL
 * viene dentro del propio QR (claim "sgu"), no configurada aquí.
 */

/** Ventana máxima que se acepta entre la emisión del QR y el escaneo. */
export const VIGENCIA_MAX_QR_S = 300;

import { Identidad, Signing } from '../native/Signing';

/**
 * Toda la gestión de identidad, sin red.
 *
 * El teléfono es la cuenta: no hay registro ni sesión. La clave nace en el
 * Keystore la primera vez que se abre la app y no sale nunca de ahí.
 */

export async function tieneIdentidad(): Promise<boolean> {
  return Signing.tieneIdentidad();
}

export async function identidadActual(): Promise<Identidad | null> {
  return (await Signing.tieneIdentidad()) ? Signing.identidad() : null;
}

/** Crea la identidad si aún no existe; si ya existe, la devuelve tal cual. */
export async function asegurarIdentidad(): Promise<Identidad> {
  const actual = await identidadActual();
  return actual ?? Signing.crearIdentidad();
}

/**
 * Borra la clave del chip. Es irreversible y no hay copia en ningún sitio:
 * la identidad deja de existir.
 */
export async function eliminarIdentidad(): Promise<void> {
  await Signing.borrarIdentidad();
}

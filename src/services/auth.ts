import { Passkey } from '../native/Passkey';
import { Signing, Identidad } from '../native/Signing';
import { guardarToken, olvidarToken, pedir } from './api';

/**
 * Registro: passkey (Credential Manager) → token de sesión → identidad de
 * firma en el Keystore → alta de la clave pública en el backend.
 * Los dos secretos viven separados a propósito (Módulos A y B).
 */
export async function registrar(nombreUsuario: string) {
  const opciones = await pedir<{ publicKey: unknown }>('/webauthn/registro/opciones', {
    method: 'POST', body: JSON.stringify({ username: nombreUsuario }),
  });
  const credencial = await Passkey.registrar(opciones.publicKey);
  const { token } = await pedir<{ token: string }>('/webauthn/registro/verificar', {
    method: 'POST', body: JSON.stringify({ credential: credencial }),
  });
  await guardarToken(token);
  return emparejarDispositivo();
}

export async function iniciarSesion() {
  const opciones = await pedir<{ publicKey: unknown }>('/webauthn/login/opciones', { method: 'POST' });
  const aserción = await Passkey.autenticar(opciones.publicKey);
  const { token } = await pedir<{ token: string }>('/webauthn/login/verificar', {
    method: 'POST', body: JSON.stringify({ credential: aserción }),
  });
  await guardarToken(token);
  return (await Signing.tieneIdentidad()) ? Signing.identidad() : emparejarDispositivo();
}

/** Primer pairing: crea la clave en el chip y registra solo la parte pública. */
export async function emparejarDispositivo(): Promise<Identidad> {
  const id = await Signing.crearIdentidad();
  await pedir('/dispositivos', {
    method: 'POST',
    body: JSON.stringify({
      key_id: id.keyId,
      public_key: id.clavePublicaSpkiB64,
      alg: id.algoritmo,
      strongbox: id.strongBox,
      attestation: id.attestationB64, // el backend valida que salió de hardware real
    }),
  });
  return id;
}

/** Logout normal: cae la sesión, la identidad de firma se queda (Módulo E). */
export async function cerrarSesion() {
  try { await pedir('/sesion', { method: 'DELETE' }); } finally { await olvidarToken(); }
}

/** Logout duro: además borra la clave del Keystore. Irreversible. */
export async function eliminarDispositivo(keyId: string) {
  try { await pedir(`/dispositivos/${keyId}`, { method: 'DELETE' }); } finally {
    await Signing.borrarIdentidad();
    await olvidarToken();
  }
}

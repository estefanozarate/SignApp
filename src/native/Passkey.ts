import { NativeModules } from 'react-native';

/**
 * Puente a androidx.credentials (Credential Manager) — Módulo A.
 * Las opciones son el JSON WebAuthn tal cual lo emite tu backend (relying party).
 */
type PasskeyNative = {
  disponible(): Promise<boolean>;
  /** navigator.credentials.create() — devuelve el JSON de registro */
  registrar(opcionesJson: string): Promise<string>;
  /** navigator.credentials.get() — devuelve el JSON de aserción */
  autenticar(opcionesJson: string): Promise<string>;
};

const nativo = NativeModules.SelloPasskey as PasskeyNative;

export class PasskeyCancelada extends Error {}
export class SinPasskeys extends Error {}

function traducir(e: any): never {
  if (e?.code === 'E_USER_CANCELED') throw new PasskeyCancelada('Cancelado por el usuario.');
  if (e?.code === 'E_NO_CREDENTIAL') throw new SinPasskeys('No hay ninguna passkey de Sello en este dispositivo.');
  throw e;
}

export const Passkey = {
  disponible: () => nativo.disponible(),
  registrar: (o: unknown) => nativo.registrar(JSON.stringify(o)).catch(traducir).then(JSON.parse),
  autenticar: (o: unknown) => nativo.autenticar(JSON.stringify(o)).catch(traducir).then(JSON.parse),
};

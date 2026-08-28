import { NativeModules } from 'react-native';

/**
 * Puente al Keystore de Android (Módulo B de la arquitectura).
 * La clave privada nunca cruza este puente: solo salen firmas.
 */
type SigningNative = {
  /** ¿Existe ya una identidad de firma en este dispositivo? */
  tieneIdentidad(): Promise<boolean>;
  /**
   * Genera EC P-256 en AndroidKeyStore con:
   *   setUserAuthenticationRequired(true)
   *   setInvalidatedByBiometricEnrollment(true)
   *   PURPOSE_SIGN, no exportable, StrongBox si el equipo lo tiene.
   */
  crearIdentidad(): Promise<Identidad>;
  /** Metadatos públicos de la identidad ya creada. */
  identidad(): Promise<Identidad>;
  /**
   * Pide biometría con BiometricPrompt + CryptoObject y firma DENTRO del chip.
   * `retoB64` es el nonce del sitio; devuelve la firma DER en base64.
   */
  firmar(retoB64: string, titulo: string, subtitulo: string): Promise<Firma>;
  /** Borra la clave del Keystore. Irreversible. */
  borrarIdentidad(): Promise<void>;
};

export type Identidad = {
  keyId: string;               // UUID v4, VARCHAR(36) — identificador público
  clavePublicaSpkiB64: string; // SubjectPublicKeyInfo DER, base64
  algoritmo: 'ES256';
  strongBox: boolean;
  creadaEn: number;
  /** Cadena de key attestation para que el backend verifique el origen hardware. */
  attestationB64: string[];
};

export type Firma = { firmaDerB64: string; keyId: string };

export class ClaveInvalidada extends Error {}
export class BiometriaCancelada extends Error {}

const nativo = NativeModules.SelloSigning as SigningNative;

function traducir(e: any): never {
  if (e?.code === 'E_KEY_INVALIDATED') {
    throw new ClaveInvalidada('La biometría del dispositivo cambió; hay que crear la identidad de nuevo.');
  }
  if (e?.code === 'E_USER_CANCELED') throw new BiometriaCancelada('Cancelado por el usuario.');
  throw e;
}

export const Signing = {
  tieneIdentidad: () => nativo.tieneIdentidad(),
  identidad: () => nativo.identidad(),
  crearIdentidad: () => nativo.crearIdentidad().catch(traducir),
  firmar: (retoB64: string, titulo: string, subtitulo: string) =>
    nativo.firmar(retoB64, titulo, subtitulo).catch(traducir),
  borrarIdentidad: () => nativo.borrarIdentidad(),
};

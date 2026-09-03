import { NativeModules } from 'react-native';

/**
 * Puente al Keystore de Android (§3.1 y §10 de diseno_app.md).
 * Las claves privadas nunca cruzan este puente: solo salen firmas, claves
 * públicas y texto ya descifrado.
 */
type SigningNative = {
  /** ¿Existe ya una identidad de firma en este dispositivo? */
  tieneIdentidad(): Promise<boolean>;
  /**
   * Genera EC P-256 (firma) y RSA-2048 (descifrado) en AndroidKeyStore con:
   *   setUserAuthenticationRequired(true)
   *   setInvalidatedByBiometricEnrollment(true)
   *   no exportables, StrongBox si el equipo lo tiene.
   */
  crearIdentidad(): Promise<Identidad>;
  /** Metadatos públicos de la identidad ya creada. */
  identidad(): Promise<Identidad>;
  /**
   * Pide autenticación con BiometricPrompt + CryptoObject y firma DENTRO del
   * chip. `retoB64` es lo que se firma; devuelve la firma DER en base64.
   */
  firmar(retoB64: string, titulo: string, subtitulo: string): Promise<Firma>;
  /**
   * Descifra con la clave RSA del chip, tras autenticación del usuario.
   * Devuelve el claro en base64.
   */
  descifrar(cifradoB64: string, titulo: string, subtitulo: string): Promise<{ claroB64: string }>;
  /** Borra las claves del Keystore. Irreversible. */
  borrarIdentidad(): Promise<void>;
};

export type Identidad = {
  keyId: string;               // UUID v4 — el app_id del §3.1
  clavePublicaSpkiB64: string; // SubjectPublicKeyInfo DER, base64
  algoritmo: 'ES256';
  /** §10 — clave con la que el dominio cifra secretos para esta app. */
  clavePublicaCifradoSpkiB64?: string;
  algoritmoCifrado?: 'RSA-OAEP-256';
  strongBox: boolean;
  creadaEn: number;
  /** Cadena de key attestation para que un verificador compruebe el origen hardware. */
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
  descifrar: (cifradoB64: string, titulo: string, subtitulo: string) =>
    nativo.descifrar(cifradoB64, titulo, subtitulo).catch(traducir),
  borrarIdentidad: () => nativo.borrarIdentidad(),
};

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
   * §10 — abre un sobre cifrado híbrido dentro del chip, tras autenticación.
   * Ni la privada RSA ni la clave AES cruzan el puente: solo sale el claro.
   */
  abrirSobre(
    claveEnvueltaB64: string, ivB64: string, cifradoB64: string, tagB64: string,
    titulo: string, subtitulo: string,
  ): Promise<{ claroB64: string }>;
  /**
   * §14 — cierra un sobre cifrado para la clave pública del dominio. No pide
   * biometría: solo usa material público. Lo que exige autenticación es la
   * firma que va dentro.
   */
  cerrarSobre(clavePublicaSpkiB64: string, claroB64: string): Promise<Sobre>;
  /** Borra las claves del Keystore. Irreversible. */
  borrarIdentidad(): Promise<void>;
};

export type Identidad = {
  keyId: string;               // UUID v4 — el app_id del §3.1
  clavePublicaSpkiB64: string; // SubjectPublicKeyInfo DER, base64
  algoritmo: 'ES256';
  /** §10 — clave con la que el dominio cifra secretos para esta app. */
  clavePublicaCifradoSpkiB64?: string;
  /** MGF1 va con SHA-1 aunque el hash de OAEP sea SHA-256: el Keystore no admite otra cosa. */
  algoritmoCifrado?: 'RSA-OAEP-256-MGF1SHA1';
  /**
   * true: cada descifrado exige autenticación (§10 en su forma fuerte).
   * false: el equipo no tiene biometría fuerte y la clave usa una ventana de
   * validez de un segundo. Sigue exigiendo autenticación, pero no una por
   * operación.
   */
  cifradoPorOperacion?: boolean;
  strongBox: boolean;
  creadaEn: number;
  /** Cadena de key attestation para que un verificador compruebe el origen hardware. */
  attestationB64: string[];
};

export type Firma = { firmaDerB64: string; keyId: string };

/** §14 — sobre cifrado híbrido, tal y como sale del módulo nativo. */
export type Sobre = {
  alg: string;
  claveEnvueltaB64: string;
  ivB64: string;
  cifradoB64: string;
  tagB64: string;
};

export class ClaveInvalidada extends Error {}
/** GCM detectó que el dato llegó alterado: no se devuelve nada a medias. */
export class SecretoAlterado extends Error {}
export class BiometriaCancelada extends Error {}

const nativo = NativeModules.SelloSigning as SigningNative;

function traducir(e: any): never {
  if (e?.code === 'E_KEY_INVALIDATED') {
    throw new ClaveInvalidada('La biometría del dispositivo cambió; hay que crear la identidad de nuevo.');
  }
  if (e?.code === 'E_USER_CANCELED') throw new BiometriaCancelada('Cancelado por el usuario.');
  if (e?.code === 'E_ALTERADO') throw new SecretoAlterado('El secreto llegó alterado.');
  throw e;
}

export const Signing = {
  tieneIdentidad: () => nativo.tieneIdentidad(),
  identidad: () => nativo.identidad(),
  crearIdentidad: () => nativo.crearIdentidad().catch(traducir),
  firmar: (retoB64: string, titulo: string, subtitulo: string) =>
    nativo.firmar(retoB64, titulo, subtitulo).catch(traducir),
  abrirSobre: (
    claveEnvueltaB64: string, ivB64: string, cifradoB64: string, tagB64: string,
    titulo: string, subtitulo: string,
  ) => nativo.abrirSobre(claveEnvueltaB64, ivB64, cifradoB64, tagB64, titulo, subtitulo)
    .catch(traducir),
  cerrarSobre: (clavePublicaSpkiB64: string, claroB64: string) =>
    nativo.cerrarSobre(clavePublicaSpkiB64, claroB64).catch(traducir),
  borrarIdentidad: () => nativo.borrarIdentidad(),
};

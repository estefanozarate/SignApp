import { NativeModules } from 'react-native';

/**
 * Verificación del QR — Módulo C. Base45 → inflate → COSE_Sign1 → ECDSA/EdDSA.
 * Todo en Kotlin: no hay implementación JS de COSE en la que valga la pena confiar.
 */
type CoseNative = {
  /**
   * @param payload  contenido crudo del QR
   * @param trustListJson  [{ kid, alg, spkiB64 }] — lista firmada y cacheada
   * @param ahoraSegundos  reloj del dispositivo, para exp/nbf
   */
  verificarQr(payload: string, trustListJson: string, ahoraSegundos: number): Promise<ResultadoQr>;
};

export type ResultadoQr = {
  emisorKid: string;
  sessionId: string;
  origen: string;       // dominio que mostró el QR
  emitidoEn: number;
  expiraEn: number;
  signalingUrl: string;
};

export type FalloQr =
  | 'E_FORMATO'          // no es Base45/CBOR/COSE_Sign1 válido
  | 'E_EMISOR_DESCONOCIDO'
  | 'E_FIRMA'
  | 'E_EXPIRADO';

const nativo = NativeModules.SelloCose as CoseNative;

export const Cose = {
  verificarQr: (payload: string, trustList: unknown[]) =>
    nativo.verificarQr(payload, JSON.stringify(trustList), Math.floor(Date.now() / 1000)),
};

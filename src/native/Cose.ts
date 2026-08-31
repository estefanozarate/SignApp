import { NativeModules } from 'react-native';
import { Vinculo } from '../services/vinculos';

/**
 * Verificación del QR. Base45 → inflate → COSE_Sign1 → ECDSA.
 * Todo en Kotlin: no hay implementación JS de COSE en la que valga la pena confiar.
 */
type CoseNative = {
  verificarQr(payload: string, vinculosJson: string, ahoraSegundos: number): Promise<ResultadoQr>;
};

export type ResultadoQr = {
  /** "pair" propone vincular un navegador; "aprb" pide aprobar una acción. */
  tipo: 'pair' | 'aprb';
  kid: string;
  origen: string;
  sessionId: string;
  emitidoEn: number;
  expiraEn: number;
  signalingUrl?: string;
  /** SPKI del navegador, en base64. En "pair" viene dentro del propio QR. */
  clavePublicaB64: string;
  accion?: string;
  cuenta?: string;
  /** Lo que se firmará: separador de dominio + el payload verificado, tal cual. */
  retoB64: string;
};

export type FalloQr =
  | 'E_FORMATO'
  | 'E_NO_VINCULADO'
  | 'E_FIRMA'
  | 'E_EXPIRADO';

const nativo = NativeModules.SelloCose as CoseNative;

export const Cose = {
  verificarQr: (payload: string, vinculos: Vinculo[]) =>
    nativo.verificarQr(payload, JSON.stringify(vinculos), Math.floor(Date.now() / 1000)),
};

import { ResultadoQr } from '../native/Cose';

export type Rutas = {
  Bienvenida: undefined;
  Inicio: undefined;
  Escaner: undefined;
  NoVerificado: { motivo: string; kidDeclarado?: string; detalle?: string };
  Vincular: { qr: ResultadoQr };
  Aprobacion: { qr: ResultadoQr };
  Firmado: { firmaDerB64: string; keyId: string; origen: string };
  Dispositivo: undefined;
};

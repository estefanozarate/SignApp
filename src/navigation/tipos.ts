import { ResultadoQr } from '../native/Cose';
import { Solicitud } from '../services/aprobacion';

export type Rutas = {
  Bienvenida: undefined;
  Inicio: undefined;
  Escaner: undefined;
  NoVerificado: { motivo: string; kidDeclarado?: string };
  Aprobacion: { qr: ResultadoQr };
  Firmado: { firmaDerB64: string; keyId: string; origen: string };
  Dispositivo: undefined;
};

export type SolicitudPendiente = Solicitud;

import { Peticion } from '../services/peticion';

export type Rutas = {
  Bienvenida: undefined;
  Inicio: undefined;
  Escaner: undefined;
  NoVerificado: { motivo: string; detalle?: string };
  Aprobacion: { peticion: Peticion };
  Firmado: { firmaDerB64: string; keyId: string; origen: string };
  Dispositivo: undefined;
};

import { Peticion } from '../services/peticion';

export type Rutas = {
  Bienvenida: undefined;
  Inicio: undefined;
  Escaner: undefined;
  NoVerificado: { motivo: string; detalle?: string };
  Aprobacion: { peticion: Peticion };
  Firmado: {
    firmaDerB64: string;
    keyId: string;
    origen: string;
    proposito: 'PAIR' | 'SECRET_REQUEST';
    /** §10 — presente solo si el dominio entregó un secreto al emparejar. */
    secretoRecibido?: boolean;
    /** §14 — presente solo si la app devolvió el secreto y el dominio lo aceptó. */
    secretoEntregado?: boolean;
  };
  Boveda: undefined;
  Dispositivo: undefined;
};

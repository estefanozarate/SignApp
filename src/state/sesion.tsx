import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Identidad } from '../native/Signing';
import { identidadActual } from '../services/identidad';

/**
 * No hay sesión que mantener: o el teléfono tiene identidad de firma, o no.
 * Ese es todo el estado global de la app.
 */
type Estado = {
  cargando: boolean;
  identidad: Identidad | null;
  refrescar: () => Promise<void>;
};

const Ctx = createContext<Estado>(null as any);
export const useSesion = () => useContext(Ctx);

export function ProveedorSesion({ children }: { children: React.ReactNode }) {
  const [cargando, setCargando] = useState(true);
  const [identidad, setIdentidad] = useState<Identidad | null>(null);

  const refrescar = async () => {
    try {
      setIdentidad(await identidadActual());
    } catch {
      setIdentidad(null);
    } finally {
      setCargando(false);
    }
  };

  useEffect(() => { refrescar(); }, []);

  const valor = useMemo(() => ({ cargando, identidad, refrescar }), [cargando, identidad]);
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

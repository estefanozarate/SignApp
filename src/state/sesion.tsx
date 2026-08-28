import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Identidad, Signing } from '../native/Signing';
import { cargarToken } from '../services/api';

type Estado = {
  cargando: boolean;
  autenticado: boolean;
  identidad: Identidad | null;
  refrescar: () => Promise<void>;
  setAutenticado: (v: boolean) => void;
};

const Ctx = createContext<Estado>(null as any);
export const useSesion = () => useContext(Ctx);

export function ProveedorSesion({ children }: { children: React.ReactNode }) {
  const [cargando, setCargando] = useState(true);
  const [autenticado, setAutenticado] = useState(false);
  const [identidad, setIdentidad] = useState<Identidad | null>(null);

  const refrescar = async () => {
    const token = await cargarToken();
    setAutenticado(Boolean(token));
    setIdentidad((await Signing.tieneIdentidad()) ? await Signing.identidad() : null);
    setCargando(false);
  };

  useEffect(() => { refrescar(); }, []);

  const valor = useMemo(
    () => ({ cargando, autenticado, identidad, refrescar, setAutenticado }),
    [cargando, autenticado, identidad],
  );
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

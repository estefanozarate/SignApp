import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Registro local de aprobaciones. Sin servidor no hay historial remoto,
 * así que se guarda en el teléfono — y solo lo mínimo para que el usuario
 * reconozca lo que aprobó: nunca el reto ni la firma.
 */

export type Evento = {
  id: string;
  origen: string;
  accion: string;
  cuando: number;
  resultado: 'aprobado' | 'rechazado';
};

const CLAVE = 'sello.actividad';
const MAXIMO = 20;

export async function anotar(e: Omit<Evento, 'id' | 'cuando'>): Promise<void> {
  const previos = await listar();
  const evento: Evento = { ...e, id: String(Date.now()), cuando: Date.now() };
  const siguientes = [evento, ...previos].slice(0, MAXIMO);
  await AsyncStorage.setItem(CLAVE, JSON.stringify(siguientes));
}

export async function listar(): Promise<Evento[]> {
  try {
    const crudo = await AsyncStorage.getItem(CLAVE);
    return crudo ? (JSON.parse(crudo) as Evento[]) : [];
  } catch {
    return [];
  }
}

export async function olvidarActividad(): Promise<void> {
  await AsyncStorage.removeItem(CLAVE);
}

/** "Hoy, 8:12" / "Ayer, 19:40" / "12 ago, 9:05" */
export function cuandoLegible(ts: number): string {
  const d = new Date(ts);
  const hora = d.toLocaleTimeString('es-PE', { hour: '2-digit', minute: '2-digit' });
  const hoy = new Date();
  const ayer = new Date(hoy.getTime() - 86400000);
  const mismoDia = (a: Date, b: Date) => a.toDateString() === b.toDateString();

  if (mismoDia(d, hoy)) return `Hoy, ${hora}`;
  if (mismoDia(d, ayer)) return `Ayer, ${hora}`;
  return `${d.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })}, ${hora}`;
}

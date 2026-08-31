import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Navegadores vinculados a este teléfono.
 *
 * Sin servidor, el ancla de confianza es esta lista. Un QR de aprobación solo
 * se acepta si su clave Y su origen están aquí, así que un sitio que suplante
 * a otro no puede pedir nada: no está vinculado.
 *
 * La vinculación la autoriza el usuario una vez, viendo el origen en pantalla.
 * Es el único momento en que decide a quién cree.
 */
export type Vinculo = {
  kid: string;
  origen: string;
  spkiB64: string;
  /** Nombre del navegador/equipo, como lo declaró al vincularse. */
  nombre?: string;
  creadoEn: number;
  usadoEn?: number;
};

const CLAVE = 'sello.vinculos';

export async function vinculos(): Promise<Vinculo[]> {
  try {
    const crudo = await AsyncStorage.getItem(CLAVE);
    return crudo ? (JSON.parse(crudo) as Vinculo[]) : [];
  } catch {
    return [];
  }
}

/** Vincular de nuevo el mismo navegador reemplaza la entrada, no la duplica. */
export async function vincular(v: Omit<Vinculo, 'creadoEn'>): Promise<void> {
  const previos = (await vinculos()).filter(x => !(x.kid === v.kid && x.origen === v.origen));
  await AsyncStorage.setItem(
    CLAVE,
    JSON.stringify([{ ...v, creadoEn: Date.now() }, ...previos]),
  );
}

export async function marcarUso(kid: string, origen: string): Promise<void> {
  const lista = await vinculos();
  const i = lista.findIndex(x => x.kid === kid && x.origen === origen);
  if (i < 0) return;
  lista[i] = { ...lista[i], usadoEn: Date.now() };
  await AsyncStorage.setItem(CLAVE, JSON.stringify(lista));
}

export async function desvincular(kid: string, origen: string): Promise<void> {
  const lista = (await vinculos()).filter(x => !(x.kid === kid && x.origen === origen));
  await AsyncStorage.setItem(CLAVE, JSON.stringify(lista));
}

export async function olvidarVinculos(): Promise<void> {
  await AsyncStorage.removeItem(CLAVE);
}

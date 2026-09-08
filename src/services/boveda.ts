import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Bóveda de secretos ligados a la IDENTIDAD del dominio (§11, §16).
 *
 * La búsqueda es por domain_id, nunca por el nombre del dominio. El §16 lo
 * exige y el motivo es concreto: el nombre es una cadena que cualquiera puede
 * escribir, mientras que el domain_id se deriva de la clave pública del
 * dominio. Buscar por nombre dejaría que un sitio con el mismo nombre pero
 * otra clave reclamara un secreto ajeno.
 *
 * Lo que se guarda aquí ya está EN CLARO: salió del chip descifrado. Es un
 * cambio de riesgo respecto al resto de la app, donde nada secreto se
 * almacenaba. Se asume porque es lo que el protocolo pide, pero conviene
 * tenerlo presente.
 */
export type SecretoGuardado = {
  /** §16 — la identidad del dominio, derivada de su clave pública. */
  domain_id: string;
  /** El nombre solo se guarda para mostrarlo; nunca para decidir. */
  domain: string;
  domain_public_key: string;
  secreto: string;
  recibidoEn: number;
};

const CLAVE = 'sello.boveda';

async function todos(): Promise<SecretoGuardado[]> {
  try {
    const crudo = await AsyncStorage.getItem(CLAVE);
    return crudo ? (JSON.parse(crudo) as SecretoGuardado[]) : [];
  } catch {
    return [];
  }
}

export async function guardar(s: Omit<SecretoGuardado, 'recibidoEn'>): Promise<void> {
  // Un secreto nuevo de la misma identidad sustituye al anterior: son el mismo
  // dato, no dos. Guardar los dos dejaría uno obsoleto sin forma de saber cuál.
  const previos = (await todos()).filter(x => x.domain_id !== s.domain_id);
  await AsyncStorage.setItem(
    CLAVE,
    JSON.stringify([{ ...s, recibidoEn: Date.now() }, ...previos]),
  );
}

export const secretos = todos;

/**
 * §13 — el emparejamiento crítico. Se compara la identidad completa, no solo
 * el identificador: si el dominio presentara el mismo domain_id con otra clave
 * pública, no sería el mismo dominio.
 */
export async function paraDominio(
  domainId: string, domainPublicKey: string,
): Promise<SecretoGuardado | undefined> {
  const s = (await todos()).find(x => x.domain_id === domainId);
  if (!s) return undefined;
  if (s.domain_public_key !== domainPublicKey) return undefined;
  return s;
}

export async function olvidarDominio(domainId: string): Promise<void> {
  await AsyncStorage.setItem(
    CLAVE,
    JSON.stringify((await todos()).filter(x => x.domain_id !== domainId)),
  );
}

export async function vaciarBoveda(): Promise<void> {
  await AsyncStorage.removeItem(CLAVE);
}

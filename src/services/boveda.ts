import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SobreBoveda } from '../native/Signing';

/**
 * Bóveda de secretos ligados a la IDENTIDAD del dominio (§11, §16).
 *
 * La búsqueda es por domain_id, nunca por el nombre del dominio. El §16 lo
 * exige y el motivo es concreto: el nombre es una cadena que cualquiera puede
 * escribir, mientras que el domain_id se deriva de la clave pública del
 * dominio. Buscar por nombre dejaría que un sitio con el mismo nombre pero
 * otra clave reclamara un secreto ajeno.
 *
 * §10.1 — lo que se guarda aquí YA NO está en claro. El §11 pide
 * `encrypted_secret`, y hasta esta corrección se guardaba el secreto tal
 * cual salía del chip. Ahora se guarda su `sobre`: el resultado de
 * Signing.cifrarEnBoveda(), cifrado con la clave AES-GCM `sello.boveda.v1`
 * del Keystore. Leerlo exige autenticar() + Signing.descifrarDeBoveda(); ver
 * services/peticion.ts (entregarSecreto) y screens/Boveda.tsx.
 *
 * Los metadatos del dominio (domain, domain_id, domain_public_key) siguen en
 * claro a propósito: el §13 necesita compararlos para decidir si rechaza una
 * petición, y eso no debe exigirle un PIN a quien solo está mirando si el
 * sitio tiene algo guardado.
 */
export type SecretoGuardado = {
  /** §16 — la identidad del dominio, derivada de su clave pública. */
  domain_id: string;
  /** El nombre solo se guarda para mostrarlo; nunca para decidir. */
  domain: string;
  domain_public_key: string;
  /** §10.1/§11 — el secreto cifrado con la clave de la bóveda; nunca en claro. */
  sobre: SobreBoveda;
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

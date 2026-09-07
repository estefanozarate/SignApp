import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * Bóveda de secretos, uno por dominio (§10, §16).
 *
 * Lo que se guarda aquí ya está EN CLARO: salió del chip descifrado. Eso es
 * un cambio de riesgo respecto al resto de la app, donde nada secreto se
 * almacenaba nunca. Se asume a propósito, porque es lo que el protocolo
 * pide, pero conviene tenerlo presente: un teléfono comprometido antes no
 * filtraba nada y ahora filtraría estos secretos.
 *
 * AsyncStorage en Android va a un fichero privado de la app, que otras apps
 * no pueden leer sin root. No es el Keystore: es almacenamiento de la app.
 */
export type SecretoGuardado = {
  domain: string;
  domain_id: string;
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
  // Un secreto nuevo del mismo dominio sustituye al anterior: son el mismo
  // dato, no dos. Guardar los dos dejaría uno obsoleto sin forma de saber cuál.
  const previos = (await todos()).filter(x => x.domain !== s.domain);
  await AsyncStorage.setItem(
    CLAVE,
    JSON.stringify([{ ...s, recibidoEn: Date.now() }, ...previos]),
  );
}

export const secretos = todos;

export async function deDominio(domain: string): Promise<SecretoGuardado | undefined> {
  return (await todos()).find(x => x.domain === domain);
}

export async function olvidarDominio(domain: string): Promise<void> {
  await AsyncStorage.setItem(CLAVE, JSON.stringify((await todos()).filter(x => x.domain !== domain)));
}

export async function vaciarBoveda(): Promise<void> {
  await AsyncStorage.removeItem(CLAVE);
}

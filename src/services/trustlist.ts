import AsyncStorage from '@react-native-async-storage/async-storage';

export type Emisor = { kid: string; alg: 'ES256' | 'EdDSA'; spkiB64: string; nombre: string };

const CLAVE = 'sello.trustlist';

/**
 * Emisores autorizados a firmar QR.
 *
 * Sin backend no hay lista que descargar. Este módulo ya no toca la red: lee
 * lo que haya guardado en el dispositivo. Cómo entran ahí los emisores (lista
 * embebida en la app o confianza al primer uso) se decide en el commit 4;
 * mientras tanto la lista está vacía y todo QR se rechaza con
 * E_EMISOR_DESCONOCIDO, que es el fallo seguro correcto.
 */
export async function emisores(): Promise<Emisor[]> {
  try {
    const crudo = await AsyncStorage.getItem(CLAVE);
    return crudo ? (JSON.parse(crudo) as Emisor[]) : [];
  } catch {
    return [];
  }
}

export async function guardarEmisores(lista: Emisor[]): Promise<void> {
  await AsyncStorage.setItem(CLAVE, JSON.stringify(lista));
}

export async function olvidarEmisores(): Promise<void> {
  await AsyncStorage.removeItem(CLAVE);
}

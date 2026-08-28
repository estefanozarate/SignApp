import AsyncStorage from '@react-native-async-storage/async-storage';
import { pedir } from './api';

export type Emisor = { kid: string; alg: 'ES256' | 'EdDSA'; spkiB64: string; nombre: string };

const CLAVE = 'sello.trustlist';
const VIGENCIA_MS = 6 * 60 * 60 * 1000;

type Cache = { emisores: Emisor[]; traidaEn: number };

/**
 * La lista de emisores se cachea para poder verificar el QR sin red
 * (nota transversal 3 de la arquitectura). Viene firmada por el backend;
 * el módulo nativo comprueba esa firma antes de aceptarla.
 */
export async function emisores(forzar = false): Promise<Emisor[]> {
  const crudo = await AsyncStorage.getItem(CLAVE);
  const cache: Cache | null = crudo ? JSON.parse(crudo) : null;
  const fresca = cache && Date.now() - cache.traidaEn < VIGENCIA_MS;
  if (fresca && !forzar) return cache!.emisores;

  try {
    const { issuers } = await pedir<{ issuers: Emisor[] }>('/trust-list');
    await AsyncStorage.setItem(CLAVE, JSON.stringify({ emisores: issuers, traidaEn: Date.now() }));
    return issuers;
  } catch (e) {
    if (cache) return cache.emisores; // sin red, seguimos con lo cacheado
    throw e;
  }
}

export async function actualizadaHace(): Promise<number | null> {
  const crudo = await AsyncStorage.getItem(CLAVE);
  if (!crudo) return null;
  return Date.now() - (JSON.parse(crudo) as Cache).traidaEn;
}

export async function olvidarLista() { await AsyncStorage.removeItem(CLAVE); }

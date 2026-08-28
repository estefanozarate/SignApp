import AsyncStorage from '@react-native-async-storage/async-storage';
import { API } from './config';

const CLAVE_TOKEN = 'sello.sesion';
let token: string | null = null;

export async function cargarToken() {
  token = await AsyncStorage.getItem(CLAVE_TOKEN);
  return token;
}
export async function guardarToken(t: string) {
  token = t;
  await AsyncStorage.setItem(CLAVE_TOKEN, t);
}
export async function olvidarToken() {
  token = null;
  await AsyncStorage.removeItem(CLAVE_TOKEN);
}
export const tokenActual = () => token;

export class ErrorApi extends Error {
  constructor(public estado: number, public codigo: string, mensaje: string) { super(mensaje); }
}

export async function pedir<T>(ruta: string, opciones: RequestInit = {}): Promise<T> {
  const r = await fetch(API + ruta, {
    ...opciones,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opciones.headers ?? {}),
    },
  });
  const texto = await r.text();
  const cuerpo = texto ? JSON.parse(texto) : {};
  if (!r.ok) throw new ErrorApi(r.status, cuerpo.code ?? 'E_DESCONOCIDO', cuerpo.message ?? 'Falló la petición');
  return cuerpo as T;
}

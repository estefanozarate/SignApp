import { Platform, TextStyle } from 'react-native';

/** Tokens del prototipo. Un solo sitio para cambiar la identidad visual. */
export const color = {
  tinta: '#101821',
  hueso: '#E7E9E3',
  papel: '#FBFBF8',
  intaglio: '#0E5548',
  carmin: '#96263F',
  ambar: '#8E6412',
  grafito: '#5C6670',
  linea: 'rgba(16,24,33,0.13)',
  lineaFuerte: 'rgba(16,24,33,0.24)',
  huesoTenue: 'rgba(231,233,227,0.62)',
  velo: 'rgba(6,10,14,0.55)',
} as const;

export const radio = { s: 10, m: 14, l: 20, pill: 999 } as const;
export const espacio = { xs: 4, s: 8, m: 14, l: 24, xl: 32 } as const;

/**
 * Pon los .ttf en assets/fonts, corre `npx react-native-asset`
 * y cambia esto a true. Ver README §5.
 */
export const FUENTES_INSTALADAS = false;
const f = (nombre: string) => (FUENTES_INSTALADAS ? { fontFamily: nombre } : {});

export const tipo = {
  display: { ...f('BodoniModa-Regular'), fontSize: 38, lineHeight: 41, letterSpacing: -0.4, color: color.tinta } as TextStyle,
  h2: { ...f('BodoniModa-Regular'), fontSize: 26, lineHeight: 30, color: color.tinta } as TextStyle,
  origen: { ...f('BodoniModa-Medium'), fontSize: 29, lineHeight: 32, color: color.tinta } as TextStyle,
  wordmark: { ...f('BodoniModa-Medium'), fontSize: 19, letterSpacing: 2.6, color: color.tinta } as TextStyle,
  cuerpo: { ...f('IBMPlexSans-Regular'), fontSize: 14.5, lineHeight: 22, color: color.grafito } as TextStyle,
  etiqueta: { ...f('IBMPlexSans-SemiBold'), fontSize: 15, color: color.tinta } as TextStyle,
  dato: { ...f('IBMPlexSans-Medium'), fontSize: 13.5, color: color.tinta } as TextStyle,
  ceja: { ...f('IBMPlexMono-Regular'), fontSize: 10.5, letterSpacing: 1.7, textTransform: 'uppercase', color: color.grafito } as TextStyle,
  mono: { ...f('IBMPlexMono-Regular'), fontSize: 12, color: color.tinta } as TextStyle,
  minima: { ...f('IBMPlexSans-Regular'), fontSize: 11.5, lineHeight: 17, color: color.grafito } as TextStyle,
};

export const sombra = Platform.select({ android: { elevation: 3 }, default: {} });

import React from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, TextStyle, View, ViewStyle,
} from 'react-native';
import { color, espacio, radio, tipo } from '../theme';

/* ── texto ─────────────────────────────────────────────────── */
type TProps = { style?: TextStyle | TextStyle[]; children: React.ReactNode; numberOfLines?: number };
const mk = (base: TextStyle) => ({ style, children, numberOfLines }: TProps) => (
  <Text style={[base, style]} numberOfLines={numberOfLines}>{children}</Text>
);
export const Display = mk(tipo.display);
export const H2 = mk(tipo.h2);
export const Origen = mk(tipo.origen);
export const Cuerpo = mk(tipo.cuerpo);
export const Ceja = mk(tipo.ceja);
export const Mono = mk(tipo.mono);
export const Minima = mk(tipo.minima);
export const Dato = mk(tipo.dato);

/* ── botón ─────────────────────────────────────────────────── */
type BtnProps = {
  children: React.ReactNode;
  onPress: () => void;
  variante?: 'solido' | 'fantasma' | 'peligro' | 'claro';
  cargando?: boolean;
  deshabilitado?: boolean;
  icono?: React.ReactNode;
  style?: ViewStyle;
};

export function Boton({
  children, onPress, variante = 'solido', cargando, deshabilitado, icono, style,
}: BtnProps) {
  const inactivo = deshabilitado || cargando;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={inactivo}
      onPress={onPress}
      android_ripple={{ color: 'rgba(255,255,255,0.14)' }}
      style={({ pressed }) => [
        s.btn, s[variante],
        pressed && { transform: [{ scale: 0.985 }] },
        inactivo && { opacity: 0.55 },
        style,
      ]}>
      {cargando
        ? <ActivityIndicator color={variante === 'solido' ? '#F4F6F2' : color.tinta} />
        : <>
            {icono}
            <Text style={[s.btnTexto, textoDe(variante)]}>{children}</Text>
          </>}
    </Pressable>
  );
}

const textoDe = (v: BtnProps['variante']): TextStyle => {
  switch (v) {
    case 'peligro': return { color: color.carmin };
    case 'fantasma': return { color: color.tinta, fontWeight: '500' };
    case 'claro': return { color: color.tinta };
    default: return { color: '#F4F6F2' };
  }
};

/* ── píldora de estado ─────────────────────────────────────── */
export function Pildora({ estado, children }: { estado: 'ok' | 'mal' | 'esp'; children: React.ReactNode }) {
  const c = estado === 'ok' ? color.intaglio : estado === 'mal' ? color.carmin : color.ambar;
  return (
    <View style={[s.pildora, { backgroundColor: c + '1A' }]}>
      <View style={[s.punto, { backgroundColor: c }]} />
      <Text style={[s.pildoraTexto, { color: c }]}>{children}</Text>
    </View>
  );
}

/* ── tarjeta y filas de datos ──────────────────────────────── */
export function Tarjeta({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[s.tarjeta, style]}>{children}</View>;
}

export function Fila({ etiqueta, children, primera }: {
  etiqueta: string; children: React.ReactNode; primera?: boolean;
}) {
  return (
    <View style={[s.fila, !primera && s.filaBorde]}>
      <Text style={s.filaEtiqueta}>{etiqueta}</Text>
      <View style={s.filaValor}>
        {typeof children === 'string' ? <Text style={tipo.dato}>{children}</Text> : children}
      </View>
    </View>
  );
}

export const Regla = () => <View style={s.regla} />;

const s = StyleSheet.create({
  btn: {
    height: 54, borderRadius: radio.m, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'center', gap: 9, overflow: 'hidden',
  },
  btnTexto: { ...tipo.etiqueta, fontWeight: '600' },
  solido: { backgroundColor: color.intaglio },
  claro: { backgroundColor: color.hueso },
  fantasma: { borderWidth: 1, borderColor: color.lineaFuerte },
  peligro: { borderWidth: 1, borderColor: 'rgba(150,38,63,0.4)' },

  pildora: {
    flexDirection: 'row', alignItems: 'center', gap: 6, height: 26,
    paddingHorizontal: 11, borderRadius: radio.pill, alignSelf: 'flex-start',
  },
  punto: { width: 6, height: 6, borderRadius: 3 },
  pildoraTexto: { fontSize: 11.5, fontWeight: '600' },

  tarjeta: {
    backgroundColor: color.papel, borderRadius: radio.l,
    borderWidth: 1, borderColor: color.linea, paddingHorizontal: espacio.l,
  },
  fila: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 16, paddingVertical: 13,
  },
  filaBorde: { borderTopWidth: 1, borderTopColor: color.linea },
  filaEtiqueta: { ...tipo.cuerpo, fontSize: 12.5 },
  filaValor: { flexShrink: 1, alignItems: 'flex-end' },
  regla: { height: 1, backgroundColor: color.linea, marginVertical: espacio.l },
});

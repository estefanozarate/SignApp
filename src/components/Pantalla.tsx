import React from 'react';
import { StatusBar, StyleSheet, View, ViewStyle } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { color } from '../theme';

export default function Pantalla({ oscura, style, children, sinBorde }: {
  oscura?: boolean; style?: ViewStyle; children: React.ReactNode; sinBorde?: boolean;
}) {
  return (
    // El style va también a la raíz: es la que pinta el fondo, y sin esto
    // no había forma de hacer una pantalla transparente sobre la cámara.
    <View style={[s.raiz, { backgroundColor: oscura ? color.tinta : color.hueso }, style]}>
      {/* RN 0.87 dibuja edge-to-edge: la barra ya no lleva color de fondo. */}
      <StatusBar barStyle={oscura ? 'light-content' : 'dark-content'} />
      {sinBorde
        ? <>{children}</>
        : <SafeAreaView style={s.area} edges={['top', 'bottom']}>{children}</SafeAreaView>}
    </View>
  );
}

const s = StyleSheet.create({ raiz: { flex: 1 }, area: { flex: 1 } });

import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import Pantalla from '../components/Pantalla';
import { Boton, Cuerpo, Fila, H2, Mono, Tarjeta } from '../components/ui';
import { Alerta, Cerrar } from '../components/Iconos';
import { color, espacio, tipo } from '../theme';
import { Text } from 'react-native';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'NoVerificado'>;

const TEXTOS: Record<string, { titulo: string; cuerpo: string }> = {
  E_NO_VINCULADO: {
    titulo: 'Este navegador no está vinculado a tu teléfono.',
    cuerpo: 'Solo los navegadores que vinculaste pueden pedirte aprobaciones. Si es tuyo, vincúlalo primero desde el sitio. No se abrió ninguna conexión y no se aprobó nada.',
  },
  E_FIRMA: {
    titulo: 'Este código fue alterado.',
    cuerpo: 'Su contenido no coincide con lo que el sitio emitió. No se abrió ninguna conexión y no se aprobó nada.',
  },
  E_EXPIRADO: {
    titulo: 'Este código ya caducó.',
    cuerpo: 'Los códigos duran poco a propósito. Recarga la página del sitio para que genere uno nuevo.',
  },
  E_FORMATO: {
    titulo: 'Este código no es de Sello.',
    cuerpo: 'Se leyó un QR, pero no tiene el formato que usa Sello. Asegúrate de escanear el que muestra el sitio.',
  },
};

export default function NoVerificado({ navigation, route }: Props) {
  const { motivo, kidDeclarado } = route.params;
  const t = TEXTOS[motivo] ?? TEXTOS.E_FORMATO;

  return (
    <Pantalla>
      <View style={s.appbar}>
        <Pressable onPress={() => navigation.navigate('Inicio')} style={s.iconbtn} accessibilityLabel="Cerrar">
          <Cerrar />
        </Pressable>
      </View>

      <View style={s.cuerpo}>
        <Alerta />
        <H2 style={{ marginTop: 20 }}>{t.titulo}</H2>
        <Cuerpo style={{ marginTop: 12, marginBottom: 20 }}>{t.cuerpo}</Cuerpo>

        {kidDeclarado ? (
          <Tarjeta>
            <Fila etiqueta="Navegador" primera>
              <Mono>{kidDeclarado.slice(0, 4)}··{kidDeclarado.slice(-4)}</Mono>
            </Fila>
            <Fila etiqueta="Vinculado">
              <Text style={[tipo.dato, { color: color.carmin }]}>No aparece</Text>
            </Fila>
          </Tarjeta>
        ) : null}
      </View>

      <View style={s.acciones}>
        <Boton onPress={() => navigation.replace('Escaner')}>Escanear otro código</Boton>
        <Boton variante="fantasma" onPress={() => navigation.navigate('Inicio')}>Volver al inicio</Boton>
      </View>
    </Pantalla>
  );
}

const s = StyleSheet.create({
  appbar: { height: 56, alignItems: 'flex-end', paddingRight: espacio.m, justifyContent: 'center' },
  iconbtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  cuerpo: { flex: 1, justifyContent: 'center', paddingHorizontal: espacio.l, paddingBottom: 40 },
  acciones: { gap: 10, paddingHorizontal: espacio.l, paddingTop: 16, paddingBottom: 30 },
});

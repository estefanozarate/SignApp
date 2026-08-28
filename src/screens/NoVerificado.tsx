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
  E_EMISOR_DESCONOCIDO: {
    titulo: 'Este código no está firmado por un emisor autorizado.',
    cuerpo: 'Puede haber sido alterado o venir de un sitio que suplanta a otro. No se abrió ninguna conexión y no se firmó nada.',
  },
  E_FIRMA: {
    titulo: 'La firma de este código no cuadra.',
    cuerpo: 'El contenido cambió después de firmarse. No se abrió ninguna conexión y no se firmó nada.',
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
            <Fila etiqueta="Emisor declarado" primera>
              <Mono>{kidDeclarado.slice(0, 4)}··{kidDeclarado.slice(-4)}</Mono>
            </Fila>
            <Fila etiqueta="En tu lista de confianza">
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

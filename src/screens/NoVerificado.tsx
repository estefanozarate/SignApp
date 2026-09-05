import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import Pantalla from '../components/Pantalla';
import { Boton, Cuerpo, H2 } from '../components/ui';
import { Alerta, Cerrar } from '../components/Iconos';
import { color, espacio, tipo } from '../theme';
import { Text } from 'react-native';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'NoVerificado'>;

const TEXTOS: Record<string, { titulo: string; cuerpo: string }> = {
  E_VERSION: {
    titulo: 'Este código es de otra versión.',
    cuerpo: 'Actualiza Sello, o pide al sitio un código nuevo.',
  },
  E_DOMINIO: {
    titulo: 'El sitio no es quien dice ser.',
    cuerpo: 'Lo que respondió no coincide con lo que decía el código. No se aprobó nada.',
  },
  E_NONCE: {
    titulo: 'La respuesta del sitio no cuadra.',
    cuerpo: 'El dominio devolvió un valor distinto del que llevaba el código. Podría haber alguien interponiéndose. No se aprobó nada.',
  },
  E_PROPOSITO: {
    titulo: 'El sitio cambió lo que pedía.',
    cuerpo: 'El código pedía una cosa y el dominio respondió sobre otra. No se aprobó nada.',
  },
  E_NO_AUTORIZADA: {
    titulo: 'El sitio no autorizó esta petición.',
    cuerpo: 'Puede que la hayan cancelado. Pide un código nuevo.',
  },
  E_NO_EXISTE: {
    titulo: 'Esta petición ya no existe.',
    cuerpo: 'El sitio no la reconoce. Puede que la hayan cancelado o que el código sea de otro sitio.',
  },
  E_USADA: {
    titulo: 'Esta petición ya se usó.',
    cuerpo: 'Cada código sirve una sola vez. Si no fuiste tú quien la usó, avisa al sitio.',
  },
  E_EXPIRADA: {
    titulo: 'Este código ya caducó.',
    cuerpo: 'Los códigos duran poco a propósito. Recarga la página del sitio para que genere uno nuevo.',
  },
  E_RED: {
    titulo: 'No se pudo hablar con el sitio.',
    cuerpo: 'Comprueba tu conexión e inténtalo otra vez. No se aprobó nada.',
  },
  E_FORMATO: {
    titulo: 'Este código no es de Sello.',
    cuerpo: 'Se leyó un QR, pero no tiene el formato que usa Sello. Asegúrate de escanear el que muestra el sitio.',
  },
};

export default function NoVerificado({ navigation, route }: Props) {
  const { motivo, detalle } = route.params;
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

        {/* El detalle concreto, cuando aporta algo que el texto general no
            dice. Se compara contra título Y cuerpo: antes solo miraba el
            cuerpo y el mensaje salía repetido bajo su propio título. */}
        {detalle && !t.cuerpo.includes(detalle) && !t.titulo.includes(detalle) ? (
          <View style={s.detalle}>
            <Text style={[tipo.mono, { color: color.grafito, lineHeight: 18 }]}>{detalle}</Text>
          </View>
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
  detalle: {
    backgroundColor: 'rgba(16,24,33,0.045)', borderRadius: 10,
    padding: 12, marginBottom: 20,
  },
  appbar: { height: 56, alignItems: 'flex-end', paddingRight: espacio.m, justifyContent: 'center' },
  iconbtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  cuerpo: { flex: 1, justifyContent: 'center', paddingHorizontal: espacio.l, paddingBottom: 40 },
  acciones: { gap: 10, paddingHorizontal: espacio.l, paddingTop: 16, paddingBottom: 30 },
});

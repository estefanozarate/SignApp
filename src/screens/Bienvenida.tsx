import React, { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import Pantalla from '../components/Pantalla';
import Rosette from '../components/Rosette';
import { Boton, Cuerpo, Display, Ceja } from '../components/ui';
import { HERO } from '../lib/guilloche';
import { color, espacio, tipo } from '../theme';
import { iniciarSesion, registrar } from '../services/auth';
import { PasskeyCancelada, SinPasskeys } from '../native/Passkey';
import { useSesion } from '../state/sesion';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Bienvenida'>;

export default function Bienvenida(_: Props) {
  const { refrescar } = useSesion();
  const [ocupado, setOcupado] = useState<'crear' | 'entrar' | null>(null);

  const correr = async (cual: 'crear' | 'entrar') => {
    setOcupado(cual);
    try {
      // El nombre real vendría de un campo previo; aquí el backend lo resuelve.
      cual === 'crear' ? await registrar('estefano') : await iniciarSesion();
      await refrescar();
    } catch (e) {
      if (e instanceof PasskeyCancelada) return;
      if (e instanceof SinPasskeys) {
        Alert.alert('Sin passkeys aquí', 'Este teléfono no tiene ninguna passkey de Sello. Crea una identidad nueva.');
        return;
      }
      Alert.alert('No se pudo continuar', (e as Error).message);
    } finally {
      setOcupado(null);
    }
  };

  return (
    <Pantalla oscura style={s.raiz}>
      <View style={s.hero} pointerEvents="none">
        <Rosette anillos={HERO} tamano={393} />
      </View>

      <View style={s.pie}>
        <Ceja style={{ color: color.huesoTenue, marginBottom: 16 }}>Identidad del dispositivo</Ceja>
        <Display style={{ color: color.hueso, marginBottom: 14 }}>
          Tu firma vive{'\n'}en este teléfono.
        </Display>
        <Cuerpo style={{ color: color.huesoTenue, maxWidth: 300, marginBottom: 26 }}>
          Se crea dentro del chip seguro y no puede salir de él. Cada vez que apruebas algo, firmas con tu rostro.
        </Cuerpo>

        <Boton variante="claro" cargando={ocupado === 'crear'} onPress={() => correr('crear')}>
          Crear identidad
        </Boton>
        <Boton
          variante="fantasma"
          style={{ borderColor: 'rgba(231,233,227,0.22)', marginTop: 10 }}
          cargando={ocupado === 'entrar'}
          onPress={() => correr('entrar')}>
          <Cuerpo style={{ ...tipo.etiqueta, color: color.hueso }}>Ya tengo una cuenta</Cuerpo>
        </Boton>
      </View>
    </Pantalla>
  );
}

const s = StyleSheet.create({
  raiz: { justifyContent: 'flex-end' },
  hero: { position: 'absolute', top: 34, alignSelf: 'center' },
  pie: { paddingHorizontal: espacio.l, paddingBottom: 34 },
});

import React, { useState } from 'react';
import { Alert, StyleSheet, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import Pantalla from '../components/Pantalla';
import Rosette from '../components/Rosette';
import { Boton, Ceja, Cuerpo, Display, Minima } from '../components/ui';
import { HERO } from '../lib/guilloche';
import { color, espacio } from '../theme';
import { asegurarIdentidad } from '../services/identidad';
import { BiometriaCancelada } from '../native/Signing';
import { useSesion } from '../state/sesion';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Bienvenida'>;

export default function Bienvenida(_: Props) {
  const { refrescar } = useSesion();
  const [ocupado, setOcupado] = useState(false);

  const crear = async () => {
    setOcupado(true);
    try {
      await asegurarIdentidad();
      await refrescar();
    } catch (e: any) {
      if (e instanceof BiometriaCancelada) return;
      if (e?.code === 'E_SIN_BLOQUEO') {
        // El módulo nativo ya distingue el motivo; aquí solo se muestra.
        Alert.alert('Falta bloqueo de pantalla', e.message);
        return;
      }
      Alert.alert('No se pudo crear la identidad', e?.message ?? 'Error desconocido.');
    } finally {
      setOcupado(false);
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
          Se crea dentro del chip seguro y no puede salir de él. Para usarla te pedirá tu
          huella o el PIN del dispositivo. No hay cuenta ni contraseña: este teléfono es la identidad.
        </Cuerpo>

        <Boton variante="claro" cargando={ocupado} onPress={crear}>
          Crear identidad
        </Boton>

        {/* Sin copia de seguridad posible: hay que decirlo antes, no después. */}
        <Minima style={{ color: color.huesoTenue, marginTop: 14, textAlign: 'center' }}>
          La clave no se puede copiar ni respaldar. Si pierdes el teléfono, tendrás que crear
          una identidad nueva.
        </Minima>
      </View>
    </Pantalla>
  );
}

const s = StyleSheet.create({
  raiz: { justifyContent: 'flex-end' },
  hero: { position: 'absolute', top: 34, alignSelf: 'center' },
  pie: { paddingHorizontal: espacio.l, paddingBottom: 34 },
});

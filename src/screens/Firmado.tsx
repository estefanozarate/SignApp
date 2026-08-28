import React, { useEffect, useRef } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import Pantalla from '../components/Pantalla';
import Rosette from '../components/Rosette';
import { Boton, Cuerpo, H2 } from '../components/ui';
import { Check } from '../components/Iconos';
import { SELLO } from '../lib/guilloche';
import { color, espacio, tipo } from '../theme';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Firmado'>;

export default function Firmado({ navigation, route }: Props) {
  const { firmaDerB64, keyId, origen } = route.params;
  const aparece = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(aparece, { toValue: 1, duration: 500, delay: 350, useNativeDriver: true }).start();
  }, [aparece]);

  const corto = (v: string) => `${v.slice(0, 4)}··${v.slice(-4)}`;

  return (
    <Pantalla>
      <View style={s.cuerpo}>
        {/* La roseta se detiene: el sello quedó puesto. */}
        <Rosette anillos={SELLO} tamano={252} quieta>
          <Animated.View style={{ opacity: aparece, transform: [{ scale: aparece }] }}>
            <Check size={38} color={color.intaglio} />
          </Animated.View>
        </Rosette>

        <Animated.View style={[s.texto, { opacity: aparece }]}>
          <H2 style={{ marginBottom: 8 }}>Aprobado</H2>
          <Cuerpo style={{ textAlign: 'center', maxWidth: 270, marginBottom: 18 }}>
            Ya puedes volver a la pantalla de {origen}. La sesión se abrió allí.
          </Cuerpo>
          <Text style={[tipo.mono, { color: color.grafito }]}>
            firma {corto(firmaDerB64)} · clave {corto(keyId)}
          </Text>
        </Animated.View>
      </View>

      <View style={s.acciones}>
        <Boton variante="fantasma" onPress={() => navigation.navigate('Inicio')}>Listo</Boton>
      </View>
    </Pantalla>
  );
}

const s = StyleSheet.create({
  cuerpo: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: espacio.l },
  texto: { alignItems: 'center', marginTop: -6 },
  acciones: { paddingHorizontal: espacio.l, paddingBottom: 30 },
});

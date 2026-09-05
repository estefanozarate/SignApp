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
  const { firmaDerB64, origen, proposito } = route.params;
  const vinculado = proposito === 'PAIR';
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
          {/* Vincular un dispositivo y aprobar una acción no son lo mismo:
              lo primero crea una relación duradera, lo segundo autoriza algo
              concreto. La pantalla debería decir cuál de las dos ocurrió. */}
          <H2 style={{ marginBottom: 8 }}>{vinculado ? 'Dispositivo vinculado' : 'Aprobado'}</H2>
          <Cuerpo style={{ textAlign: 'center', maxWidth: 280, marginBottom: 18 }}>
            {vinculado
              ? `${origen} ya reconoce este teléfono. A partir de ahora podrá pedirte aprobaciones.`
              : `Ya puedes volver a la pantalla de ${origen}. Tu aprobación llegó allí.`}
          </Cuerpo>
          <Text style={[tipo.mono, { color: color.grafito }]}>
            comprobante {corto(firmaDerB64)}
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

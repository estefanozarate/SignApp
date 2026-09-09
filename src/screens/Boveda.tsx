import React, { useCallback, useState } from 'react';
import { Alert, LayoutAnimation, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import Pantalla from '../components/Pantalla';
import { Boton, Ceja, Minima, Tarjeta } from '../components/ui';
import { Atras } from '../components/Iconos';
import { color, espacio, radio, tipo } from '../theme';
import { olvidarDominio, SecretoGuardado, secretos } from '../services/boveda';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Boveda'>;

export default function Boveda({ navigation }: Props) {
  const [lista, setLista] = useState<SecretoGuardado[]>([]);
  const [visibles, setVisibles] = useState<string[]>([]);

  const recargar = useCallback(() => { secretos().then(setLista); }, []);
  useFocusEffect(recargar);

  /**
   * Los secretos no se muestran de entrada. No es teatro: evita que queden
   * a la vista de quien mire la pantalla por encima del hombro, y obliga a
   * un gesto deliberado para revelarlos.
   */
  const alternar = (domainId: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setVisibles(v => (v.includes(domainId) ? v.filter(d => d !== domainId) : [...v, domainId]));
  };

  const olvidar = (s: SecretoGuardado) => {
    Alert.alert(
      `¿Olvidar el secreto de ${s.domain}?`,
      'Se borra de este teléfono. Si lo necesitas otra vez tendrás que pedírselo al sitio.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Olvidar',
          style: 'destructive',
          onPress: async () => { await olvidarDominio(s.domain_id); recargar(); },
        },
      ],
    );
  };

  return (
    <Pantalla>
      <View style={s.appbar}>
        <Pressable onPress={() => navigation.goBack()} style={s.iconbtn} accessibilityLabel="Volver">
          <Atras />
        </Pressable>
        <Text style={tipo.etiqueta}>Tus secretos</Text>
      </View>

      <ScrollView contentContainerStyle={s.cuerpo} showsVerticalScrollIndicator={false}>
        {lista.length === 0 ? (
          <Minima style={{ paddingVertical: 20 }}>
            Todavía no has recibido ningún secreto. Cuando un sitio te entregue uno, aparecerá aquí.
          </Minima>
        ) : (
          lista.map(s2 => {
            // La clave de la lista es la identidad, no el nombre: dos dominios
            // pueden mostrarse con el mismo texto y no ser el mismo.
            const visible = visibles.includes(s2.domain_id);
            return (
              <Tarjeta key={s2.domain_id} style={{ marginBottom: 12 }}>
                <Ceja style={{ marginBottom: 8 }}>{s2.domain}</Ceja>

                <Pressable onPress={() => alternar(s2.domain_id)} style={s.valor}>
                  <Text style={[tipo.mono, { color: visible ? color.tinta : color.grafito }]}>
                    {visible ? s2.secreto : '·'.repeat(Math.min(28, s2.secreto.length))}
                  </Text>
                </Pressable>

                <View style={s.pie}>
                  <Minima>
                    {new Date(s2.recibidoEn).toLocaleDateString('es-PE', {
                      day: 'numeric', month: 'short', year: 'numeric',
                    })}
                  </Minima>
                  <Pressable onPress={() => alternar(s2.domain_id)}>
                    <Minima style={{ color: color.intaglio, textDecorationLine: 'underline' }}>
                      {visible ? 'Ocultar' : 'Mostrar'}
                    </Minima>
                  </Pressable>
                </View>

                <Boton
                  variante="fantasma"
                  style={{ marginTop: 12 }}
                  onPress={() => olvidar(s2)}>
                  Olvidar este secreto
                </Boton>
              </Tarjeta>
            );
          })
        )}

        <Minima style={{ marginTop: 14 }}>
          Estos secretos se guardan en el almacenamiento privado de la app, ya descifrados.
          A diferencia de tu identidad, no están dentro del chip seguro.
        </Minima>
        <View style={{ height: 30 }} />
      </ScrollView>
    </Pantalla>
  );
}

const s = StyleSheet.create({
  appbar: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: espacio.m },
  iconbtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  cuerpo: { paddingHorizontal: espacio.l },
  valor: { backgroundColor: 'rgba(16,24,33,0.045)', borderRadius: radio.s, padding: 12 },
  pie: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 10 },
});

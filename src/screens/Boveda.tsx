import React, { useCallback, useState } from 'react';
import { Alert, LayoutAnimation, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import Pantalla from '../components/Pantalla';
import { Boton, Ceja, Minima, Tarjeta } from '../components/ui';
import { Atras } from '../components/Iconos';
import { color, espacio, radio, tipo } from '../theme';
import { olvidarDominio, SecretoGuardado, secretos } from '../services/boveda';
import { BiometriaCancelada, Signing } from '../native/Signing';
import { textoDeB64 } from '../lib/b64';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Boveda'>;

export default function Boveda({ navigation }: Props) {
  const [lista, setLista] = useState<SecretoGuardado[]>([]);
  const [visibles, setVisibles] = useState<string[]>([]);
  // §10.1 — el claro solo vive aquí, en memoria, mientras la tarjeta está
  // abierta. Nunca se guarda descifrado; al ocultar se olvida y hay que
  // volver a autenticar para verlo otra vez.
  const [claros, setClaros] = useState<Record<string, string>>({});
  const [cargando, setCargando] = useState<string | null>(null);

  const recargar = useCallback(() => { secretos().then(setLista); }, []);
  useFocusEffect(recargar);

  /**
   * §10.1, punto 6 — revelar un secreto pide autenticación de verdad. Antes
   * este gesto solo alternaba un booleano local; ahora, la primera vez que
   * se pide ver un secreto, hay que pasar por autenticar() y descifrarlo de
   * la bóveda. Ocultarlo no requiere nada, pero borra el claro de memoria:
   * volver a mostrarlo vuelve a pedir autenticación.
   */
  const alternar = async (s: SecretoGuardado) => {
    if (visibles.includes(s.domain_id)) {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setVisibles(v => v.filter(d => d !== s.domain_id));
      setClaros(c => {
        const resto = { ...c };
        delete resto[s.domain_id];
        return resto;
      });
      return;
    }

    setCargando(s.domain_id);
    try {
      await Signing.autenticar('Revelar tu secreto', s.domain);
      const { claroB64 } = await Signing.descifrarDeBoveda(
        s.sobre.ivB64, s.sobre.cifradoB64, s.sobre.tagB64,
      );
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setClaros(c => ({ ...c, [s.domain_id]: textoDeB64(claroB64) }));
      setVisibles(v => [...v, s.domain_id]);
    } catch (e: any) {
      if (e instanceof BiometriaCancelada) return;
      Alert.alert('No se pudo revelar', e?.message ?? 'Error desconocido.');
    } finally {
      setCargando(null);
    }
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

                <Pressable onPress={() => alternar(s2)} style={s.valor}>
                  <Text style={[tipo.mono, { color: visible ? color.tinta : color.grafito }]}>
                    {visible ? claros[s2.domain_id] ?? '' : '·'.repeat(24)}
                  </Text>
                </Pressable>

                <View style={s.pie}>
                  <Minima>
                    {new Date(s2.recibidoEn).toLocaleDateString('es-PE', {
                      day: 'numeric', month: 'short', year: 'numeric',
                    })}
                  </Minima>
                  <Pressable onPress={() => alternar(s2)} disabled={cargando === s2.domain_id}>
                    <Minima style={{ color: color.intaglio, textDecorationLine: 'underline' }}>
                      {cargando === s2.domain_id ? 'Comprobando…' : visible ? 'Ocultar' : 'Mostrar'}
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
          Estos secretos se guardan cifrados en el almacenamiento privado de la app, con una
          clave que vive en el chip seguro y exige tu PIN o tu huella para leerlos.
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

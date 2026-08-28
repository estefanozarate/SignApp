import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import Pantalla from '../components/Pantalla';
import Rosette from '../components/Rosette';
import { Boton, Ceja, Minima, Pildora } from '../components/ui';
import { Candado, Escanear, Telefono } from '../components/Iconos';
import { EMBLEMA } from '../lib/guilloche';
import { color, espacio, tipo } from '../theme';
import { useSesion } from '../state/sesion';
import { cuandoLegible, Evento, listar } from '../services/actividad';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Inicio'>;

export default function Inicio({ navigation }: Props) {
  const { identidad } = useSesion();
  const [actividad, setActividad] = useState<Evento[]>([]);

  // El historial es local: no hay servidor al que preguntarle.
  useFocusEffect(useCallback(() => { listar().then(setActividad); }, []));

  const corto = identidad ? `${identidad.keyId.slice(0, 4)}··${identidad.keyId.slice(-4)}` : '····';

  return (
    <Pantalla>
      <View style={s.appbar}>
        <Text style={tipo.wordmark}>SELLO</Text>
        <Pressable
          accessibilityLabel="Este dispositivo"
          accessibilityRole="button"
          onPress={() => navigation.navigate('Dispositivo')}
          style={s.iconbtn}>
          <Telefono />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={s.cuerpo} showsVerticalScrollIndicator={false}>
        <View style={s.emblema}>
          <Rosette anillos={EMBLEMA} tamano={250}>
            <Candado />
            <Text style={[tipo.mono, { fontSize: 11, marginTop: 6 }]}>{corto}</Text>
          </Rosette>
        </View>

        <View style={s.estado}>
          <Pildora estado={identidad ? 'ok' : 'esp'}>
            {identidad ? 'Clave activa' : 'Sin identidad'}
          </Pildora>
          <Minima style={{ textAlign: 'center', maxWidth: 250, marginTop: 9 }}>
            Protegida por el hardware del teléfono. Pide tu rostro en cada firma.
          </Minima>
        </View>

        <Boton onPress={() => navigation.navigate('Escaner')} icono={<Escanear />}>
          Escanear código
        </Boton>

        <Ceja style={{ marginTop: 32, marginBottom: 4 }}>Últimas aprobaciones</Ceja>
        {actividad.length === 0 ? (
          <Minima style={{ paddingVertical: 14 }}>
            Todavía no has aprobado nada. Cuando un sitio te muestre un código, escánealo desde aquí.
          </Minima>
        ) : (
          actividad.map((e, i) => (
            <View key={e.id} style={[s.evento, i > 0 && s.eventoBorde]}>
              <View style={[s.marca, {
                backgroundColor: e.resultado === 'aprobado' ? color.intaglio : color.carmin,
              }]} />
              <View style={{ flex: 1 }}>
                <Text style={tipo.dato}>{e.accion} · {e.origen}</Text>
                <Text style={[tipo.minima, { marginTop: 2 }]}>
                  {cuandoLegible(e.cuando)} · {e.resultado === 'aprobado' ? 'Aprobado' : 'Rechazado por ti'}
                </Text>
              </View>
            </View>
          ))
        )}
        <View style={{ height: 28 }} />
      </ScrollView>
    </Pantalla>
  );
}

const s = StyleSheet.create({
  appbar: {
    height: 56, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingLeft: espacio.l, paddingRight: espacio.m,
  },
  iconbtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  cuerpo: { paddingHorizontal: espacio.l },
  emblema: { alignItems: 'center', paddingTop: 6 },
  estado: { alignItems: 'center', marginTop: 2, marginBottom: 26 },
  evento: { flexDirection: 'row', gap: 12, alignItems: 'flex-start', paddingVertical: 12 },
  eventoBorde: { borderTopWidth: 1, borderTopColor: color.linea },
  marca: { width: 7, height: 7, borderRadius: 4, marginTop: 6 },
});

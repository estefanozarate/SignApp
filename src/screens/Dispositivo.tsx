import React, { useCallback, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import Pantalla from '../components/Pantalla';
import { Boton, Ceja, Cuerpo, Fila, H2, Minima, Mono, Regla, Tarjeta } from '../components/ui';
import { Atras } from '../components/Iconos';
import { color, espacio, radio, tipo } from '../theme';
import { useSesion } from '../state/sesion';
import { cerrarSesion, eliminarDispositivo } from '../services/auth';
import { actualizadaHace, emisores, olvidarLista } from '../services/trustlist';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Dispositivo'>;

export default function Dispositivo({ navigation }: Props) {
  const { identidad, refrescar } = useSesion();
  const [listaHace, setListaHace] = useState<number | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [borrando, setBorrando] = useState(false);

  useFocusEffect(useCallback(() => { actualizadaHace().then(setListaHace); }, []));

  const refrescarLista = async () => {
    try {
      await emisores(true);
      setListaHace(await actualizadaHace());
    } catch {
      Alert.alert('Sin conexión', 'Seguirás usando la lista guardada hasta que vuelva la red.');
    }
  };

  const salir = async () => {
    await cerrarSesion();
    await refrescar();
  };

  const eliminar = async () => {
    if (!identidad) return;
    setBorrando(true);
    try {
      await eliminarDispositivo(identidad.keyId);
      await olvidarLista();
      setConfirmando(false);
      await refrescar();
    } catch (e) {
      Alert.alert('No se pudo eliminar', (e as Error).message);
    } finally {
      setBorrando(false);
    }
  };

  return (
    <Pantalla>
      <View style={s.appbar}>
        <Pressable onPress={() => navigation.goBack()} style={s.iconbtn} accessibilityLabel="Volver">
          <Atras />
        </Pressable>
        <Text style={tipo.etiqueta}>Este dispositivo</Text>
      </View>

      <ScrollView contentContainerStyle={s.cuerpo} showsVerticalScrollIndicator={false}>
        <Tarjeta style={{ marginBottom: 22 }}>
          <Fila etiqueta="Clave de firma" primera>
            <Mono>{identidad ? `${identidad.keyId.slice(0, 8)}··${identidad.keyId.slice(-4)}` : '—'}</Mono>
          </Fila>
          <Fila etiqueta="Creada">
            {identidad ? new Date(identidad.creadaEn).toLocaleDateString('es-PE', {
              day: 'numeric', month: 'short', year: 'numeric',
            }) : '—'}
          </Fila>
          <Fila etiqueta="Protección">
            {identidad?.strongBox ? 'StrongBox + rostro' : 'Hardware + rostro'}
          </Fila>
          <Fila etiqueta="Emisores de confianza">
            {listaHace === null ? 'Sin descargar' : `Al día · hace ${Math.round(listaHace / 60000)} min`}
          </Fila>
        </Tarjeta>
        <Pressable onPress={refrescarLista} style={{ marginTop: -12, marginBottom: 22 }}>
          <Minima style={{ color: color.intaglio, textDecorationLine: 'underline' }}>
            Actualizar la lista de emisores
          </Minima>
        </Pressable>

        <Ceja style={{ marginBottom: 10 }}>Sesión</Ceja>
        <Boton variante="fantasma" onPress={salir}>Cerrar sesión</Boton>
        <Minima style={{ marginTop: 10 }}>
          Sales de la app. Tu clave de firma se queda en el teléfono, así que la próxima vez solo necesitas tu rostro.
        </Minima>

        <Regla />

        <Ceja style={{ marginBottom: 10 }}>Retirar el dispositivo</Ceja>
        <Boton variante="peligro" deshabilitado={!identidad} onPress={() => setConfirmando(true)}>
          Eliminar esta identidad
        </Boton>
        <Minima style={{ marginTop: 10 }}>
          Borra la clave del chip seguro y desvincula el teléfono. Es permanente: para volver a aprobar desde aquí,
          tendrás que crear una identidad nueva.
        </Minima>
        <View style={{ height: 30 }} />
      </ScrollView>

      <Modal transparent visible={confirmando} animationType="fade" onRequestClose={() => setConfirmando(false)}>
        <Pressable style={s.velo} onPress={() => setConfirmando(false)} />
        <View style={s.dialogo}>
          <H2 style={{ fontSize: 22, marginBottom: 10 }}>¿Eliminar esta identidad?</H2>
          <Cuerpo style={{ marginBottom: 20 }}>
            La clave se borra del chip seguro y no se puede recuperar. Las sesiones que aprobaste seguirán siendo
            válidas hasta que caduquen.
          </Cuerpo>
          <Boton variante="peligro" cargando={borrando} onPress={eliminar}>Sí, eliminar</Boton>
          <Boton variante="fantasma" style={{ marginTop: 8 }} onPress={() => setConfirmando(false)}>Cancelar</Boton>
        </View>
      </Modal>
    </Pantalla>
  );
}

const s = StyleSheet.create({
  appbar: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: espacio.m },
  iconbtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  cuerpo: { paddingHorizontal: espacio.l },
  velo: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: color.velo },
  dialogo: {
    position: 'absolute', left: espacio.l, right: espacio.l, top: '32%',
    backgroundColor: color.papel, borderRadius: radio.l, padding: espacio.l,
  },
});

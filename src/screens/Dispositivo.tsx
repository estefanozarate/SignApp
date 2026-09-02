import React, { useCallback, useState } from 'react';
import { Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useFocusEffect } from '@react-navigation/native';
import Pantalla from '../components/Pantalla';
import { Boton, Ceja, Cuerpo, Fila, H2, Minima, Mono, Tarjeta } from '../components/ui';
import { Atras } from '../components/Iconos';
import { color, espacio, radio, tipo } from '../theme';
import { useSesion } from '../state/sesion';
import { eliminarIdentidad } from '../services/identidad';
import { BiometriaCancelada, ClaveInvalidada, Signing } from '../native/Signing';
import { retoDePrueba } from '../lib/aleatorio';
import { olvidarActividad } from '../services/actividad';
import { olvidarVinculos, vinculos } from '../services/vinculos';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Dispositivo'>;

export default function Dispositivo({ navigation }: Props) {
  const { identidad, refrescar } = useSesion();
  const [confirmando, setConfirmando] = useState(false);
  const [borrando, setBorrando] = useState(false);
  const [firmando, setFirmando] = useState(false);
  const [prueba, setPrueba] = useState<{ reto: string; firma: string } | null>(null);
  const [cuantos, setCuantos] = useState(0);

  useFocusEffect(useCallback(() => { vinculos().then(v => setCuantos(v.length)); }, []));

  /**
   * Aprobación de prueba: recorre de punta a punta la cadena del chip —
   * prompt del sistema, operación dentro del hardware, y el caso de
   * cancelación. No sale nada del teléfono; el reto se genera aquí mismo.
   */
  const firmarPrueba = async () => {
    setFirmando(true);
    setPrueba(null);
    try {
      const reto = retoDePrueba();
      const { firmaDerB64 } = await Signing.firmar(
        reto,
        'Aprobación de prueba',
        'Solo para comprobar que el chip responde',
      );
      setPrueba({ reto, firma: firmaDerB64 });
    } catch (e: any) {
      if (e instanceof BiometriaCancelada) return;
      if (e instanceof ClaveInvalidada) {
        Alert.alert(
          'Hay que crear la identidad de nuevo',
          'La biometría del dispositivo cambió, así que la identidad anterior dejó de ser válida.',
        );
        return;
      }
      Alert.alert('No se pudo completar', e?.message ?? 'Error desconocido.');
    } finally {
      setFirmando(false);
    }
  };

  const eliminar = async () => {
    setBorrando(true);
    try {
      await eliminarIdentidad();
      await olvidarActividad();
      await olvidarVinculos();
      setConfirmando(false);
      await refrescar();
    } catch (e: any) {
      Alert.alert('No se pudo eliminar', e?.message ?? 'Error desconocido.');
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
        <Tarjeta style={{ marginBottom: 14 }}>
          <Fila etiqueta="Identidad" primera>
            <Mono>{identidad ? `${identidad.keyId.slice(0, 8)}··${identidad.keyId.slice(-4)}` : '—'}</Mono>
          </Fila>
          <Fila etiqueta="Creada">
            {identidad
              ? new Date(identidad.creadaEn).toLocaleDateString('es-PE', {
                  day: 'numeric', month: 'short', year: 'numeric',
                })
              : '—'}
          </Fila>
          <Fila etiqueta="Protección">
            {identidad?.strongBox ? 'StrongBox + biometría' : 'Hardware + biometría'}
          </Fila>
          <Fila etiqueta="Algoritmo">{identidad?.algoritmo ?? '—'}</Fila>
          <Fila etiqueta="Navegadores vinculados">{`${cuantos}`}</Fila>
        </Tarjeta>

        <Minima style={{ marginBottom: 30 }}>
          La identidad se generó en este teléfono y nunca sale de él. No hay servidor donde
          esté registrada, ni copia que se pueda restaurar.
        </Minima>

        <Ceja style={{ marginBottom: 10 }}>Comprobar la identidad</Ceja>
        <Boton variante="fantasma" cargando={firmando} deshabilitado={!identidad} onPress={firmarPrueba}>
          Hacer una aprobación de prueba
        </Boton>
        {prueba ? (
          <Tarjeta style={{ marginTop: 12 }}>
            <Fila etiqueta="Petición" primera>
              <Mono>{corto(prueba.reto)}</Mono>
            </Fila>
            <Fila etiqueta="Comprobante">
              <Mono>{corto(prueba.firma)}</Mono>
            </Fila>
          </Tarjeta>
        ) : null}
        <Minima style={{ marginTop: 10, marginBottom: 30 }}>
          Genera una petición local y la aprueba dentro del chip. Nada sale del dispositivo:
          sirve para confirmar que la identidad sigue viva y que pide tu huella o tu PIN.
        </Minima>

        <Ceja style={{ marginBottom: 10 }}>Retirar el dispositivo</Ceja>
        <Boton variante="peligro" deshabilitado={!identidad} onPress={() => setConfirmando(true)}>
          Eliminar esta identidad
        </Boton>
        <Minima style={{ marginTop: 10 }}>
          Borra la identidad del chip seguro junto con el historial y los navegadores vinculados. Es permanente:
          para volver a aprobar desde aquí, tendrás que crear una identidad nueva.
        </Minima>
        <View style={{ height: 30 }} />
      </ScrollView>

      <Modal transparent visible={confirmando} animationType="fade" onRequestClose={() => setConfirmando(false)}>
        <Pressable style={s.velo} onPress={() => setConfirmando(false)} />
        <View style={s.dialogo}>
          <H2 style={{ fontSize: 22, marginBottom: 10 }}>¿Eliminar esta identidad?</H2>
          <Cuerpo style={{ marginBottom: 20 }}>
            La identidad se borra del chip seguro y no se puede recuperar. Lo que ya aprobaste
            seguirá siendo válido hasta que caduque.
          </Cuerpo>
          <Boton variante="peligro" cargando={borrando} onPress={eliminar}>Sí, eliminar</Boton>
          <Boton variante="fantasma" style={{ marginTop: 8 }} onPress={() => setConfirmando(false)}>
            Cancelar
          </Boton>
        </View>
      </Modal>
    </Pantalla>
  );
}

const corto = (v: string) => `${v.slice(0, 8)}··${v.slice(-6)}`;

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

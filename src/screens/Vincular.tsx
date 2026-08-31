import React, { useEffect, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import Pantalla from '../components/Pantalla';
import { Boton, Ceja, Cuerpo, Fila, Minima, Mono, Origen, Pildora, Tarjeta } from '../components/ui';
import { Cerrar } from '../components/Iconos';
import { color, espacio } from '../theme';
import { CanalNavegador } from '../services/aprobacion';
import { vincular } from '../services/vinculos';
import { useSesion } from '../state/sesion';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Vincular'>;

/**
 * Vinculación de un navegador.
 *
 * Es la única decisión de confianza de todo el sistema: a partir de aquí,
 * este navegador podrá pedirte aprobaciones y ninguno más. Por eso la
 * pantalla es distinta de la de aprobar y dice explícitamente qué implica.
 */
export default function Vincular({ navigation, route }: Props) {
  const { qr } = route.params;
  const { identidad } = useSesion();
  const canal = useRef<CanalNavegador | null>(null);
  const [estado, setEstado] = useState<'conectando' | 'listo' | 'cerrado'>('conectando');
  const [enviando, setEnviando] = useState(false);

  useEffect(() => {
    if (!qr.signalingUrl) return;
    const c = new CanalNavegador(qr.signalingUrl, qr.sessionId, {
      onEstado: setEstado,
      onError: (e: Error) => {
        Alert.alert('Se cortó la conexión', e.message);
        navigation.navigate('Inicio');
      },
    });
    canal.current = c;
    c.conectar();
    return () => c.cerrar();
  }, [qr, navigation]);

  const aceptar = async () => {
    if (!identidad) return;
    setEnviando(true);
    try {
      // Se guarda primero: si la red falla, el vínculo ya vale para el
      // próximo intento y el usuario no repite la decisión.
      await vincular({
        kid: qr.kid,
        origen: qr.origen,
        spkiB64: qr.clavePublicaB64,
        nombre: qr.accion,
      });
      await canal.current?.vincular(
        identidad.clavePublicaSpkiB64,
        identidad.keyId,
        'Sello Android',
      );
      navigation.navigate('Inicio');
    } catch (e: any) {
      Alert.alert('No se pudo vincular', e?.message ?? 'Error desconocido.');
    } finally {
      setEnviando(false);
    }
  };

  const rechazar = () => {
    canal.current?.rechazar();
    navigation.navigate('Inicio');
  };

  return (
    <Pantalla>
      <View style={s.appbar}>
        <Pildora estado={estado === 'listo' ? 'ok' : 'esp'}>
          {estado === 'listo' ? 'Canal cifrado con el sitio' : 'Conectando con el sitio'}
        </Pildora>
        <Pressable onPress={rechazar} style={s.iconbtn} accessibilityLabel="Cerrar">
          <Cerrar />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={s.cuerpo} showsVerticalScrollIndicator={false}>
        <Ceja style={{ marginBottom: 10 }}>Quiere vincularse con tu teléfono</Ceja>
        <Origen style={{ marginBottom: 6 }}>{qr.origen}</Origen>
        <Cuerpo style={{ marginBottom: 22 }}>
          Si aceptas, este navegador podrá pedirte aprobaciones desde ahora. Ningún otro podrá.
        </Cuerpo>

        <Tarjeta style={{ marginBottom: 14 }}>
          <Fila etiqueta="Huella del navegador" primera>
            <Mono>{qr.kid.replace(/(.{4})/g, '$1 ').trim()}</Mono>
          </Fila>
          <Fila etiqueta="Tu clave">
            <Mono>{identidad ? `${identidad.keyId.slice(0, 8)}··${identidad.keyId.slice(-4)}` : '—'}</Mono>
          </Fila>
        </Tarjeta>

        <Minima style={{ marginBottom: 26 }}>
          Compara la huella con la que muestra la pantalla del sitio. Si no coincide, no aceptes:
          alguien podría estar interponiéndose.{'\n\n'}
          Se envía tu clave pública, que no es un secreto. Tu clave privada no sale del chip.
        </Minima>
      </ScrollView>

      <View style={s.acciones}>
        <Boton onPress={aceptar} cargando={enviando} deshabilitado={!identidad}>
          Vincular este navegador
        </Boton>
        <Boton variante="peligro" onPress={rechazar}>No vincular</Boton>
      </View>
    </Pantalla>
  );
}

const s = StyleSheet.create({
  appbar: {
    height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingLeft: espacio.l, paddingRight: espacio.m,
  },
  iconbtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  cuerpo: { paddingHorizontal: espacio.l },
  acciones: {
    gap: 10, paddingHorizontal: espacio.l, paddingTop: 16, paddingBottom: 30,
    borderTopWidth: 1, borderTopColor: color.linea,
  },
});

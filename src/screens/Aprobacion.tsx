import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import Pantalla from '../components/Pantalla';
import { Boton, Ceja, Cuerpo, Fila, Minima, Origen, Pildora, Tarjeta } from '../components/ui';
import { Cerrar, Check } from '../components/Iconos';
import { color, espacio, radio, tipo } from '../theme';
import { CanalNavegador } from '../services/aprobacion';
import { BiometriaCancelada, ClaveInvalidada } from '../native/Signing';
import { marcarUso } from '../services/vinculos';
import { anotar } from '../services/actividad';
import { retoLegible } from '../lib/b64';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Aprobacion'>;

export default function Aprobacion({ navigation, route }: Props) {
  const { qr } = route.params;
  const canal = useRef<CanalNavegador | null>(null);
  const [estado, setEstado] = useState<'conectando' | 'listo' | 'cerrado'>('conectando');
  const [firmando, setFirmando] = useState(false);
  const [restante, setRestante] = useState(qr.expiraEn - Math.floor(Date.now() / 1000));

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

  // La caducidad la fija el QR firmado; al llegar a cero no se aprueba nada.
  useEffect(() => {
    const t = setInterval(() => {
      const quedan = qr.expiraEn - Math.floor(Date.now() / 1000);
      setRestante(quedan);
      if (quedan <= 0) {
        clearInterval(t);
        canal.current?.rechazar('expired');
        navigation.replace('NoVerificado', { motivo: 'E_EXPIRADO' });
      }
    }, 1000);
    return () => clearInterval(t);
  }, [qr, navigation]);

  const reloj = useMemo(() => {
    const q = Math.max(0, restante);
    return `${Math.floor(q / 60)}:${String(q % 60).padStart(2, '0')}`;
  }, [restante]);

  const aprobar = async () => {
    setFirmando(true);
    try {
      const accion = qr.accion ?? 'Aprobar una acción';
      const { firmaDerB64, keyId } = await canal.current!.aprobar(qr.retoB64, accion, qr.origen);
      await marcarUso(qr.kid, qr.origen);
      await anotar({ origen: qr.origen, accion, resultado: 'aprobado' });
      navigation.replace('Firmado', { firmaDerB64, keyId, origen: qr.origen });
    } catch (e: any) {
      if (e instanceof BiometriaCancelada) return; // puede reintentar
      if (e instanceof ClaveInvalidada) {
        Alert.alert(
          'Hay que crear la identidad de nuevo',
          'La biometría del dispositivo cambió, así que la clave anterior quedó invalidada.',
        );
        navigation.navigate('Dispositivo');
        return;
      }
      Alert.alert('No se pudo firmar', e?.message ?? 'Error desconocido.');
    } finally {
      setFirmando(false);
    }
  };

  const rechazar = async () => {
    canal.current?.rechazar();
    await anotar({
      origen: qr.origen,
      accion: qr.accion ?? 'Aprobar una acción',
      resultado: 'rechazado',
    });
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
        <Ceja style={{ marginBottom: 10 }}>Solicita tu aprobación</Ceja>
        <Origen style={{ marginBottom: 6 }}>{qr.origen}</Origen>
        <Cuerpo style={{ marginBottom: 22 }}>
          {qr.accion ?? 'Quiere que apruebes una acción'}
          {qr.cuenta ? ` como ${qr.cuenta}.` : '.'}
        </Cuerpo>

        <Tarjeta style={{ marginBottom: 14 }}>
          <Fila etiqueta="Navegador" primera>
            <Pildora estado="ok">Vinculado</Pildora>
          </Fila>
          <Fila etiqueta="Caduca en">
            <Text style={[tipo.mono, restante <= 30 && { color: color.carmin }]}>{reloj}</Text>
          </Fila>
        </Tarjeta>

        <Ceja style={{ marginBottom: 7 }}>Reto que vas a firmar</Ceja>
        <View style={s.reto}>
          <Text style={[tipo.mono, { color: color.grafito, lineHeight: 20 }]}>
            {retoLegible(qr.retoB64)}
          </Text>
        </View>
        <Minima style={{ marginTop: 14, marginBottom: 26 }}>
          La firma cubre exactamente lo que ves arriba, así que no sirve para autorizar
          ninguna otra cosa. Se firma dentro del chip: tu clave privada no se transmite.
        </Minima>
      </ScrollView>

      <View style={s.acciones}>
        <Boton onPress={aprobar} cargando={firmando} icono={<Check />}>
          Aprobar y firmar
        </Boton>
        <Boton variante="peligro" onPress={rechazar}>Rechazar</Boton>
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
  reto: { backgroundColor: 'rgba(16,24,33,0.045)', borderRadius: radio.s, padding: 12 },
  acciones: {
    gap: 10, paddingHorizontal: espacio.l, paddingTop: 16, paddingBottom: 30,
    borderTopWidth: 1, borderTopColor: color.linea,
  },
});

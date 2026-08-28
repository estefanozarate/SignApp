import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import Pantalla from '../components/Pantalla';
import { Boton, Ceja, Cuerpo, Fila, Minima, Origen, Pildora, Tarjeta } from '../components/ui';
import { Cerrar, Check } from '../components/Iconos';
import { color, espacio, radio, tipo } from '../theme';
import { SesionAprobacion, Solicitud } from '../services/aprobacion';
import { BiometriaCancelada, ClaveInvalidada } from '../native/Signing';
import { retoLegible } from '../lib/b64';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Aprobacion'>;

export default function Aprobacion({ navigation, route }: Props) {
  const { qr } = route.params;
  const sesion = useRef<SesionAprobacion | null>(null);
  const [estado, setEstado] = useState<'conectando' | 'listo' | 'cerrado'>('conectando');
  const [solicitud, setSolicitud] = useState<Solicitud | null>(null);
  const [firmando, setFirmando] = useState(false);
  const [restante, setRestante] = useState<number>(qr.expiraEn - Math.floor(Date.now() / 1000));

  useEffect(() => {
    const s = new SesionAprobacion(qr.signalingUrl, qr.sessionId, {
      onEstado: setEstado,
      onSolicitud: setSolicitud,
      onError: (e) => {
        Alert.alert('Se cortó la conexión', e.message);
        navigation.navigate('Inicio');
      },
    });
    sesion.current = s;
    s.conectar();
    return () => s.cerrar();
  }, [qr, navigation]);

  // La caducidad la manda el QR; al llegar a cero no se puede aprobar nada.
  useEffect(() => {
    const t = setInterval(() => {
      const quedan = (solicitud?.expiraEn ?? qr.expiraEn) - Math.floor(Date.now() / 1000);
      setRestante(quedan);
      if (quedan <= 0) {
        clearInterval(t);
        sesion.current?.rechazar('expired');
        navigation.replace('NoVerificado', { motivo: 'E_EXPIRADO' });
      }
    }, 1000);
    return () => clearInterval(t);
  }, [solicitud, qr, navigation]);

  const reloj = useMemo(() => {
    const q = Math.max(0, restante);
    return `${Math.floor(q / 60)}:${String(q % 60).padStart(2, '0')}`;
  }, [restante]);

  const aprobar = async () => {
    if (!solicitud) return;
    setFirmando(true);
    try {
      const { firmaDerB64, keyId } = await sesion.current!.aprobar(solicitud);
      navigation.replace('Firmado', { firmaDerB64, keyId, origen: solicitud.origen });
    } catch (e) {
      if (e instanceof BiometriaCancelada) return; // se queda en la pantalla, puede reintentar
      if (e instanceof ClaveInvalidada) {
        Alert.alert('Hay que crear la identidad de nuevo',
          'La biometría del dispositivo cambió, así que la clave anterior quedó invalidada.');
        navigation.navigate('Dispositivo');
        return;
      }
      Alert.alert('No se pudo firmar', (e as Error).message);
    } finally {
      setFirmando(false);
    }
  };

  const rechazar = () => {
    sesion.current?.rechazar();
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

      {!solicitud ? (
        <View style={s.esperando}>
          <ActivityIndicator color={color.intaglio} />
          <Cuerpo style={{ marginTop: 16, textAlign: 'center', maxWidth: 260 }}>
            Esperando a que {qr.origen} diga qué necesita aprobar.
          </Cuerpo>
        </View>
      ) : (
        <>
          <ScrollView contentContainerStyle={s.cuerpo} showsVerticalScrollIndicator={false}>
            <Ceja style={{ marginBottom: 10 }}>Solicita tu aprobación</Ceja>
            <Origen style={{ marginBottom: 6 }}>{solicitud.origen}</Origen>
            <Cuerpo style={{ marginBottom: 22 }}>
              {solicitud.accion}
              {solicitud.cuenta ? ` como ${solicitud.cuenta}.` : '.'}
            </Cuerpo>

            <Tarjeta style={{ marginBottom: 14 }}>
              {solicitud.navegador ? <Fila etiqueta="Desde" primera>{solicitud.navegador}</Fila> : null}
              {solicitud.ubicacion ? <Fila etiqueta="Ubicación aproximada">{solicitud.ubicacion}</Fila> : null}
              <Fila etiqueta="Emisor del código">
                <Pildora estado="ok">Verificado</Pildora>
              </Fila>
              <Fila etiqueta="Caduca en">
                <Text style={[tipo.mono, restante <= 30 && { color: color.carmin }]}>{reloj}</Text>
              </Fila>
            </Tarjeta>

            <Ceja style={{ marginBottom: 7 }}>Reto que vas a firmar</Ceja>
            <View style={s.reto}>
              <Text style={[tipo.mono, { color: color.grafito, lineHeight: 20 }]}>
                {retoLegible(solicitud.retoB64)}
              </Text>
            </View>
            <Minima style={{ marginTop: 14, marginBottom: 26 }}>
              Se firma dentro del chip seguro. Tu clave privada no se transmite ni sale del teléfono.
            </Minima>
          </ScrollView>

          <View style={s.acciones}>
            <Boton
              onPress={aprobar}
              cargando={firmando}
              deshabilitado={estado !== 'listo'}
              icono={<Check />}>
              Aprobar con tu rostro
            </Boton>
            <Boton variante="peligro" onPress={rechazar}>Rechazar</Boton>
          </View>
        </>
      )}
    </Pantalla>
  );
}

const s = StyleSheet.create({
  appbar: {
    height: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingLeft: espacio.l, paddingRight: espacio.m,
  },
  iconbtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  esperando: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: espacio.l },
  cuerpo: { paddingHorizontal: espacio.l },
  reto: { backgroundColor: 'rgba(16,24,33,0.045)', borderRadius: radio.s, padding: 12 },
  acciones: {
    gap: 10, paddingHorizontal: espacio.l, paddingTop: 16, paddingBottom: 30,
    borderTopWidth: 1, borderTopColor: color.linea,
  },
});

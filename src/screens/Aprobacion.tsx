import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, LayoutAnimation, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import Pantalla from '../components/Pantalla';
import { Boton, Ceja, Cuerpo, Fila, Minima, Origen, Pildora, Tarjeta } from '../components/ui';
import { Cerrar, Check } from '../components/Iconos';
import { color, espacio, radio, tipo } from '../theme';
import { contextoDe, pruebaDePosesion, rechazar, responder, PeticionInvalida } from '../services/peticion';
import { BiometriaCancelada, ClaveInvalidada, Signing } from '../native/Signing';
import { anotar } from '../services/actividad';
import { retoLegible } from '../lib/b64';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Aprobacion'>;

export default function Aprobacion({ navigation, route }: Props) {
  const { peticion } = route.params;
  const [ocupado, setOcupado] = useState(false);
  const [restante, setRestante] = useState(peticion.expires_at - Math.floor(Date.now() / 1000));
  const [detalles, setDetalles] = useState(false);
  const resuelto = useRef(false);

  // La caducidad la fija el dominio; al llegar a cero no se aprueba nada.
  useEffect(() => {
    const t = setInterval(() => {
      const quedan = peticion.expires_at - Math.floor(Date.now() / 1000);
      setRestante(quedan);
      if (quedan <= 0 && !resuelto.current) {
        resuelto.current = true;
        clearInterval(t);
        navigation.replace('NoVerificado', { motivo: 'E_EXPIRADA' });
      }
    }, 1000);
    return () => clearInterval(t);
  }, [peticion, navigation]);

  const reloj = useMemo(() => {
    const q = Math.max(0, restante);
    return `${Math.floor(q / 60)}:${String(q % 60).padStart(2, '0')}`;
  }, [restante]);

  const confirmar = async () => {
    setOcupado(true);
    try {
      // §7 y §9 — la prueba de posesión se firma en el chip y se envía junto
      // con la identidad de la app. Sin ella, el dominio no puede saber que
      // esta clave pública la controla quien la presenta.
      const { proof, app_id } = await pruebaDePosesion(peticion, peticion.purpose);
      const identidad = await Signing.identidad();

      await responder(peticion, {
        type: 'APP_IDENTITY',
        version: 1,
        app_id,
        app_public_key: identidad.clavePublicaSpkiB64,
        app_encryption_key: identidad.clavePublicaCifradoSpkiB64,
        proof_of_possession: proof,
      });

      resuelto.current = true;
      await anotar({ origen: peticion.domain, accion: peticion.action_texto, resultado: 'aprobado' });
      navigation.replace('Firmado', {
        firmaDerB64: proof, keyId: app_id,
        origen: peticion.domain, proposito: peticion.purpose,
      });
    } catch (e: any) {
      if (e instanceof BiometriaCancelada) return; // puede reintentar
      if (e instanceof ClaveInvalidada) {
        Alert.alert(
          'Hay que crear la identidad de nuevo',
          'La biometría del dispositivo cambió, así que la identidad anterior dejó de ser válida.',
        );
        navigation.navigate('Dispositivo');
        return;
      }
      // Si el sitio ya no acepta la respuesta, el motivo importa: puede ser
      // que alguien más la haya usado.
      if (e instanceof PeticionInvalida) {
        resuelto.current = true;
        navigation.replace('NoVerificado', { motivo: e.codigo, detalle: e.message });
        return;
      }
      Alert.alert('No se pudo aprobar', e?.message ?? 'Error desconocido.');
    } finally {
      setOcupado(false);
    }
  };

  const denegar = async () => {
    resuelto.current = true;
    await rechazar(peticion);
    await anotar({ origen: peticion.domain, accion: peticion.action_texto, resultado: 'rechazado' });
    navigation.navigate('Inicio');
  };

  return (
    <Pantalla>
      <View style={s.appbar}>
        <Pildora estado="ok">Sitio verificado</Pildora>
        <Pressable onPress={denegar} style={s.iconbtn} accessibilityLabel="Cerrar">
          <Cerrar />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={s.cuerpo} showsVerticalScrollIndicator={false}>
        <Ceja style={{ marginBottom: 10 }}>
          {peticion.purpose === 'PAIR' ? 'Quiere vincularse con tu teléfono' : 'Solicita tu aprobación'}
        </Ceja>
        <Origen style={{ marginBottom: 6 }}>{peticion.domain}</Origen>
        <Cuerpo style={{ marginBottom: 22 }}>
          {peticion.action_texto}
          {peticion.account ? ` como ${peticion.account}.` : '.'}
        </Cuerpo>

        <Tarjeta style={{ marginBottom: 14 }}>
          <Fila etiqueta="Confirmado por" primera>{peticion.domain}</Fila>
          <Fila etiqueta="Identidad del sitio">
            <Text style={tipo.mono}>{peticion.domain_id.slice(0, 8)}··{peticion.domain_id.slice(-4)}</Text>
          </Fila>
          <Fila etiqueta="Caduca en">
            <Text style={[tipo.mono, restante <= 30 && { color: color.carmin }]}>{reloj}</Text>
          </Fila>
        </Tarjeta>

        <Minima style={{ marginBottom: 14 }}>
          Esto lo confirmó el propio sitio por conexión segura, no el código que escaneaste.
          Tu aprobación queda ligada a esta petición y a ninguna otra.
        </Minima>

        {/* El código de verificación no se muestra de entrada: la mayoría no lo
            necesita. Pero no se elimina, porque permite comparar a mano con lo
            que muestra el sitio ante una sospecha. */}
        <Pressable
          onPress={() => {
            LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
            setDetalles(v => !v);
          }}
          style={s.detalles}>
          <Minima style={{ color: color.intaglio, textDecorationLine: 'underline' }}>
            {detalles ? 'Ocultar código de verificación' : 'Ver código de verificación'}
          </Minima>
        </Pressable>

        {detalles ? (
          <>
            <View style={s.reto}>
              <Text style={[tipo.mono, { color: color.grafito, lineHeight: 20 }]}>
                {retoLegible(contextoDe(peticion, peticion.purpose))}
              </Text>
            </View>
            <Minima style={{ marginTop: 10 }}>
              Debe coincidir con el que muestra {peticion.domain}. Si no coincide, rechaza.
            </Minima>
          </>
        ) : null}
        <View style={{ height: 26 }} />
      </ScrollView>

      <View style={s.acciones}>
        <Boton onPress={confirmar} cargando={ocupado} icono={<Check />}>
          {peticion.purpose === 'PAIR' ? 'Vincular este dispositivo' : 'Aprobar'}
        </Boton>
        <Boton variante="peligro" onPress={denegar}>Rechazar</Boton>
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
  detalles: { paddingVertical: 8, marginBottom: 6 },
  reto: { backgroundColor: 'rgba(16,24,33,0.045)', borderRadius: radio.s, padding: 12 },
  acciones: {
    gap: 10, paddingHorizontal: espacio.l, paddingTop: 16, paddingBottom: 30,
    borderTopWidth: 1, borderTopColor: color.linea,
  },
});

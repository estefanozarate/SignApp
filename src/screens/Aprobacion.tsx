import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, LayoutAnimation, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import Pantalla from '../components/Pantalla';
import { Boton, Ceja, Cuerpo, Fila, Minima, Origen, Pildora, Tarjeta } from '../components/ui';
import { Cerrar, Check } from '../components/Iconos';
import { color, espacio, radio, tipo } from '../theme';
import {
  abrirSecreto, contextoDe, entregarSecreto, pruebaDePosesion, rechazar, responder,
  PeticionInvalida,
} from '../services/peticion';
import { guardar, paraDominio, SecretoGuardado } from '../services/boveda';
import { BiometriaCancelada, ClaveInvalidada, SecretoAlterado, Signing } from '../native/Signing';
import { anotar } from '../services/actividad';
import { bytesAB64, textoABytes } from '../lib/aleatorio';
import { retoLegible } from '../lib/b64';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Aprobacion'>;

export default function Aprobacion({ navigation, route }: Props) {
  const { peticion } = route.params;
  const entrega = peticion.purpose === 'SECRET_REQUEST';
  const [ocupado, setOcupado] = useState(false);
  const [restante, setRestante] = useState(peticion.expires_at - Math.floor(Date.now() / 1000));
  const [detalles, setDetalles] = useState(false);
  // undefined mientras se consulta la bóveda; null si no hay nada que entregar.
  const [guardado, setGuardado] = useState<SecretoGuardado | null | undefined>(
    entrega ? undefined : null,
  );
  const resuelto = useRef(false);

  /**
   * §13 — el emparejamiento crítico, y ANTES de pedir biometría.
   *
   * Si este dominio no tiene un secreto guardado bajo su identidad, no hay
   * nada que entregar y no tiene sentido mostrar un botón de aprobar. La
   * comparación es contra domain_id y clave pública, nunca contra el nombre.
   */
  useEffect(() => {
    if (!entrega) return;
    let vivo = true;
    paraDominio(peticion.domain_id, peticion.domain_public_key).then(s => {
      if (!vivo) return;
      if (s) { setGuardado(s); return; }
      setGuardado(null);
      resuelto.current = true;
      // Se avisa al dominio para que deje de esperar, pero sin decirle por
      // qué: el §19 pide no dar información de más a quien pregunta.
      rechazar(peticion);
      navigation.replace('NoVerificado', { motivo: 'E_SIN_SECRETO' });
    });
    return () => { vivo = false; };
  }, [entrega, peticion, navigation]);

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

  /**
   * §9 y §10 — emparejar: se prueba la posesión de la clave y el dominio
   * entrega, ahí mismo, el secreto que guardará esta app.
   */
  const emparejar = async () => {
    // §7 y §9 — la prueba de posesión se firma en el chip y se envía junto
    // con la identidad de la app. Sin ella, el dominio no puede saber que
    // esta clave pública la controla quien la presenta.
    const { proof, app_id } = await pruebaDePosesion(peticion, peticion.purpose);
    const identidad = await Signing.identidad();

    const { secret } = await responder(peticion, {
      type: 'APP_IDENTITY',
      version: 1,
      app_id,
      app_public_key: identidad.clavePublicaSpkiB64,
      app_encryption_key: identidad.clavePublicaCifradoSpkiB64,
      proof_of_possession: proof,
    });

    resuelto.current = true;

    // §10 — el secreto llega cifrado en la propia respuesta al emparejamiento
    // y se abre DENTRO del chip sin pedir nada (§10.1: lo autorizó la prueba
    // de posesión de arriba). §10.1/§11 — guardarlo sí pide autenticación:
    // se cifra de nuevo, esta vez con la clave AES-GCM de la bóveda, y solo
    // el sobre resultante llega al almacenamiento del teléfono.
    let secretoRecibido = false;
    if (secret) {
      const claro = await abrirSecreto(secret, peticion);
      await Signing.autenticar('Guardar tu secreto', peticion.domain);
      const sobre = await Signing.cifrarEnBoveda(bytesAB64(textoABytes(claro)));
      await guardar({
        domain: peticion.domain,
        domain_id: peticion.domain_id,
        domain_public_key: peticion.domain_public_key,
        sobre,
      });
      secretoRecibido = true;
    }

    return { firmaDerB64: proof, keyId: app_id, secretoRecibido, secretoEntregado: false };
  };

  /**
   * §14 — devolver: el secreto sale de la bóveda, se firma y se cifra para
   * este dominio. Nunca se pide al dominio; el dominio ya no lo tiene que
   * mandar, solo comprobarlo.
   */
  const devolver = async () => {
    if (!guardado) throw new PeticionInvalida('E_SIN_SECRETO', 'No hay secreto para este dominio.');
    const { acuse, firmaDerB64, appId } = await entregarSecreto(peticion, guardado);
    resuelto.current = true;
    return {
      firmaDerB64, keyId: appId,
      secretoRecibido: false,
      // El dominio confirma que descifró y que la firma era suya. Si dijera
      // que no, el POST habría fallado con 403 y no llegaríamos aquí.
      secretoEntregado: acuse.signature_valid !== false,
    };
  };

  const confirmar = async () => {
    setOcupado(true);
    try {
      const r = entrega ? await devolver() : await emparejar();

      await anotar({ origen: peticion.domain, accion: peticion.action_texto, resultado: 'aprobado' });
      navigation.replace('Firmado', {
        firmaDerB64: r.firmaDerB64, keyId: r.keyId,
        origen: peticion.domain, proposito: peticion.purpose,
        secretoRecibido: r.secretoRecibido,
        secretoEntregado: r.secretoEntregado,
      });
    } catch (e: any) {
      if (e instanceof BiometriaCancelada) return; // puede reintentar
      if (e instanceof SecretoAlterado) {
        // El tag de GCM no cuadró: el dato llegó alterado. No se guarda nada.
        navigation.replace('NoVerificado', {
          motivo: 'E_ALTERADO',
          detalle: 'El secreto llegó alterado y no se guardó.',
        });
        return;
      }
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
      // §14 — si el módulo nativo no pudo cifrar para este dominio, el motivo
      // es concreto y merece pantalla propia: no se envió nada.
      if (e?.code === 'E_CLAVE_DOMINIO' || e?.code === 'E_CIFRADO') {
        resuelto.current = true;
        navigation.replace('NoVerificado', { motivo: e.code, detalle: e.message });
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
          {entrega ? 'Te pide el secreto que le guardaste' : 'Quiere vincularse con tu teléfono'}
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
          {guardado ? (
            <Fila etiqueta="Secreto guardado">
              {new Date(guardado.recibidoEn).toLocaleDateString('es-PE', {
                day: 'numeric', month: 'short', year: 'numeric',
              })}
            </Fila>
          ) : null}
          <Fila etiqueta="Caduca en">
            <Text style={[tipo.mono, restante <= 30 && { color: color.carmin }]}>{reloj}</Text>
          </Fila>
        </Tarjeta>

        <Minima style={{ marginBottom: 14 }}>
          {entrega
            ? 'El secreto sale de este teléfono firmado con tu clave y cifrado para este dominio. '
              + 'Solo él puede abrirlo, y solo sirve para esta petición.'
            : 'Esto lo confirmó el propio sitio por conexión segura, no el código que escaneaste. '
              + 'Tu aprobación queda ligada a esta petición y a ninguna otra.'}
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
        <Boton
          onPress={confirmar}
          cargando={ocupado || guardado === undefined}
          icono={<Check />}>
          {entrega ? 'Entregar el secreto' : 'Vincular este dispositivo'}
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

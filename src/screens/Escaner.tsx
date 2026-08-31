import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Linking, PermissionsAndroid, Pressable, StyleSheet, Text, View,
} from 'react-native';
import { Camera, CameraType } from 'react-native-camera-kit';
import { SafeAreaView } from 'react-native-safe-area-context';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useIsFocused } from '@react-navigation/native';
import Pantalla from '../components/Pantalla';
import Rosette from '../components/Rosette';
import { Boton, Cuerpo } from '../components/ui';
import { Atras, Check } from '../components/Iconos';
import { RETICULA } from '../lib/guilloche';
import { color, espacio, tipo } from '../theme';
import { Cose } from '../native/Cose';
import { vinculos } from '../services/vinculos';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Escaner'>;

/** Forma del evento de camera-kit; declarada aquí para no arrastrar sus fuentes. */
type LecturaCodigo = { nativeEvent: { codeStringValue: string; codeFormat: string } };
type Paso = 'firma' | 'vigencia' | 'sesion';
type Permiso = 'pidiendo' | 'concedido' | 'denegado' | 'bloqueado';

const PASOS: { id: Paso; texto: string }[] = [
  { id: 'firma', texto: 'Firma del navegador' },
  { id: 'vigencia', texto: 'Vigencia del código' },
  { id: 'sesion', texto: 'Navegador vinculado' },
];

const DONDE_FALLA: Record<string, Paso> = {
  E_FORMATO: 'firma',
  E_NO_VINCULADO: 'firma',
  E_FIRMA: 'firma',
  E_EXPIRADO: 'vigencia',
};

/**
 * La verificación es lo que distingue esta app de un lector de QR cualquiera,
 * así que se muestra paso a paso en vez de esconderla tras un spinner.
 *
 * El permiso se pide ANTES de montar la cámara: montarla sin permiso hacía
 * que la capa nativa reventara sin aviso.
 */
export default function Escaner({ navigation }: Props) {
  const enfocada = useIsFocused();
  const [permiso, setPermiso] = useState<Permiso>('pidiendo');
  const [detectado, setDetectado] = useState(false);
  const [hechos, setHechos] = useState<Paso[]>([]);
  const [fallo, setFallo] = useState<Paso | null>(null);
  const [pie, setPie] = useState('Apunta al código que aparece en la pantalla del sitio.');
  const procesando = useRef(false);

  const pedirCamara = useCallback(async () => {
    setPermiso('pidiendo');
    const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA, {
      title: 'Sello necesita la cámara',
      message: 'Solo para leer el código que muestra el sitio. No se guarda ni se envía ninguna imagen.',
      buttonPositive: 'Permitir',
      buttonNegative: 'Ahora no',
    });
    if (r === PermissionsAndroid.RESULTS.GRANTED) setPermiso('concedido');
    else if (r === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) setPermiso('bloqueado');
    else setPermiso('denegado');
  }, []);

  useEffect(() => { pedirCamara(); }, [pedirCamara]);

  const procesar = useCallback(async (payload: string) => {
    if (procesando.current) return;
    procesando.current = true;
    setDetectado(true);
    setPie('Código detectado. Comprobando su firma…');

    try {
      const qr = await Cose.verificarQr(payload, await vinculos());
      // Si la verificación pasó, los tres pasos son ciertos a la vez.
      setHechos(['firma', 'vigencia', 'sesion']);
      setPie(`Abriendo conexión con ${qr.origen}…`);
      navigation.replace(qr.tipo === 'pair' ? 'Vincular' : 'Aprobacion', { qr });
    } catch (e: any) {
      const codigo: string = e?.code ?? 'E_FORMATO';
      const paso = DONDE_FALLA[codigo] ?? 'firma';
      setFallo(paso);
      setHechos(paso === 'vigencia' ? ['firma'] : []);
      setPie(mensajeDe(codigo));
      setTimeout(
        () => navigation.replace('NoVerificado', { motivo: codigo, kidDeclarado: e?.userInfo?.kid }),
        900,
      );
    }
  }, [navigation]);

  const alLeer = useCallback((evento: LecturaCodigo) => {
    const valor = evento?.nativeEvent?.codeStringValue;
    if (valor) procesar(valor);
  }, [procesar]);

  if (permiso !== 'concedido') {
    return (
      <Pantalla oscura style={s.permiso}>
        <Cuerpo style={{ color: color.huesoTenue, marginBottom: 20, textAlign: 'center' }}>
          {permiso === 'pidiendo'
            ? 'Pidiendo acceso a la cámara…'
            : 'Sello necesita la cámara para leer el código del sitio. No se guarda ni se envía ninguna imagen.'}
        </Cuerpo>
        {permiso !== 'pidiendo' ? (
          <Boton
            variante="claro"
            onPress={permiso === 'bloqueado' ? () => Linking.openSettings() : pedirCamara}>
            {permiso === 'bloqueado' ? 'Abrir los ajustes' : 'Permitir la cámara'}
          </Boton>
        ) : null}
        <Boton
          variante="fantasma"
          style={{ marginTop: 10, borderColor: 'rgba(231,233,227,0.22)' }}
          onPress={() => navigation.goBack()}>
          <Text style={[tipo.etiqueta, { color: color.hueso }]}>Volver</Text>
        </Boton>
      </Pantalla>
    );
  }

  return (
    <Pantalla oscura sinBorde>
      {enfocada && !detectado ? (
        <Camera
          style={StyleSheet.absoluteFill}
          cameraType={CameraType.Back}
          scanBarcode
          allowedBarcodeTypes={['qr']}
          scanThrottleDelay={500}
          onReadCode={alLeer}
          // El marco lo dibuja el guilloché, no la librería.
          showFrame={false}
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: color.tinta }]} />
      )}

      {/* La retícula se contrae al detectar: el mismo guilloché del emblema. */}
      <View style={s.reticula} pointerEvents="none">
        <Rosette anillos={RETICULA} tamano={290} escala={detectado ? 0.74 : 1} />
      </View>

      {/* Capa de UI transparente. Antes era otro <Pantalla>, cuya raíz opaca
          tapaba la cámara y la retícula. */}
      <SafeAreaView style={s.capa} edges={['top', 'bottom']} pointerEvents="box-none">
        <View style={s.cabecera}>
          <Pressable onPress={() => navigation.goBack()} style={s.iconbtn} accessibilityLabel="Volver">
            <Atras color={color.hueso} />
          </Pressable>
          <Text style={[tipo.etiqueta, { color: color.hueso }]}>Escanea el código del sitio</Text>
        </View>

        <View style={s.pie}>
          <View style={s.checks}>
            {PASOS.map(p => {
              const ok = hechos.includes(p.id);
              const err = fallo === p.id;
              return (
                <View key={p.id} style={[s.check, (ok || err) && s.checkActivo]}>
                  <View style={[s.caja, ok && s.cajaOk, err && s.cajaMal]}>
                    {ok ? <Check size={11} color={color.tinta} /> : null}
                    {err ? <Text style={s.aspa}>×</Text> : null}
                  </View>
                  <Text style={[tipo.dato, { color: color.hueso }]}>{p.texto}</Text>
                </View>
              );
            })}
          </View>
          <Cuerpo style={{ color: color.huesoTenue, fontSize: 13 }}>{pie}</Cuerpo>
        </View>
      </SafeAreaView>
    </Pantalla>
  );
}

function mensajeDe(codigo: string) {
  switch (codigo) {
    case 'E_NO_VINCULADO': return 'Este navegador no está vinculado a tu teléfono.';
    case 'E_FIRMA': return 'La firma del código no es válida.';
    case 'E_EXPIRADO': return 'Este código ya caducó. Pide uno nuevo en el sitio.';
    default: return 'Este código no tiene el formato de Sello.';
  }
}

const lleno = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

const s = StyleSheet.create({
  permiso: { justifyContent: 'center', paddingHorizontal: espacio.l },
  capa: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'transparent' },
  reticula: { ...lleno, alignItems: 'center', justifyContent: 'center', top: -60 },
  cabecera: { height: 56, flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 10 },
  iconbtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  pie: {
    marginTop: 'auto', paddingHorizontal: espacio.l, paddingTop: 22, paddingBottom: 34,
    backgroundColor: 'rgba(7,12,16,0.9)',
  },
  checks: { gap: 2, marginBottom: 16 },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 5, opacity: 0.28 },
  checkActivo: { opacity: 1 },
  caja: {
    width: 17, height: 17, borderRadius: 5, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(231,233,227,0.28)',
  },
  cajaOk: { backgroundColor: color.hueso, borderWidth: 0 },
  cajaMal: { backgroundColor: '#D9576F', borderWidth: 0 },
  aspa: { color: '#101821', fontSize: 12, fontWeight: '700', lineHeight: 14 },
});

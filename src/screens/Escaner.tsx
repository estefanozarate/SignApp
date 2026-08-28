import React, { useCallback, useRef, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Camera, isScannedCode, useCameraDevice, useCameraPermission, useObjectOutput,
} from 'react-native-vision-camera';
import type { ScannedObject, ScannedObjectType } from 'react-native-vision-camera';
import { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useIsFocused } from '@react-navigation/native';
import Pantalla from '../components/Pantalla';
import Rosette from '../components/Rosette';
import { Boton, Cuerpo } from '../components/ui';
import { Atras, Check } from '../components/Iconos';
import { RETICULA } from '../lib/guilloche';
import { color, espacio, tipo } from '../theme';
import { Cose } from '../native/Cose';
import { emisores } from '../services/trustlist';
import { Rutas } from '../navigation/tipos';

type Props = NativeStackScreenProps<Rutas, 'Escaner'>;
type Paso = 'firma' | 'vigencia' | 'sesion';

const PASOS: { id: Paso; texto: string }[] = [
  { id: 'firma', texto: 'Firma del emisor' },
  { id: 'vigencia', texto: 'Vigencia del código' },
  { id: 'sesion', texto: 'Sesión abierta en el sitio' },
];

/** Referencia estable: useObjectOutput reconstruye la salida si el array cambia. */
const TIPOS: ScannedObjectType[] = ['qr'];

const DONDE_FALLA: Record<string, Paso> = {
  E_FORMATO: 'firma',
  E_EMISOR_DESCONOCIDO: 'firma',
  E_FIRMA: 'firma',
  E_EXPIRADO: 'vigencia',
};

/**
 * La verificación es lo que distingue esta app de un lector de QR cualquiera,
 * así que se muestra paso a paso en vez de esconderla tras un spinner.
 */
export default function Escaner({ navigation }: Props) {
  const dispositivo = useCameraDevice('back');
  const { hasPermission, canRequestPermission, requestPermission } = useCameraPermission();
  const enfocada = useIsFocused();

  const [detectado, setDetectado] = useState(false);
  const [hechos, setHechos] = useState<Paso[]>([]);
  const [fallo, setFallo] = useState<Paso | null>(null);
  const [pie, setPie] = useState('Apunta al código que aparece en la pantalla del sitio.');
  const procesando = useRef(false);

  const procesar = useCallback(async (payload: string) => {
    if (procesando.current) return;
    procesando.current = true;
    setDetectado(true);
    setPie('Código detectado. Comprobando su firma…');

    try {
      const lista = await emisores();
      const qr = await Cose.verificarQr(payload, lista);
      // Si la verificación pasó, los tres pasos son ciertos a la vez.
      setHechos(['firma', 'vigencia', 'sesion']);
      setPie(`Abriendo conexión con ${qr.origen}…`);
      navigation.replace('Aprobacion', { qr });
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

  const alEscanear = useCallback((objetos: ScannedObject[]) => {
    for (const o of objetos) {
      if (isScannedCode(o) && o.value) { procesar(o.value); return; }
    }
  }, [procesar]);

  const salidaCodigos = useObjectOutput({ types: TIPOS, onObjectsScanned: alEscanear });

  const pedirCamara = useCallback(async () => {
    const concedido = await requestPermission();
    if (!concedido && !canRequestPermission) Linking.openSettings();
  }, [requestPermission, canRequestPermission]);

  if (!hasPermission || !dispositivo) {
    return (
      <Pantalla oscura style={s.permiso}>
        <Cuerpo style={{ color: color.huesoTenue, marginBottom: 20, textAlign: 'center' }}>
          {dispositivo
            ? 'Sello necesita la cámara para leer el código del sitio. No se guarda ni se envía ninguna imagen.'
            : 'No se encontró la cámara trasera de este teléfono.'}
        </Cuerpo>
        {dispositivo ? (
          <Boton variante="claro" onPress={pedirCamara}>
            {canRequestPermission ? 'Permitir la cámara' : 'Abrir los ajustes'}
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
      <Camera
        style={StyleSheet.absoluteFill}
        device={dispositivo}
        isActive={enfocada && !detectado}
        outputs={[salidaCodigos]}
      />

      {/* La retícula se contrae al detectar: el mismo guilloché del emblema. */}
      <View style={s.reticula} pointerEvents="none">
        <Rosette anillos={RETICULA} tamano={290} escala={detectado ? 0.74 : 1} />
      </View>

      <Pantalla oscura style={s.capa}>
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
      </Pantalla>
    </Pantalla>
  );
}

function mensajeDe(codigo: string) {
  switch (codigo) {
    case 'E_EMISOR_DESCONOCIDO': return 'La firma no coincide con ningún emisor autorizado.';
    case 'E_FIRMA': return 'La firma del código no es válida.';
    case 'E_EXPIRADO': return 'Este código ya caducó. Pide uno nuevo en el sitio.';
    default: return 'Este código no tiene el formato de Sello.';
  }
}

const lleno = { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 } as const;

const s = StyleSheet.create({
  permiso: { justifyContent: 'center', paddingHorizontal: espacio.l },
  capa: { backgroundColor: 'transparent' },
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

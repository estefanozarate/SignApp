import React, { useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleSheet, View, ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { Anillo, trocoide } from '../lib/guilloche';

type Props = {
  anillos: Anillo[];
  tamano: number;
  /** 0..1 — encoge la roseta (el escáner la contrae al detectar el código) */
  escala?: number;
  quieta?: boolean;
  style?: ViewStyle;
  children?: React.ReactNode;
};

/**
 * Cada anillo gira en su propia capa nativa: el path es estático y solo se
 * anima `transform`, así el JS thread queda libre para la cámara y WebRTC.
 */
export default function Rosette({ anillos, tamano, escala = 1, quieta, style, children }: Props) {
  const contraccion = useRef(new Animated.Value(escala)).current;

  useEffect(() => {
    Animated.timing(contraccion, {
      toValue: escala, duration: 500, easing: Easing.bezier(0.2, 0.8, 0.2, 1), useNativeDriver: true,
    }).start();
  }, [escala, contraccion]);

  return (
    <Animated.View
      style={[
        { width: tamano, height: tamano, alignItems: 'center', justifyContent: 'center' },
        { transform: [{ scale: contraccion }] },
        style,
      ]}>
      {anillos.map((a, i) => (
        <Ring key={i} anillo={a} tamano={tamano} quieta={quieta} />
      ))}
      {children ? <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <View style={styles.centro}>{children}</View>
      </View> : null}
    </Animated.View>
  );
}

function Ring({ anillo, tamano, quieta }: { anillo: Anillo; tamano: number; quieta?: boolean }) {
  const giro = useRef(new Animated.Value(0)).current;
  const d = useMemo(
    () => trocoide(anillo.r, anillo.d, anillo.vueltas, anillo.pasos, 300, 300, anillo.escala),
    [anillo],
  );

  useEffect(() => {
    if (quieta || !anillo.periodo) return;
    const anim = Animated.loop(
      Animated.timing(giro, {
        toValue: 1, duration: Math.abs(anillo.periodo), easing: Easing.linear, useNativeDriver: true,
      }),
    );
    anim.start();
    return () => anim.stop();
  }, [anillo.periodo, quieta, giro]);

  const rotate = giro.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', anillo.periodo < 0 ? '-360deg' : '360deg'],
  });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ rotate }] }]}>
      <Svg width={tamano} height={tamano} viewBox="0 0 600 600">
        <Path d={d} fill="none" stroke={anillo.color} strokeOpacity={anillo.opacidad}
          strokeWidth={anillo.grosor} strokeLinejoin="round" />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  centro: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});

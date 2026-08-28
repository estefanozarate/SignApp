import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

type P = { size?: number; color?: string };

export const Escanear = ({ size = 19, color = '#F4F6F2' }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16M7 12h10"
      stroke={color} strokeWidth={1.7} strokeLinecap="round" />
  </Svg>
);

export const Candado = ({ size = 26, color = '#0E5548' }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Rect x={4.5} y={10.5} width={15} height={10} rx={2.5} stroke={color} strokeWidth={1.5} />
    <Path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" stroke={color} strokeWidth={1.5} />
  </Svg>
);

export const Check = ({ size = 18, color = '#F4F6F2' }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M4 12.5l5.5 5.5L20 7" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const Alerta = ({ size = 64, color = '#96263F' }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Circle cx={12} cy={12} r={9.2} stroke={color} strokeWidth={1.4} />
    <Path d="M12 7.5v5.2M12 16.3v.2" stroke={color} strokeWidth={1.4} strokeLinecap="round" />
  </Svg>
);

export const Atras = ({ size = 21, color = '#101821' }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M15 5l-7 7 7 7" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
  </Svg>
);

export const Cerrar = ({ size = 20, color = '#101821' }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Path d="M6 6l12 12M18 6L6 18" stroke={color} strokeWidth={1.7} strokeLinecap="round" />
  </Svg>
);

export const Telefono = ({ size = 21, color = '#101821' }: P) => (
  <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <Rect x={6} y={2.5} width={12} height={19} rx={2.5} stroke={color} strokeWidth={1.6} />
    <Path d="M10.5 18.5h3" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
  </Svg>
);

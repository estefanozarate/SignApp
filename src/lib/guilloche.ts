/**
 * Guilloché: hipotrocoides encadenados, el grabado de los documentos de
 * seguridad. Es el elemento firma de la app — emblema del dispositivo,
 * retícula del escáner y sello de la firma son el mismo objeto.
 */
export type Anillo = {
  r: number; d: number; escala: number;
  vueltas: number; pasos: number;
  color: string; opacidad: number; grosor: number;
  periodo: number; // ms por revolución; negativo = sentido contrario; 0 = quieto
};

export function trocoide(
  r: number, d: number, vueltas: number, pasos: number,
  cx: number, cy: number, escala: number,
): string {
  const R = 1;
  let p = '';
  for (let i = 0; i <= pasos; i++) {
    const t = (i / pasos) * Math.PI * 2 * vueltas;
    const x = (R - r) * Math.cos(t) + d * Math.cos(((R - r) / r) * t);
    const y = (R - r) * Math.sin(t) - d * Math.sin(((R - r) / r) * t);
    p += (i ? 'L' : 'M') + (cx + x * escala).toFixed(1) + ' ' + (cy + y * escala).toFixed(1);
  }
  return p;
}

const T = '#101821', H = '#E7E9E3', V = '#0E5548';

export const EMBLEMA: Anillo[] = [
  { r: 0.209, d: 0.58, escala: 272, vueltas: 19, pasos: 900, color: T, opacidad: 0.22, grosor: 0.7, periodo: 64000 },
  { r: 0.313, d: 0.41, escala: 225, vueltas: 13, pasos: 700, color: T, opacidad: 0.16, grosor: 0.7, periodo: -44000 },
  { r: 0.427, d: 0.33, escala: 158, vueltas: 9, pasos: 560, color: V, opacidad: 0.95, grosor: 1.1, periodo: 96000 },
];
export const HERO: Anillo[] = [
  { r: 0.209, d: 0.58, escala: 270, vueltas: 19, pasos: 900, color: H, opacidad: 0.16, grosor: 0.7, periodo: 64000 },
  { r: 0.313, d: 0.41, escala: 222, vueltas: 13, pasos: 700, color: H, opacidad: 0.11, grosor: 0.7, periodo: -44000 },
  { r: 0.427, d: 0.33, escala: 160, vueltas: 9, pasos: 560, color: V, opacidad: 0.85, grosor: 0.9, periodo: 96000 },
];
export const RETICULA: Anillo[] = [
  { r: 0.209, d: 0.58, escala: 272, vueltas: 19, pasos: 900, color: H, opacidad: 0.30, grosor: 0.7, periodo: 64000 },
  { r: 0.427, d: 0.33, escala: 170, vueltas: 9, pasos: 560, color: H, opacidad: 0.75, grosor: 1.2, periodo: 96000 },
];
export const SELLO: Anillo[] = [
  { r: 0.209, d: 0.58, escala: 272, vueltas: 19, pasos: 900, color: T, opacidad: 0.18, grosor: 0.7, periodo: 0 },
  { r: 0.427, d: 0.33, escala: 160, vueltas: 9, pasos: 560, color: V, opacidad: 1, grosor: 1.2, periodo: 0 },
];

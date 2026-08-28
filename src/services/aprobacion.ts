import { RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';
import { Signing } from '../native/Signing';
import { tokenActual } from './api';

/**
 * Módulo D — signaling + WebRTC.
 * El teléfono siempre es el que contesta (answerer): el navegador que mostró
 * el QR crea la oferta y el DataChannel. Aquí no se transmite ningún secreto:
 * entra un reto, sale una firma.
 */

export type Solicitud = {
  origen: string;        // dominio que pide la aprobación
  accion: string;        // qué se está aprobando, en texto para el usuario
  cuenta?: string;
  navegador?: string;
  ubicacion?: string;
  retoB64: string;       // nonce a firmar
  expiraEn: number;      // epoch en segundos
};

type Eventos = {
  onEstado?: (e: 'conectando' | 'listo' | 'cerrado') => void;
  onSolicitud?: (s: Solicitud) => void;
  onError?: (e: Error) => void;
};

const HIELO = [{ urls: 'stun:stun.l.google.com:19302' }];

export class SesionAprobacion {
  private ws?: WebSocket;
  private pc?: RTCPeerConnection;
  private canal?: any;
  private cerrada = false;

  constructor(
    private signalingUrl: string,
    private sessionId: string,
    private ev: Eventos = {},
  ) {}

  conectar() {
    this.ev.onEstado?.('conectando');
    const url = `${this.signalingUrl}?session_id=${encodeURIComponent(this.sessionId)}`;
    this.ws = new WebSocket(url, undefined, {
      headers: { Authorization: `Bearer ${tokenActual() ?? ''}` },
    } as any);

    this.ws.onerror = () => this.fallar(new Error('No se pudo abrir el canal con el sitio.'));
    this.ws.onclose = () => { if (!this.cerrada) this.ev.onEstado?.('cerrado'); };
    this.ws.onmessage = (e) => this.enSenal(JSON.parse(String(e.data)));
  }

  private async enSenal(m: any) {
    try {
      if (m.type === 'offer') {
        const pc = new RTCPeerConnection({ iceServers: HIELO });
        this.pc = pc;

        // El navegador crea el DataChannel; nosotros lo recibimos.
        (pc as any).addEventListener('datachannel', (ev: any) => this.enCanal(ev.channel));
        (pc as any).addEventListener('icecandidate', (ev: any) => {
          if (ev.candidate) this.enviar({ type: 'ice', candidate: ev.candidate });
        });
        (pc as any).addEventListener('connectionstatechange', () => {
          if (['failed', 'disconnected'].includes((pc as any).connectionState)) {
            this.fallar(new Error('Se perdió la conexión con el sitio.'));
          }
        });

        await pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
        const respuesta = await pc.createAnswer();
        await pc.setLocalDescription(respuesta);
        this.enviar({ type: 'answer', sdp: pc.localDescription });
      } else if (m.type === 'ice' && this.pc) {
        await this.pc.addIceCandidate(new RTCIceCandidate(m.candidate));
      }
    } catch (e) {
      this.fallar(e as Error);
    }
  }

  private enCanal(canal: any) {
    this.canal = canal;
    canal.addEventListener('open', () => this.ev.onEstado?.('listo'));
    canal.addEventListener('close', () => { if (!this.cerrada) this.ev.onEstado?.('cerrado'); });
    canal.addEventListener('message', (e: any) => {
      const m = JSON.parse(String(e.data));
      if (m.type === 'challenge') {
        this.ev.onSolicitud?.({
          origen: m.origin, accion: m.action, cuenta: m.account,
          navegador: m.browser, ubicacion: m.location,
          retoB64: m.challenge, expiraEn: m.exp,
        });
      }
    });
  }

  /**
   * Pide biometría, firma dentro del Keystore y manda SOLO la firma.
   * El título del prompt lleva el contexto para que el usuario vea qué aprueba.
   */
  async aprobar(s: Solicitud) {
    const { firmaDerB64, keyId } = await Signing.firmar(
      s.retoB64,
      s.accion,
      s.origen,
    );
    this.canal?.send(JSON.stringify({ type: 'signature', signature: firmaDerB64, key_id: keyId }));
    this.cerrar();
    return { firmaDerB64, keyId };
  }

  rechazar(motivo = 'user_denied') {
    this.canal?.send(JSON.stringify({ type: 'denied', reason: motivo }));
    this.cerrar();
  }

  /** Nada queda abierto después de aprobar o rechazar. */
  cerrar() {
    this.cerrada = true;
    try { this.canal?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    try { this.ws?.close(); } catch {}
    this.ev.onEstado?.('cerrado');
  }

  private enviar(m: unknown) { this.ws?.send(JSON.stringify(m)); }
  private fallar(e: Error) { this.ev.onError?.(e); this.cerrar(); }
}

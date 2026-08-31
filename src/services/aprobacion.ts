import { RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';
import { Signing } from '../native/Signing';

/**
 * Canal de retorno hacia el navegador.
 *
 * El reto ya viene firmado dentro del QR, así que por aquí no entra nada que
 * haya que creerse: solo sale la respuesta. El teléfono contesta la oferta
 * SDP del navegador y, cuando el DataChannel abre, manda la firma.
 *
 * El relay de signaling solo ve el handshake. El reto y la firma van por el
 * DataChannel, cifrado extremo a extremo. Y si el navegador está en la misma
 * red, ni siquiera hace falta relay.
 */

type Eventos = {
  onEstado?: (e: 'conectando' | 'listo' | 'cerrado') => void;
  onError?: (e: Error) => void;
};

const HIELO = [{ urls: 'stun:stun.l.google.com:19302' }];

export type Respuesta =
  | { type: 'signature'; signature: string; key_id: string }
  | { type: 'paired'; public_key: string; key_id: string; device: string }
  | { type: 'denied'; reason: string };

export class CanalNavegador {
  private ws?: WebSocket;
  private pc?: RTCPeerConnection;
  private canal?: any;
  private cerrada = false;
  private pendiente?: Respuesta;

  constructor(
    private signalingUrl: string,
    private sessionId: string,
    private ev: Eventos = {},
  ) {}

  conectar() {
    this.ev.onEstado?.('conectando');
    const url = `${this.signalingUrl}?session_id=${encodeURIComponent(this.sessionId)}`;
    // Sin backend no hay token: el session_id del QR es la única credencial,
    // por eso lo genera un CSPRNG y caduca en minutos.
    this.ws = new WebSocket(url);

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
    canal.addEventListener('open', () => {
      this.ev.onEstado?.('listo');
      // Si el usuario aprobó antes de que el canal abriera, sale ahora.
      if (this.pendiente) { this.despachar(this.pendiente); this.pendiente = undefined; }
    });
    canal.addEventListener('close', () => { if (!this.cerrada) this.ev.onEstado?.('cerrado'); });
  }

  private despachar(r: Respuesta) {
    this.canal?.send(JSON.stringify(r));
    this.cerrar();
  }

  /** Encola si el canal aún no abrió: el usuario no debería esperar a la red. */
  private responder(r: Respuesta) {
    if (this.canal?.readyState === 'open') this.despachar(r);
    else this.pendiente = r;
  }

  /**
   * Pide autenticación, firma dentro del Keystore y manda SOLO la firma.
   * El reto viene del QR ya verificado: lo que el usuario vio es lo que firma.
   */
  async aprobar(retoB64: string, accion: string, origen: string) {
    const { firmaDerB64, keyId } = await Signing.firmar(retoB64, accion, origen);
    this.responder({ type: 'signature', signature: firmaDerB64, key_id: keyId });
    return { firmaDerB64, keyId };
  }

  /** En la vinculación lo que viaja es la clave PÚBLICA: no es un secreto. */
  async vincular(clavePublicaSpkiB64: string, keyId: string, dispositivo: string) {
    this.responder({ type: 'paired', public_key: clavePublicaSpkiB64, key_id: keyId, device: dispositivo });
  }

  rechazar(motivo = 'user_denied') {
    this.responder({ type: 'denied', reason: motivo });
  }

  /** Nada queda abierto después de responder. */
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

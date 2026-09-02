import { RTCIceCandidate, RTCPeerConnection, RTCSessionDescription } from 'react-native-webrtc';
import { Signing } from '../native/Signing';

/**
 * Canal de retorno hacia el navegador.
 *
 * El reto ya viene firmado dentro del QR, así que por aquí no entra nada que
 * haya que creerse: solo sale la respuesta.
 *
 * Se intenta primero por DataChannel (P2P directo, sin que el relay vea
 * nada) y, si no abre en unos segundos, se manda por el propio WebSocket.
 *
 * Ese respaldo no debilita el modelo: lo que viaja es una FIRMA, y su valor
 * no viene del canal sino de la criptografía. El relay no puede falsificarla
 * ni reutilizarla, porque cubre un reto que solo sirve una vez. Tampoco hay
 * nada confidencial que ocultar: la clave pública no es un secreto. Depender
 * de que el P2P se establezca —cosa que el NAT rompe a menudo— sería cambiar
 * fiabilidad por una garantía que aquí no hace falta.
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
  /** ms de espera al DataChannel antes de tirar por el relay. */
  private static readonly ESPERA_P2P = 5000;
  private pendiente?: { r: Respuesta; ok: () => void; falla: (e: Error) => void };

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
    // Con el WebSocket ya hay por dónde responder, aunque el P2P no cuaje.
    this.ws.onopen = () => this.ev.onEstado?.('listo');
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

        await pc.setRemoteDescription(new RTCSessionDescription(m.sdp));
        const respuesta = await pc.createAnswer();
        await pc.setLocalDescription(respuesta);
        this.enviar({ type: 'answer', sdp: pc.localDescription });
      } else if (m.type === 'ice' && this.pc) {
        try { await this.pc.addIceCandidate(new RTCIceCandidate(m.candidate)); } catch {}
      }
    } catch (e) {
      // Que falle el P2P no es fatal: queda el relay como camino de vuelta.
      this.ev.onError?.(e as Error);
    }
  }

  private enCanal(canal: any) {
    this.canal = canal;
    canal.addEventListener('open', () => {
      this.ev.onEstado?.('listo');
      // Si el usuario aprobó antes de que el canal abriera, sale ahora.
      const p = this.pendiente;
      if (p) {
        this.pendiente = undefined;
        this.despachar(p.r).then(p.ok, p.falla);
      }
    });
  }

  /**
   * Envía y espera a que salga de verdad. `send` solo encola en el buffer del
   * DataChannel: cerrar inmediatamente después descarta el mensaje.
   */
  private async despachar(r: Respuesta) {
    this.canal.send(JSON.stringify(r));
    const limite = Date.now() + 3000;
    while (this.canal.bufferedAmount > 0 && Date.now() < limite) {
      await new Promise<void>(res => setTimeout(res, 50));
    }
  }

  /**
   * Encola si el canal aún no abrió: el usuario no debería esperar a la red
   * para poner su PIN. La promesa resuelve cuando el mensaje ya salió, y
   * quien llama no debe cerrar la pantalla antes de eso.
   */
  private responder(r: Respuesta): Promise<void> {
    if (this.cerrada) return Promise.reject(new Error('El canal ya estaba cerrado.'));
    if (this.canal?.readyState === 'open') return this.despachar(r);

    return new Promise((ok, falla) => {
      this.pendiente = { r, ok, falla };
      setTimeout(() => {
        if (this.pendiente?.r !== r) return;
        this.pendiente = undefined;

        // El P2P no cuajó. Va por el relay, que es igual de válido para una
        // firma: el navegador la verifica criptográficamente de todos modos.
        if (this.ws?.readyState === WebSocket.OPEN) {
          try {
            this.enviar(r);
            ok();
          } catch (e) {
            falla(e as Error);
          }
          return;
        }
        falla(new Error('No hay conexión con el sitio.'));
      }, CanalNavegador.ESPERA_P2P);
    });
  }

  /**
   * Pide autenticación, firma dentro del Keystore y manda SOLO la firma.
   * El reto viene del QR ya verificado: lo que el usuario vio es lo que firma.
   */
  async aprobar(retoB64: string, accion: string, origen: string) {
    const { firmaDerB64, keyId } = await Signing.firmar(retoB64, accion, origen);
    await this.responder({ type: 'signature', signature: firmaDerB64, key_id: keyId });
    return { firmaDerB64, keyId };
  }

  /** En la vinculación lo que viaja es la clave PÚBLICA: no es un secreto. */
  async vincular(clavePublicaSpkiB64: string, keyId: string, dispositivo: string) {
    await this.responder({ type: 'paired', public_key: clavePublicaSpkiB64, key_id: keyId, device: dispositivo });
  }

  rechazar(motivo = 'user_denied') {
    // Sin await: rechazar no debe bloquear al usuario si el canal no abrió.
    this.responder({ type: 'denied', reason: motivo }).catch(() => {});
  }

  /** Nada queda abierto después de responder. */
  cerrar() {
    if (this.cerrada) return;
    this.cerrada = true;
    this.pendiente?.falla(new Error('El canal se cerró antes de responder.'));
    this.pendiente = undefined;
    try { this.canal?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    try { this.ws?.close(); } catch {}
    this.ev.onEstado?.('cerrado');
  }

  private enviar(m: unknown) { this.ws?.send(JSON.stringify(m)); }
  private fallar(e: Error) { this.ev.onError?.(e); this.cerrar(); }
}

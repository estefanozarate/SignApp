import { Signing } from '../native/Signing';

/**
 * Canal de retorno hacia el navegador: un POST.
 *
 * El reto ya viene firmado dentro del QR, así que por aquí no entra nada que
 * haya que creerse. Solo sale la respuesta, y la respuesta es una FIRMA.
 *
 * Antes esto era WebRTC con signaling, SDP y candidatos ICE. Se quitó porque
 * el valor de una firma está en la criptografía, no en el canal: el servidor
 * no puede falsificarla ni reutilizarla —cubre un reto de un solo uso— y no
 * hay nada confidencial que ocultar, porque una clave pública no es un
 * secreto. El P2P costaba NAT, STUN, TURN y fallos intermitentes a cambio de
 * una garantía que aquí no hacía falta.
 */

export type Respuesta =
  | { type: 'signature'; signature: string; key_id: string }
  | { type: 'paired'; public_key: string; key_id: string; device: string }
  | { type: 'denied'; reason: string };

const TIEMPO_LIMITE_MS = 15000;

export class CanalNavegador {
  private cerrada = false;

  constructor(private baseUrl: string, private sessionId: string) {}

  private get url() {
    return `${this.baseUrl.replace(/\/$/, '')}/respuesta?session_id=${encodeURIComponent(this.sessionId)}`;
  }

  private async responder(r: Respuesta): Promise<void> {
    if (this.cerrada) throw new Error('Esta petición ya se cerró.');

    const corte = new AbortController();
    const t = setTimeout(() => corte.abort(), TIEMPO_LIMITE_MS);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(r),
        signal: corte.signal,
      });
      if (res.status === 409) throw new Error('El sitio ya recibió una respuesta para esta petición.');
      if (!res.ok) throw new Error(`El sitio no aceptó la respuesta (${res.status}).`);
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new Error('El sitio no respondió a tiempo.');
      throw e;
    } finally {
      clearTimeout(t);
      this.cerrada = true;
    }
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
    await this.responder({
      type: 'paired', public_key: clavePublicaSpkiB64, key_id: keyId, device: dispositivo,
    });
  }

  /** El rechazo se avisa, pero si no llega tampoco pasa nada: el QR caduca. */
  rechazar(motivo = 'user_denied') {
    this.responder({ type: 'denied', reason: motivo }).catch(() => {});
  }
}

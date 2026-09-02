#!/usr/bin/env node
/**
 * Buzón de respuestas. Sin dependencias: solo node:http.
 *
 * El teléfono deja aquí su respuesta y el navegador la recoge. Nada más.
 *
 * Antes esto era un relay de WebRTC con signaling, SDP y candidatos ICE.
 * Se quitó porque no aportaba: lo que viaja es una FIRMA, y su valor está en
 * la criptografía, no en el canal. Este servidor no puede falsificarla ni
 * reutilizarla —cubre un reto de un solo uso— ni hay nada confidencial que
 * ocultar, porque una clave pública no es un secreto. El P2P costaba NAT,
 * STUN, TURN y fallos intermitentes a cambio de una garantía que no hacía
 * falta.
 *
 *   node servidor.mjs
 */
import { createServer } from 'node:http';

const PUERTO = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const VIDA_MS = 5 * 60000;       // lo que dura un QR, con holgura
const ESPERA_MS = 25000;         // tope de una espera larga
const MAX_CUERPO = 16 * 1024;

/** session_id → { respuesta, esperando[], temporizador } */
const buzones = new Map();

const valido = (sid) => typeof sid === 'string' && /^[0-9a-f]{32}$/i.test(sid);

function buzon(sid) {
  let b = buzones.get(sid);
  if (!b) {
    b = { respuesta: null, esperando: [], temporizador: null };
    b.temporizador = setTimeout(() => {
      for (const res of b.esperando) responder(res, 204);
      buzones.delete(sid);
      log(sid, 'caducado');
    }, VIDA_MS);
    buzones.set(sid, b);
  }
  return b;
}

function responder(res, codigo, cuerpo) {
  res.writeHead(codigo, {
    'Content-Type': 'application/json',
    // El navegador sirve desde otro puerto; sin esto no puede leer nada.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(cuerpo ? JSON.stringify(cuerpo) : '');
}

const servidor = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const sid = url.searchParams.get('session_id');

  if (req.method === 'OPTIONS') return responder(res, 204);
  if (url.pathname !== '/respuesta') return responder(res, 404, { error: 'ruta desconocida' });

  // El session_id es la única credencial: sin backend no hay token. Se exige
  // que parezca uno de verdad para que nadie entre probando "1".
  if (!valido(sid)) return responder(res, 400, { error: 'session_id inválido' });

  // ── el teléfono deja la respuesta ─────────────────────────────────
  if (req.method === 'POST') {
    let cuerpo = '';
    req.on('data', (c) => {
      cuerpo += c;
      if (cuerpo.length > MAX_CUERPO) { req.destroy(); }
    });
    req.on('end', () => {
      let m;
      try { m = JSON.parse(cuerpo); } catch { return responder(res, 400, { error: 'json inválido' }); }

      const b = buzon(sid);
      if (b.respuesta) return responder(res, 409, { error: 'ya respondido' });

      b.respuesta = m;
      log(sid, `respuesta ${m.type ?? '?'} (${cuerpo.length}B)`);
      // Se despierta a quien estuviera esperando.
      for (const espera of b.esperando) responder(espera, 200, m);
      b.esperando = [];
      responder(res, 200, { ok: true });
    });
    return;
  }

  // ── el navegador la recoge ─────────────────────────────────────
  if (req.method === 'GET') {
    const b = buzon(sid);
    if (b.respuesta) return responder(res, 200, b.respuesta);

    // Espera larga: se deja la petición abierta hasta que llegue algo. Evita
    // preguntar en bucle sin dejar de ser HTTP corriente.
    b.esperando.push(res);
    const corte = setTimeout(() => {
      b.esperando = b.esperando.filter((r) => r !== res);
      responder(res, 204);
    }, ESPERA_MS);
    res.on('close', () => clearTimeout(corte));
    return;
  }

  responder(res, 405, { error: 'método no admitido' });
});

const log = (sid, msg) => console.log(`[${sid.slice(0, 8)}…] ${msg}`);

servidor.listen(PUERTO, HOST, () => {
  console.log(`Buzón de respuestas en http://${HOST}:${PUERTO}`);
  console.log('Para que el teléfono llegue hasta aquí:  adb reverse tcp:8787 tcp:8787');
});

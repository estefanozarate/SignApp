#!/usr/bin/env node
/**
 * Relay de signaling. Empareja, no transporta.
 *
 * Junta dos conexiones que traen el mismo session_id y reenvía lo que una
 * manda a la otra. No entiende ni guarda nada: lo único que pasa por aquí es
 * el handshake de WebRTC (oferta SDP, respuesta y candidatos ICE).
 *
 * El reto y la firma NO pasan por aquí — van por el DataChannel, cifrado
 * extremo a extremo. Si apagas este proceso justo después de que el canal
 * abre, la aprobación se completa igual.
 *
 *   npm install && npm start
 */
import { WebSocketServer } from 'ws';

const PUERTO = Number(process.env.PORT ?? 8787);
// Explícitamente IPv4: por defecto Node escucha en :: (IPv6), y el reenvío
// de `adb reverse` llega por IPv4. Sin esto el navegador conecta y el
// teléfono no, que es un fallo difícil de ver.
const HOST = process.env.HOST ?? '127.0.0.1';
const VIDA_SALA_MS = 5 * 60000;
const MAX_MENSAJE = 64 * 1024;

const salas = new Map();

const wss = new WebSocketServer({ host: HOST, port: PUERTO });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const sid = url.searchParams.get('session_id');

  // El session_id es la única credencial del canal: sin backend no hay token.
  // Se exige que parezca uno de verdad para que nadie entre probando "1".
  if (!sid || !/^[0-9a-f]{32}$/i.test(sid)) {
    ws.close(1008, 'session_id inválido');
    return;
  }

  let sala = salas.get(sid);
  if (!sala) {
    sala = { pares: [], temporizador: null };
    sala.temporizador = setTimeout(() => cerrarSala(sid, 'caducada'), VIDA_SALA_MS);
    salas.set(sid, sala);
  }

  // Exactamente dos: el navegador y el teléfono. Un tercero se rechaza.
  if (sala.pares.length >= 2) {
    ws.close(1008, 'la sala ya tiene dos participantes');
    return;
  }

  sala.pares.push(ws);
  log(sid, `conectado (${sala.pares.length}/2)`);

  ws.on('message', (datos, esBinario) => {
    if (esBinario || datos.length > MAX_MENSAJE) {
      ws.close(1009, 'mensaje no admitido');
      return;
    }
    // Se reenvía tal cual, sin mirar dentro.
    for (const otro of sala.pares) {
      if (otro !== ws && otro.readyState === otro.OPEN) otro.send(datos.toString());
    }
  });

  ws.on('close', () => {
    sala.pares = sala.pares.filter(p => p !== ws);
    log(sid, `desconectado (${sala.pares.length}/2)`);
    if (sala.pares.length === 0) cerrarSala(sid, 'vacía');
  });

  ws.on('error', () => {});
});

function cerrarSala(sid, motivo) {
  const sala = salas.get(sid);
  if (!sala) return;
  clearTimeout(sala.temporizador);
  for (const p of sala.pares) { try { p.close(1000, motivo); } catch {} }
  salas.delete(sid);
  log(sid, `sala cerrada: ${motivo}`);
}

const log = (sid, msg) => console.log(`[${sid.slice(0, 8)}…] ${msg}`);

console.log(`Relay de signaling escuchando en ws://${HOST}:${PUERTO}`);
console.log('Para que el teléfono llegue hasta aquí:  adb reverse tcp:8787 tcp:8787');

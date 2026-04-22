/**
 * Cliente headless para teste real:
 *   1. Conecta no socket-server (default localhost:4010)
 *   2. Emite openLogin (nao faz login - assume sessao ja salva em chrome-profile)
 *   3. Emite startDmTap
 *   4. Fica escutando dmTap:newMessage por WAIT_MS
 *   5. Imprime resumo e sai
 *
 * Rodar: npx ts-node --transpile-only scripts/live-dm-tap-client.ts
 */
import { io } from "socket.io-client";

const SERVER = process.env.SOCKET_URL || "http://localhost:4010";
const WAIT_MS = Number(process.env.WAIT_MS || 90000);
const DEBUG = process.env.DM_TAP_DEBUG === "1";

function stamp(): string {
  return new Date().toISOString();
}

function log(msg: string, meta?: unknown): void {
  if (meta === undefined) {
    console.log("[" + stamp() + "] [live-client] " + msg);
  } else {
    console.log("[" + stamp() + "] [live-client] " + msg + " " + JSON.stringify(meta));
  }
}

async function main(): Promise<void> {
  log("conectando", { SERVER });
  const socket = io(SERVER, { transports: ["websocket"], reconnection: false });

  const received: any[] = [];

  socket.on("connect", () => log("connected", { id: socket.id }));
  socket.on("disconnect", (reason) => log("disconnected", { reason }));
  socket.on("connect_error", (err) => log("connect_error", { msg: (err as Error).message }));
  socket.on("status", (p) => log("status", p));
  socket.on("openLogin:result", (p) => log("openLogin:result", p));
  socket.on("startDmTap:result", (p) => log("startDmTap:result", p));
  socket.on("stopDmTap:result", (p) => log("stopDmTap:result", p));
  socket.on("dmTap:newMessage", (p) => {
    received.push(p);
    log("DM TAP NEW MESSAGE", {
      senderId: p.senderId,
      threadId: p.threadId,
      text: p.text,
      topic: p.topic,
      source: p.source,
    });
  });

  const debugCounts: Record<string, number> = {};
  const debugSamples: Record<string, any[]> = {};
  socket.on("dmTap:debug", (msg) => {
    debugCounts[msg.kind] = (debugCounts[msg.kind] || 0) + 1;
    if (!debugSamples[msg.kind]) debugSamples[msg.kind] = [];
    if (debugSamples[msg.kind].length < 3) debugSamples[msg.kind].push(msg.data);
  });
  socket.on("getDmTapStats:result", (p) => log("stats", p));

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("connect timeout")), 10000);
    socket.on("connect", () => { clearTimeout(t); resolve(); });
    socket.on("connect_error", (err) => { clearTimeout(t); reject(err); });
  });

  log("abrindo pagina inicial (reuso de sessao)");
  await new Promise<void>((resolve) => {
    const onResult = (p: any) => {
      log("openLogin concluido", { ok: p?.ok, url: p?.url });
      resolve();
    };
    socket.once("openLogin:result", onResult);
    socket.emit("openLogin");
  });

  log("startDmTap", { debug: DEBUG });
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => reject(new Error("startDmTap timeout")), 60000);
    socket.once("startDmTap:result", (p: any) => {
      clearTimeout(to);
      if (p?.ok) resolve();
      else reject(new Error("startDmTap failed: " + (p?.error || "unknown")));
    });
    socket.emit("startDmTap", { debug: DEBUG });
  });

  log("tap ativo - aguardando mensagens por " + Math.round(WAIT_MS / 1000) + "s");
  log("ENVIE UMA DM DE OUTRA CONTA PARA A CONTA LOGADA AGORA");

  await new Promise((r) => setTimeout(r, WAIT_MS));

  log("fetching stats snapshot");
  socket.emit("getDmTapStats");
  await new Promise((r) => setTimeout(r, 1500));

  log("debug kind counts", debugCounts);
  for (const k of Object.keys(debugSamples)) {
    console.log("  sample[" + k + "]:", JSON.stringify(debugSamples[k], null, 2));
  }

  log("stopDmTap");
  await new Promise<void>((resolve) => {
    const to = setTimeout(() => resolve(), 5000);
    socket.once("stopDmTap:result", () => { clearTimeout(to); resolve(); });
    socket.emit("stopDmTap");
  });

  log("resumo: " + received.length + " mensagem(ns) capturada(s)");
  for (let i = 0; i < received.length; i++) {
    const m = received[i];
    console.log("  [" + i + "] [Grampo DM] Remetente: " + m.senderId +
      " | Mensagem: '" + m.text + "'" +
      (m.threadId ? " (thread " + m.threadId + ")" : "") +
      " source=" + m.source + " topic=" + m.topic);
  }

  socket.disconnect();
  process.exit(received.length > 0 ? 0 : 2);
}

main().catch((err) => {
  console.error("FATAL", err);
  process.exit(1);
});

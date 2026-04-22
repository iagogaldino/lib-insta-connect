import "dotenv/config";
import readline from "node:readline";
import { io, Socket } from "socket.io-client";

const serverUrl = process.env.SOCKET_URL || "http://localhost:4010";
const serverConnectionInfo = parseServerConnectionInfo(serverUrl);
let messageModeTarget: string | null = null;
const socket: Socket = io(serverUrl, {
  transports: ["websocket"],
});

function log(message: string, meta?: unknown): void {
  if (messageModeTarget) {
    return;
  }
  if (typeof meta === "undefined") {
    console.log(`[${new Date().toISOString()}] [socket-client] ${message}`);
    return;
  }
  console.log(
    `[${new Date().toISOString()}] [socket-client] ${message} ${JSON.stringify(meta)}`,
  );
}

function parseServerConnectionInfo(url: string): { host: string; port: string; protocol: string } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
      protocol: parsed.protocol.replace(":", ""),
    };
  } catch {
    return {
      host: url,
      port: "desconhecida",
      protocol: "desconhecido",
    };
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

function formatDmTapMessage(payload: unknown): string | null {
  const data = toRecord(payload);
  if (!data) {
    return null;
  }

  const senderUsername = String(data.senderUsername ?? "").trim();
  const senderName = String(data.senderName ?? "").trim();
  const senderId = String(data.senderId ?? "").trim();
  const text = String(data.text ?? "").trim();
  const voiceSimpleId =
    typeof data.voiceSimpleId === "number" && Number.isFinite(data.voiceSimpleId)
      ? data.voiceSimpleId
      : null;
  const isVoice = Boolean(
    data.voiceMediaUrl || /voice message/i.test(text) || /mensagem de voz/i.test(text),
  );

  if (!text && isVoice) {
    const sender = senderUsername || senderName || senderId || "desconhecido";
    if (voiceSimpleId != null) {
      return `[#${voiceSimpleId}] ${sender}: (audio)`;
    }
    return `${sender}: (audio)`;
  }

  if (!text) {
    return null;
  }

  const sender = senderUsername || senderName || senderId || "desconhecido";
  if (voiceSimpleId != null) {
    return `[#${voiceSimpleId}] ${sender}: ${text}`;
  }
  return `${sender}: ${text}`;
}

function printHelp(): void {
  console.log("");
  console.log("Comandos disponiveis:");
  console.log("  openLogin");
  console.log("  login <username> <password>");
  console.log("  listConversations [limit]");
  console.log("  listConversationsIntercept [timeoutMs]");
  console.log("  debugInboxTraffic [timeoutMs]");
  console.log("  debugMessageTransport [timeoutMs]");
  console.log("  debugMessageTransportOnly [timeoutMs]");
  console.log("  debugInstagramSocket [timeoutMs]");
  console.log("  debugInstagramSocketDirect [timeoutMs]");
  console.log("  probeInstagramRealtime [timeoutMs]");
  console.log("  openConversation <conversationTitle>");
  console.log('  sendMessage <conversationTitle> | <text>');
  console.log("  listMessages <threadId> [limit]");
  console.log("  startMessageListener");
  console.log("  stopMessageListener");
  console.log("  startThreadListener <threadId>");
  console.log("  stopThreadListener");
  console.log("  startDmTap [debug]");
  console.log("  stopDmTap");
  console.log("  getDmTapStats");
  console.log("  resolveVoiceMessage <senderUsername> | <id numerico do audio>");
  console.log("  mto:<senderUsername>");
  console.log("  closeBrowser");
  console.log("  help");
  console.log("  exit");
  console.log("");
}

function printMessageModeHelp(targetUsername: string): void {
  console.log("");
  console.log(`Modo conversa com "${targetUsername}" ativo.`);
  console.log("Digite a mensagem e pressione Enter para enviar.");
  console.log("Comandos deste modo:");
  console.log("  /sair   - encerra o modo conversa");
  console.log("  /help   - mostra esta ajuda");
  console.log("  /audio     - link do ultimo audio desta conversa");
  console.log("  /audio <n> - link do audio com id simples (ex: /audio 2)");
  console.log("");
}

log("tentando conectar ao servidor", {
  serverUrl,
  host: serverConnectionInfo.host,
  port: serverConnectionInfo.port,
  protocol: serverConnectionInfo.protocol,
});

socket.on("connect", () => {
  log("conectado com sucesso", {
    serverUrl,
    host: serverConnectionInfo.host,
    port: serverConnectionInfo.port,
    socketId: socket.id,
  });
  printHelp();
});

socket.on("connect_error", (error) => {
  log("falha ao conectar", {
    serverUrl,
    host: serverConnectionInfo.host,
    port: serverConnectionInfo.port,
    error: error.message,
  });
});

socket.on("disconnect", (reason) => {
  log("desconectado", { reason });
});

socket.on("status", (payload) => {
  log("status recebido", payload);
});

socket.on("openLogin:result", (payload) => {
  log("openLogin:result", payload);
});

socket.on("login:result", (payload) => {
  log("login:result", payload);
});

socket.on("closeBrowser:result", (payload) => {
  log("closeBrowser:result", payload);
});

socket.on("listConversations:result", (payload) => {
  log("listConversations:result", payload);
});

socket.on("listConversationsIntercept:result", (payload) => {
  log("listConversationsIntercept:result", payload);
});

socket.on("debugInboxTraffic:result", (payload) => {
  log("debugInboxTraffic:result", payload);
});

socket.on("debugMessageTransport:result", (payload) => {
  log("debugMessageTransport:result", payload);
});

socket.on("debugInstagramSocket:result", (payload) => {
  log("debugInstagramSocket:result", payload);
});

socket.on("probeInstagramRealtime:result", (payload) => {
  log("probeInstagramRealtime:result", payload);
});

socket.on("openConversation:result", (payload) => {
  log("openConversation:result", payload);
});

socket.on("sendMessage:result", (payload) => {
  log("sendMessage:result", payload);
});

socket.on("listMessages:result", (payload) => {
  log("listMessages:result", payload);
});

socket.on("startMessageListener:result", (payload) => {
  log("startMessageListener:result", payload);
});

socket.on("stopMessageListener:result", (payload) => {
  log("stopMessageListener:result", payload);
});

socket.on("newMessage", (payload) => {
  log("newMessage", payload);
});

socket.on("startThreadListener:result", (payload) => {
  log("startThreadListener:result", payload);
});

socket.on("stopThreadListener:result", (payload) => {
  log("stopThreadListener:result", payload);
});

socket.on("startDmTap:result", (payload) => {
  log("startDmTap:result", payload);
});

socket.on("stopDmTap:result", (payload) => {
  log("stopDmTap:result", payload);
});

socket.on("getDmTapStats:result", (payload) => {
  log("getDmTapStats:result", payload);
});

socket.on("dmTap:newMessage", (payload) => {
  if (messageModeTarget) {
    const data = toRecord(payload);
    const senderUsername = String(data?.senderUsername ?? "").trim().toLowerCase();
    if (senderUsername && senderUsername !== messageModeTarget.toLowerCase()) {
      return;
    }

    const formatted = formatDmTapMessage(payload);
    const playbackUrl = String(data?.playbackUrl ?? "").trim();
    if (formatted) {
      console.log(`[DM] ${formatted}`);
    }
    if (playbackUrl) {
      const sid =
        typeof data?.voiceSimpleId === "number" && Number.isFinite(data.voiceSimpleId)
          ? data.voiceSimpleId
          : null;
      console.log(sid != null ? `[AUDIO #${sid}] ${playbackUrl}` : `[AUDIO] ${playbackUrl}`);
    }
    if (formatted || playbackUrl) {
      rl.prompt(true);
      return;
    }
  }

  log("dmTap:newMessage", payload);
});

socket.on("dmTap:debug", (payload) => {
  log("dmTap:debug", payload);
});

socket.on("resolveVoiceMessage:result", (payload) => {
  const data = toRecord(payload);
  const ok = Boolean(data?.ok);
  if (messageModeTarget) {
    if (!ok) {
      console.log("[AUDIO] Nao foi possivel localizar audio para este usuario.");
      rl.prompt(true);
      return;
    }
    const playbackUrl = String(data?.playbackUrl || "").trim();
    if (!playbackUrl) {
      console.log("[AUDIO] URL de audio nao disponivel.");
      rl.prompt(true);
      return;
    }
    const sid = typeof data?.voiceSimpleId === "number" ? data.voiceSimpleId : null;
    console.log(sid != null ? `[AUDIO #${sid}] ${playbackUrl}` : `[AUDIO] ${playbackUrl}`);
    rl.prompt(true);
    return;
  }
  log("resolveVoiceMessage:result", payload);
});

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  prompt: "insta> ",
});

rl.prompt();

rl.on("line", (line: string) => {
  const input = line.trim();
  if (!input) {
    rl.prompt();
    return;
  }

  const [command, ...args] = input.split(" ");

  if (messageModeTarget) {
    if (input === "/sair") {
      log("modo conversa encerrado", { target: messageModeTarget });
      messageModeTarget = null;
      rl.setPrompt("insta> ");
    } else if (input === "/help") {
      printMessageModeHelp(messageModeTarget);
    } else if (input === "/audio" || input.startsWith("/audio ")) {
      const parts = input.split(/\s+/);
      if (parts.length === 1) {
        socket.emit("resolveVoiceMessage", { senderUsername: messageModeTarget });
      } else {
        const n = Number(parts[1]);
        if (Number.isFinite(n) && n > 0) {
          socket.emit("resolveVoiceMessage", { voiceSimpleId: Math.floor(n) });
        } else {
          console.log("[AUDIO] id invalido. Exemplo: /audio 2");
        }
      }
    } else {
      socket.emit("sendMessage", {
        conversationTitle: messageModeTarget,
        text: input,
        dedicatedTab: true,
      });
    }
  } else if (command.startsWith("mto:")) {
    const targetUsername = command.slice(4).trim();
    if (!targetUsername) {
      log("uso invalido", { expected: "mto:<senderUsername>" });
    } else {
      messageModeTarget = targetUsername;
      rl.setPrompt(`mto:${targetUsername}> `);
      log("modo conversa iniciado", { target: targetUsername });
      log("enviando comando", {
        command: "openConversation",
        conversationTitle: targetUsername,
        dedicatedTab: true,
      });
      socket.emit("openConversation", {
        conversationTitle: targetUsername,
        dedicatedTab: true,
        autoStartDmTap: true,
      });
      printMessageModeHelp(targetUsername);
    }
  } else if (command === "openLogin") {
    log("enviando comando", { command: "openLogin" });
    socket.emit("openLogin");
  } else if (command === "login") {
    const username = args[0];
    const password = args.slice(1).join(" ");
    if (!username || !password) {
      log("uso invalido", { expected: "login <username> <password>" });
    } else {
      log("enviando comando", { command: "login", username });
      socket.emit("login", { username, password });
    }
  } else if (command === "closeBrowser") {
    log("enviando comando", { command: "closeBrowser" });
    socket.emit("closeBrowser");
  } else if (command === "listConversations") {
    const limit = args[0] ? Number(args[0]) : 20;
    log("enviando comando", { command: "listConversations", limit });
    socket.emit("listConversations", { limit });
  } else if (command === "listConversationsIntercept") {
    const timeoutMs = args[0] ? Number(args[0]) : 25000;
    log("enviando comando", { command: "listConversationsIntercept", timeoutMs });
    socket.emit("listConversationsIntercept", { timeoutMs });
  } else if (command === "debugInboxTraffic") {
    const timeoutMs = args[0] ? Number(args[0]) : 12000;
    log("enviando comando", { command: "debugInboxTraffic", timeoutMs });
    socket.emit("debugInboxTraffic", { timeoutMs });
  } else if (command === "debugMessageTransport") {
    const timeoutMs = args[0] ? Number(args[0]) : 15000;
    log("enviando comando", { command: "debugMessageTransport", timeoutMs });
    socket.emit("debugMessageTransport", { timeoutMs });
  } else if (command === "debugMessageTransportOnly") {
    const timeoutMs = args[0] ? Number(args[0]) : 15000;
    log("enviando comando", {
      command: "debugMessageTransport",
      timeoutMs,
      withMessagesOnly: true,
    });
    socket.emit("debugMessageTransport", { timeoutMs, withMessagesOnly: true });
  } else if (command === "debugInstagramSocket") {
    const timeoutMs = args[0] ? Number(args[0]) : 15000;
    log("enviando comando", { command: "debugInstagramSocket", timeoutMs });
    socket.emit("debugInstagramSocket", { timeoutMs });
  } else if (command === "debugInstagramSocketDirect") {
    const timeoutMs = args[0] ? Number(args[0]) : 15000;
    log("enviando comando", { command: "debugInstagramSocket", timeoutMs, directOnly: true });
    socket.emit("debugInstagramSocket", { timeoutMs, directOnly: true });
  } else if (command === "probeInstagramRealtime") {
    const timeoutMs = args[0] ? Number(args[0]) : 15000;
    log("enviando comando", { command: "probeInstagramRealtime", timeoutMs });
    socket.emit("probeInstagramRealtime", { timeoutMs });
  } else if (command === "openConversation") {
    const conversationTitle = args.join(" ").trim();
    if (!conversationTitle) {
      log("uso invalido", { expected: "openConversation <conversationTitle>" });
    } else {
      log("enviando comando", { command: "openConversation", conversationTitle });
      socket.emit("openConversation", { conversationTitle });
    }
  } else if (command === "sendMessage") {
    const raw = args.join(" ");
    const [conversationTitle, ...textParts] = raw.split("|").map((x) => x.trim());
    const text = textParts.join(" | ");
    if (!conversationTitle || !text) {
      log("uso invalido", { expected: "sendMessage <conversationTitle> | <text>" });
    } else {
      log("enviando comando", {
        command: "sendMessage",
        conversationTitle,
        textLength: text.length,
      });
      socket.emit("sendMessage", { conversationTitle, text });
    }
  } else if (command === "listMessages") {
    const threadId = String(args[0] || "").trim();
    const limit = args[1] ? Number(args[1]) : 20;
    if (!threadId) {
      log("uso invalido", { expected: "listMessages <threadId> [limit]" });
    } else {
      log("enviando comando", { command: "listMessages", threadId, limit });
      socket.emit("listMessages", { threadId, limit });
    }
  } else if (command === "startMessageListener") {
    log("enviando comando", { command: "startMessageListener" });
    socket.emit("startMessageListener");
  } else if (command === "stopMessageListener") {
    log("enviando comando", { command: "stopMessageListener" });
    socket.emit("stopMessageListener");
  } else if (command === "startThreadListener") {
    const threadId = String(args[0] || "").trim();
    if (!threadId) {
      log("uso invalido", { expected: "startThreadListener <threadId>" });
    } else {
      log("enviando comando", { command: "startThreadListener", threadId });
      socket.emit("startThreadListener", { threadId });
    }
  } else if (command === "stopThreadListener") {
    log("enviando comando", { command: "stopThreadListener" });
    socket.emit("stopThreadListener");
  } else if (command === "startDmTap") {
    const debugInput = String(args[0] ?? "").trim().toLowerCase();
    const debug = debugInput === "1" || debugInput === "true" || debugInput === "debug";
    log("enviando comando", { command: "startDmTap", debug });
    socket.emit("startDmTap", { debug });
  } else if (command === "stopDmTap") {
    log("enviando comando", { command: "stopDmTap" });
    socket.emit("stopDmTap");
  } else if (command === "getDmTapStats") {
    log("enviando comando", { command: "getDmTapStats" });
    socket.emit("getDmTapStats");
  } else if (command === "resolveVoiceMessage") {
    const rest = args.join(" ").trim();
    if (!rest) {
      log("uso invalido", { expected: "resolveVoiceMessage <senderUsername> | <id numerico>" });
    } else if (/^\d+$/.test(rest)) {
      const voiceSimpleId = Number.parseInt(rest, 10);
      log("enviando comando", { command: "resolveVoiceMessage", voiceSimpleId });
      socket.emit("resolveVoiceMessage", { voiceSimpleId });
    } else {
      log("enviando comando", { command: "resolveVoiceMessage", senderUsername: rest });
      socket.emit("resolveVoiceMessage", { senderUsername: rest });
    }
  } else if (command === "help") {
    if (messageModeTarget) {
      printMessageModeHelp(messageModeTarget);
    } else {
      printHelp();
    }
  } else if (command === "exit") {
    log("encerrando cliente");
    socket.disconnect();
    rl.close();
    process.exit(0);
  } else {
    log("comando desconhecido", { command });
    printHelp();
  }

  rl.prompt();
});

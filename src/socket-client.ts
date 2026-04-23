import readline from "node:readline";
import { io, Socket } from "socket.io-client";
import { formatDmTapMessage, toRecord } from "./client/dm-tap-format";
import { printHelp, printMessageModeHelp } from "./client/help";

const serverUrl = process.argv[2] || "http://localhost:4010";
const serverConnectionInfo = parseServerConnectionInfo(serverUrl);
let messageModeTarget: string | null = null;
let activeSessionId: string | null = "ec3cf1d5-af25-4234-8e4b-927fa96d79fc";
let waitingAutoSession = false;
let waitingSecurityCode = false;
const socket: Socket = io(serverUrl, {
  transports: ["websocket"],
});

const sessionRequiredCommands = new Set<string>([
  "openLogin",
  "login",
  "submitSecurityCode",
  "closeBrowser",
  "listConversations",
  "searchUsers",
  "listSuggestedPeople",
  "getSuggestedUsersData",
  "followUser",
  "autoFollowSuggested",
  "autoFollowFollowers",
  "listConversationsIntercept",
  "debugInboxTraffic",
  "debugMessageTransport",
  "debugInstagramSocket",
  "probeInstagramRealtime",
  "openConversation",
  "sendMessage",
  "listMessages",
  "startMessageListener",
  "stopMessageListener",
  "startThreadListener",
  "stopThreadListener",
  "startDmTap",
  "stopDmTap",
  "getDmTapStats",
  "resolveVoiceMessage",
  "resolveImageMessage",
]);
const originalEmit = socket.emit.bind(socket);
(socket as unknown as { emit: (event: string, payload?: unknown) => Socket }).emit = ((
  event: string,
  payload?: unknown,
) => {
  if (!sessionRequiredCommands.has(event)) {
    return originalEmit(event, payload);
  }
  if (!activeSessionId) {
    log("nenhuma sessao ativa. Use createSession/useSession antes.");
    return socket;
  }
  const data = toRecord(payload) ?? {};
  return originalEmit(event, {
    ...data,
    sessionId: activeSessionId,
  });
}) as unknown as Socket["emit"];

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
  if (activeSessionId) {
    waitingAutoSession = true;
    originalEmit("createSession", { sessionId: activeSessionId });
  } else {
    waitingAutoSession = true;
    originalEmit("createSession", {});
  }
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

socket.on("createSession:result", (payload) => {
  const data = toRecord(payload);
  if (data?.ok && typeof data.sessionId === "string") {
    if (waitingAutoSession || !activeSessionId) {
      activeSessionId = data.sessionId;
      log("sessao ativa", { sessionId: activeSessionId });
    }
    waitingAutoSession = false;
  }
  log("createSession:result", payload);
});

socket.on("listSessions:result", (payload) => {
  const data = toRecord(payload);
  if (data?.ok && Array.isArray(data.sessions)) {
    console.log("Sessoes:");
    for (const raw of data.sessions) {
      const s = toRecord(raw);
      if (!s) continue;
      const sid = String(s.sessionId || "");
      const marker = sid && sid === activeSessionId ? " *ativa" : "";
      console.log(`  - ${sid}${marker}`);
    }
  }
  log("listSessions:result", payload);
});

socket.on("closeSession:result", (payload) => {
  const data = toRecord(payload);
  if (data?.ok && activeSessionId && String(data.sessionId || "") === activeSessionId) {
    activeSessionId = null;
    log("sessao ativa encerrada");
  }
  log("closeSession:result", payload);
});

socket.on("openLogin:result", (payload) => {
  log("openLogin:result", payload);
});

socket.on("login:result", (payload) => {
  const data = toRecord(payload);
  const challengeRequired = Boolean(data?.challengeRequired);
  if (data?.ok && challengeRequired) {
    waitingSecurityCode = true;
    rl.setPrompt("2fa> ");
    const challengeType = String(data?.challengeType || "security_code");
    const challengeMessage = String(
      data?.message || "Codigo de seguranca necessario. Digite o codigo e pressione Enter.",
    );
    console.log(`[2FA] ${challengeMessage} (tipo: ${challengeType})`);
    rl.prompt(true);
  } else if (data?.ok && waitingSecurityCode) {
    waitingSecurityCode = false;
    rl.setPrompt(messageModeTarget ? `mto:${messageModeTarget}> ` : "insta> ");
  }
  log("login:result", payload);
});

socket.on("submitSecurityCode:result", (payload) => {
  const data = toRecord(payload);
  if (data?.ok) {
    const challengeRequired = Boolean(data.challengeRequired);
    if (challengeRequired) {
      waitingSecurityCode = true;
      rl.setPrompt("2fa> ");
      console.log(
        `[2FA] Codigo recebido, mas o Instagram ainda pede verificacao. Tente novamente.`,
      );
    } else {
      waitingSecurityCode = false;
      rl.setPrompt(messageModeTarget ? `mto:${messageModeTarget}> ` : "insta> ");
      console.log("[2FA] Codigo confirmado com sucesso.");
    }
    rl.prompt(true);
  }
  log("submitSecurityCode:result", payload);
});

socket.on("closeBrowser:result", (payload) => {
  log("closeBrowser:result", payload);
});

socket.on("listConversations:result", (payload) => {
  const data = toRecord(payload);
  if (data && data.ok) {
    const list = data.conversations;
    if (Array.isArray(list) && list.length > 0) {
      for (const c of list) {
        const o = toRecord(c);
        if (!o) continue;
        const title = String(o.title ?? "").trim() || "(sem titulo)";
        const preview = String(o.preview ?? "").trim();
        const href = String(o.href ?? "").trim();
        const line = preview ? `  ${title} — ${preview}` : `  ${title}`;
        console.log(href ? `${line}\n    ${href}` : line);
      }
    } else {
      console.log("  (nenhuma conversa retornada)");
    }
  }
  log("listConversations:result", payload);
});

socket.on("searchUsers:result", (payload) => {
  const data = toRecord(payload);
  if (data && data.ok) {
    const users = data.users;
    if (Array.isArray(users) && users.length > 0) {
      for (const u of users) {
        const o = toRecord(u);
        if (!o) continue;
        const un = String(o.username ?? "");
        const fn = String(o.fullName ?? "").trim();
        const href = String(o.href ?? "");
        const v = o.isVerified ? " [v]" : "";
        console.log(`  @${un}${v}${fn ? ` | ${fn}` : ""} ${href}`);
      }
    }
  }
  log("searchUsers:result", payload);
});

socket.on("listSuggestedPeople:result", (payload) => {
  const data = toRecord(payload);
  if (data && data.ok) {
    const users = data.users;
    if (Array.isArray(users) && users.length > 0) {
      for (const u of users) {
        const o = toRecord(u);
        if (!o) continue;
        const un = String(o.username ?? "");
        const fn = String(o.fullName ?? "").trim();
        const href = String(o.href ?? "");
        const reason = String(o.reason ?? "").trim();
        const v = o.isVerified ? " [v]" : "";
        const detail = [fn, reason].filter(Boolean).join(" | ");
        console.log(`  @${un}${v}${detail ? ` | ${detail}` : ""} ${href}`);
      }
    } else {
      console.log("  (nenhuma sugestao retornada)");
    }
  }
  log("listSuggestedPeople:result", payload);
});

socket.on("getSuggestedUsersData:result", (payload) => {
  const data = toRecord(payload);
  if (data && data.ok) {
    const users = data.users;
    if (Array.isArray(users) && users.length > 0) {
      for (const u of users) {
        const o = toRecord(u);
        if (!o) continue;
        const userId = String(o.userId ?? "");
        const un = String(o.username ?? "");
        const fn = String(o.fullName ?? "").trim();
        const isPrivate = Boolean(o.isPrivate);
        const isVerified = Boolean(o.isVerified);
        const social = String(o.reason ?? "").trim();
        const flags = `${isVerified ? " [v]" : ""}${isPrivate ? " [private]" : ""}`;
        const meta = [fn, social].filter(Boolean).join(" | ");
        console.log(`  ${userId} @${un}${flags}${meta ? ` | ${meta}` : ""}`);
      }
    } else {
      console.log("  (nenhum usuario retornado)");
    }
  }
  log("getSuggestedUsersData:result", payload);
});

socket.on("followUser:result", (payload) => {
  const data = toRecord(payload);
  if (data?.ok) {
    const userId = String(data.userId || "");
    const following = Boolean(toRecord(data.friendshipStatus)?.following);
    const prev = data.previousFollowing;
    console.log(
      `[followUser] userId=${userId} following=${following} previousFollowing=${String(prev)}`,
    );
  }
  log("followUser:result", payload);
});

socket.on("autoFollowSuggested:result", (payload) => {
  const data = toRecord(payload);
  if (data?.ok) {
    console.log(
      `[auto] requested=${String(data.requested)} attempted=${String(data.attempted)} followed=${String(data.followed)} privacyFilter=${String(data.privacyFilter || "any")}`,
    );
    const rows = Array.isArray(data.results) ? data.results : [];
    for (const row of rows) {
      const item = toRecord(row);
      if (!item) continue;
      const username = String(item.username || "");
      const userId = String(item.userId || "");
      const privacy = typeof item.isPrivate === "boolean" ? (item.isPrivate ? "private" : "public") : "unknown";
      const ok = Boolean(item.success);
      const error = String(item.error || "").trim();
      console.log(
        `  - @${username}${userId ? ` (${userId})` : ""} [${privacy}] => ${ok ? "ok" : `falhou${error ? `: ${error}` : ""}`}`,
      );
    }
  }
  log("autoFollowSuggested:result", payload);
});

socket.on("autoFollowFollowers:result", (payload) => {
  const data = toRecord(payload);
  if (data?.ok) {
    console.log(
      `[auto followers] @${String(data.targetUsername || "")} (targetId=${String(data.targetUserId || "")} via=${String(data.profileOpenedVia || "")}) ` +
        `requested=${String(data.requested)} attempted=${String(data.attempted)} followed=${String(data.followed)} privacyFilter=${String(data.privacyFilter || "any")}`,
    );
    const rows = Array.isArray(data.results) ? data.results : [];
    for (const row of rows) {
      const item = toRecord(row);
      if (!item) continue;
      const username = String(item.username || "");
      const userId = String(item.userId || "");
      const privacy = typeof item.isPrivate === "boolean" ? (item.isPrivate ? "private" : "public") : "unknown";
      const ok = Boolean(item.success);
      const error = String(item.error || "").trim();
      console.log(
        `  - @${username}${userId ? ` (${userId})` : ""} [${privacy}] => ${ok ? "ok" : `falhou${error ? `: ${error}` : ""}`}`,
      );
    }
  }
  log("autoFollowFollowers:result", payload);
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
  if (messageModeTarget) {
    const data = toRecord(payload);
    const ok = data?.ok === true;
    if (!ok) {
      console.log(
        `[mto] Falha ao abrir conversa: ${String(data?.error ?? "erro desconhecido")}`,
      );
    } else {
      const err = String(data?.messagesLoadError ?? "").trim();
      if (err) {
        console.log(`[mto] Historico nao carregado: ${err}`);
      } else {
        const raw = data?.messages;
        const messages = Array.isArray(raw) ? raw : [];
        const count =
          typeof data?.messageCount === "number" && Number.isFinite(data.messageCount)
            ? data.messageCount
            : messages.length;
        if (messages.length > 0) {
          console.log(`[mto] Historico carregado (${count} msg):`);
          for (const m of messages) {
            const row = toRecord(m);
            const text = String(row?.text ?? "");
            const sender = String(row?.sender ?? "other");
            const who = sender === "me" ? "voce" : "outro";
            const ts = String(row?.timestamp ?? "").trim();
            const line = ts ? `  [${who}] [${ts}] ${text}` : `  [${who}] ${text}`;
            console.log(line);
          }
        } else {
          console.log("[mto] Conversa aberta. (nenhum historico retornado ainda)");
        }
      }
    }
    rl.prompt(true);
    return;
  }
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
    // Nao repete o link /image/... a cada evento: use /foto (resolveImageMessage) para ver a URL.
    if (formatted || playbackUrl || String(data?.imageViewUrl ?? "").trim()) {
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

socket.on("resolveImageMessage:result", (payload) => {
  const data = toRecord(payload);
  const ok = Boolean(data?.ok);
  if (messageModeTarget) {
    if (!ok) {
      console.log("[FOTO] Nao foi possivel localizar imagem para este usuario.");
      rl.prompt(true);
      return;
    }
    const imageViewUrl = String(data?.imageViewUrl || "").trim();
    if (!imageViewUrl) {
      console.log("[FOTO] URL da imagem nao disponivel.");
      rl.prompt(true);
      return;
    }
    const iid = typeof data?.imageSimpleId === "number" ? data.imageSimpleId : null;
    console.log(iid != null ? `[FOTO #${iid}] ${imageViewUrl}` : `[FOTO] ${imageViewUrl}`);
    rl.prompt(true);
    return;
  }
  log("resolveImageMessage:result", payload);
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

  if (waitingSecurityCode) {
    if (input === "cancel2fa" || input === "/cancel2fa") {
      waitingSecurityCode = false;
      rl.setPrompt(messageModeTarget ? `mto:${messageModeTarget}> ` : "insta> ");
      log("modo de codigo de seguranca encerrado");
      rl.prompt();
      return;
    }
    if (!input.startsWith("submitSecurityCode ")) {
      log("enviando comando", { command: "submitSecurityCode" });
      socket.emit("submitSecurityCode", { code: input });
      rl.prompt();
      return;
    }
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
    } else if (input === "/foto" || input.startsWith("/foto ")) {
      const parts = input.split(/\s+/);
      if (parts.length === 1) {
        socket.emit("resolveImageMessage", { senderUsername: messageModeTarget });
      } else {
        const n = Number(parts[1]);
        if (Number.isFinite(n) && n > 0) {
          socket.emit("resolveImageMessage", { imageSimpleId: Math.floor(n) });
        } else {
          console.log("[FOTO] id invalido. Exemplo: /foto 2");
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
        preloadMessages: true,
      });
      printMessageModeHelp(targetUsername);
    }
  } else if (command.startsWith("autoFollow:")) {
    const rawQty = command.slice("autoFollow:".length).trim();
    const quantity = Number(rawQty);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      log("uso invalido", { expected: "autoFollow:<quantidade>" });
    } else {
      log("enviando comando", { command: "autoFollowSuggested", quantity: Math.floor(quantity) });
      socket.emit("autoFollowSuggested", { quantity: Math.floor(quantity) });
    }
  } else if (command === "autoFollow") {
    const quantity = Number(args[0]);
    const rawPrivacy = String(args[1] || "any")
      .trim()
      .toLowerCase();
    const privacyFilter =
      rawPrivacy === "public" || rawPrivacy === "private" || rawPrivacy === "any" ? rawPrivacy : null;
    if (!Number.isFinite(quantity) || quantity <= 0 || !privacyFilter) {
      log("uso invalido", { expected: "autoFollow <quantidade> [public|private|any]" });
    } else {
      log("enviando comando", {
        command: "autoFollowSuggested",
        quantity: Math.floor(quantity),
        privacyFilter,
      });
      socket.emit("autoFollowSuggested", { quantity: Math.floor(quantity), privacyFilter });
    }
  } else if (command === "autoFollowFollowers") {
    const targetUsername = String(args[0] || "").trim();
    const quantity = Number(args[1]);
    const rawPrivacy = String(args[2] || "any")
      .trim()
      .toLowerCase();
    const privacyFilter =
      rawPrivacy === "public" || rawPrivacy === "private" || rawPrivacy === "any" ? rawPrivacy : null;
    if (!targetUsername || !Number.isFinite(quantity) || quantity <= 0 || !privacyFilter) {
      log("uso invalido", {
        expected: "autoFollowFollowers <targetUsername> <quantidade> [public|private|any]",
      });
    } else {
      log("enviando comando", {
        command: "autoFollowFollowers",
        targetUsername,
        quantity: Math.floor(quantity),
        privacyFilter,
      });
      socket.emit("autoFollowFollowers", {
        targetUsername,
        quantity: Math.floor(quantity),
        privacyFilter,
      });
    }
  } else if (command === "createSession") {
    const sessionId = String(args[0] || "").trim();
    waitingAutoSession = true;
    log("enviando comando", { command: "createSession", sessionId: sessionId || "(auto)" });
    originalEmit("createSession", sessionId ? { sessionId } : {});
  } else if (command === "listSessions") {
    log("enviando comando", { command: "listSessions" });
    originalEmit("listSessions", {});
  } else if (command === "useSession") {
    const sessionId = String(args[0] || "").trim();
    if (!sessionId) {
      log("uso invalido", { expected: "useSession <sessionId>" });
    } else {
      activeSessionId = sessionId;
      log("sessao ativa alterada", { sessionId });
    }
  } else if (command === "closeSession") {
    const sessionId = String(args[0] || "").trim();
    if (!sessionId) {
      log("uso invalido", { expected: "closeSession <sessionId>" });
    } else {
      log("enviando comando", { command: "closeSession", sessionId });
      originalEmit("closeSession", { sessionId });
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
  } else if (command === "submitSecurityCode") {
    const code = args.join(" ").trim();
    if (!code) {
      log("uso invalido", { expected: "submitSecurityCode <codigo>" });
    } else {
      log("enviando comando", { command: "submitSecurityCode" });
      socket.emit("submitSecurityCode", { code });
    }
  } else if (command === "closeBrowser") {
    log("enviando comando", { command: "closeBrowser" });
    socket.emit("closeBrowser");
  } else if (command === "listConversations") {
    const limit = args[0] ? Number(args[0]) : 20;
    log("enviando comando", { command: "listConversations", limit });
    socket.emit("listConversations", { limit });
  } else if (command === "searchUsers") {
    if (args.length < 1) {
      log("uso invalido", { expected: "searchUsers <query> [limite de resultados]" });
    } else {
      const last = args[args.length - 1];
      const lastNum = Number(last);
      let limit: number | undefined;
      let queryParts = args;
      if (args.length >= 2 && Number.isFinite(lastNum) && lastNum > 0) {
        limit = Math.floor(lastNum);
        queryParts = args.slice(0, -1);
      }
      const query = queryParts.join(" ").trim();
      if (!query) {
        log("uso invalido", { expected: "searchUsers <query> [limit]" });
      } else {
        log("enviando comando", { command: "searchUsers", query, limit: limit ?? "default" });
        socket.emit("searchUsers", { query, limit });
      }
    }
  } else if (command === "listSuggestedPeople") {
    const limit = args[0] ? Number(args[0]) : undefined;
    log("enviando comando", { command: "listSuggestedPeople", limit: limit ?? "default" });
    socket.emit("listSuggestedPeople", { limit });
  } else if (command === "getSuggestedUsersData") {
    const targetId = String(args[0] || "").trim();
    const limit = args[1] ? Number(args[1]) : undefined;
    if (!targetId) {
      log("uso invalido", { expected: "getSuggestedUsersData <targetId> [limit]" });
    } else {
      log("enviando comando", {
        command: "getSuggestedUsersData",
        targetId,
        limit: limit ?? "default",
      });
      socket.emit("getSuggestedUsersData", { targetId, limit });
    }
  } else if (command === "followUser") {
    const userId = String(args[0] || "").trim();
    if (!userId) {
      log("uso invalido", { expected: "followUser <userId>" });
    } else {
      log("enviando comando", { command: "followUser", userId });
      socket.emit("followUser", { userId });
    }
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
  } else if (command === "resolveImageMessage") {
    const rest = args.join(" ").trim();
    if (!rest) {
      log("uso invalido", { expected: "resolveImageMessage <senderUsername> | <id numerico>" });
    } else if (/^\d+$/.test(rest)) {
      const imageSimpleId = Number.parseInt(rest, 10);
      log("enviando comando", { command: "resolveImageMessage", imageSimpleId });
      socket.emit("resolveImageMessage", { imageSimpleId });
    } else {
      log("enviando comando", { command: "resolveImageMessage", senderUsername: rest });
      socket.emit("resolveImageMessage", { senderUsername: rest });
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

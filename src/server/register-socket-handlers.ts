import type { Server } from "socket.io";
import type { InstaConnect } from "../insta-connect/InstaConnect";
import type { MediaProxy } from "./media-proxy";

export function registerSocketServer(
  io: Server,
  options: {
    client: InstaConnect;
    media: MediaProxy;
    log: (message: string, meta?: Record<string, unknown>) => void;
  },
): void {
  const { client, media, log } = options;
  io.on("connection", (socket) => {
  let startListenerPromise: Promise<{ started: boolean; url: string }> | null = null;
  let listenerStarted = false;

  const executeStartDmTap = async (debugEnabled: boolean) => {
    return client.startDmTap(
      (evt) => {
        const voiceMeta = media.rememberVoiceEvent(evt);
        const imageMeta = media.rememberImageEvent(evt);
        const enriched = {
          ...evt,
          ...(voiceMeta
            ? {
                voiceSimpleId: voiceMeta.voiceSimpleId,
                playbackUrl: voiceMeta.playbackUrl,
              }
            : {}),
          ...(imageMeta
            ? {
                imageSimpleId: imageMeta.imageSimpleId,
                imageViewUrl: imageMeta.imageViewUrl,
              }
            : {}),
        };
        log("dmTap newMessage event", {
          socketId: socket.id,
          topic: evt.topic,
          senderId: evt.senderId,
          threadId: evt.threadId,
          preview: (evt.text || "").slice(0, 80),
          source: evt.source,
          hasVoice: Boolean(evt.voiceMediaUrl),
          hasImage: Boolean(evt.imageMediaUrl),
          voiceSimpleId: voiceMeta?.voiceSimpleId,
          imageSimpleId: imageMeta?.imageSimpleId,
        });
        socket.emit("dmTap:newMessage", enriched);
      },
      debugEnabled
        ? (msg) => {
            log("dmTap debug", { socketId: socket.id, kind: msg.kind, data: msg.data });
            socket.emit("dmTap:debug", msg);
          }
        : undefined,
    );
  };

  const ensureDmTapIfIdle = async (debugEnabled: boolean, reason: string): Promise<void> => {
    if (client.isDmTapActive()) {
      return;
    }
    log("startDmTap auto (antes de outro comando)", { socketId: socket.id, reason, debug: debugEnabled });
    try {
      const result = await executeStartDmTap(debugEnabled);
      log("startDmTap auto completed", { socketId: socket.id, ok: true, url: result.url, reason });
      socket.emit("startDmTap:result", {
        ok: true,
        ...result,
        auto: true,
        reason,
      });
    } catch (error) {
      log("startDmTap auto failed", {
        socketId: socket.id,
        ok: false,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit("startDmTap:result", {
        ok: false,
        auto: true,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  log("client connected", { socketId: socket.id });
  socket.emit("status", { message: "connected", socketId: socket.id });

  socket.on("disconnect", (reason) => {
    log("client disconnected", { socketId: socket.id, reason });
  });

  socket.on("openLogin", async () => {
    log("openLogin command received", { socketId: socket.id });
    try {
      const url = await client.openLoginPage();
      log("openLogin command completed", { socketId: socket.id, ok: true, url });
      socket.emit("openLogin:result", { ok: true, url });
    } catch (error) {
      log("openLogin command failed", {
        socketId: socket.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit("openLogin:result", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on(
    "login",
    async (payload: { username?: string; password?: string } | undefined) => {
      log("login command received", {
        socketId: socket.id,
        username: payload?.username || null,
      });
      try {
        const username = String(payload?.username || "").trim();
        const password = String(payload?.password || "");
        if (!username || !password) {
          log("login command validation failed", {
            socketId: socket.id,
            ok: false,
            reason: "missing credentials",
          });
          socket.emit("login:result", {
            ok: false,
            error: "username e password sao obrigatorios",
          });
          return;
        }

        const result = await client.login(username, password);
        log("login command completed", {
          socketId: socket.id,
          ok: true,
          success: result.success,
          url: result.url,
        });
        socket.emit("login:result", {
          ok: true,
          ...result,
        });
      } catch (error) {
        log("login command failed", {
          socketId: socket.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.emit("login:result", {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  media.registerMediaResolveHandlers(socket);

  socket.on("closeBrowser", async () => {
    log("closeBrowser command received", { socketId: socket.id });
    try {
      await client.close();
      log("closeBrowser command completed", { socketId: socket.id, ok: true });
      socket.emit("closeBrowser:result", { ok: true });
    } catch (error) {
      log("closeBrowser command failed", {
        socketId: socket.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit("closeBrowser:result", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on("listConversations", async (payload: { limit?: number } | undefined) => {
    const limit = Number(payload?.limit || 20);
    log("listConversations command received", { socketId: socket.id, limit });
    try {
      const conversations = await client.listConversations(limit);
      log("listConversations command completed", {
        socketId: socket.id,
        ok: true,
        count: conversations.length,
      });
      socket.emit("listConversations:result", {
        ok: true,
        count: conversations.length,
        conversations,
      });
    } catch (error) {
      log("listConversations command failed", {
        socketId: socket.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit("listConversations:result", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on(
    "listConversationsIntercept",
    async (payload: { timeoutMs?: number } | undefined) => {
      const timeoutMs = Number(payload?.timeoutMs || 25000);
      log("listConversationsIntercept command received", {
        socketId: socket.id,
        timeoutMs,
      });
      try {
        const conversations = await client.listConversationsByNetworkIntercept(timeoutMs);
        log("listConversationsIntercept command completed", {
          socketId: socket.id,
          ok: true,
          count: conversations.length,
        });
        socket.emit("listConversationsIntercept:result", {
          ok: true,
          count: conversations.length,
          conversations,
        });
      } catch (error) {
        log("listConversationsIntercept command failed", {
          socketId: socket.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.emit("listConversationsIntercept:result", {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  socket.on("debugInboxTraffic", async (payload: { timeoutMs?: number } | undefined) => {
    const timeoutMs = Number(payload?.timeoutMs || 12000);
    log("debugInboxTraffic command received", { socketId: socket.id, timeoutMs });
    try {
      const traffic = await client.debugInboxTraffic(timeoutMs);
      const interesting = traffic.filter(
        (t) => t.url.includes("direct") || t.url.includes("graphql") || t.type === "websocket",
      );
      log("debugInboxTraffic command completed", {
        socketId: socket.id,
        ok: true,
        count: traffic.length,
        interestingCount: interesting.length,
      });
      socket.emit("debugInboxTraffic:result", {
        ok: true,
        count: traffic.length,
        interestingCount: interesting.length,
        traffic,
      });
    } catch (error) {
      log("debugInboxTraffic command failed", {
        socketId: socket.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit("debugInboxTraffic:result", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on(
    "debugMessageTransport",
    async (payload: { timeoutMs?: number; withMessagesOnly?: boolean } | undefined) => {
      const timeoutMs = Number(payload?.timeoutMs || 15000);
      const withMessagesOnly = Boolean(payload?.withMessagesOnly);
      log("debugMessageTransport command received", {
        socketId: socket.id,
        timeoutMs,
        withMessagesOnly,
      });
      try {
        const records = await client.debugMessageTransport(timeoutMs);
        const withMessagesRecords = records.filter(
          (r) => r.phase === "response" && (r.messageCount || 0) > 0,
        );
        const outputRecords = withMessagesOnly ? withMessagesRecords : records;
        log("debugMessageTransport command completed", {
          socketId: socket.id,
          ok: true,
          count: outputRecords.length,
          withMessages: withMessagesRecords.length,
          withMessagesOnly,
        });
        socket.emit("debugMessageTransport:result", {
          ok: true,
          count: outputRecords.length,
          withMessages: withMessagesRecords.length,
          withMessagesOnly,
          records: outputRecords,
        });
      } catch (error) {
        log("debugMessageTransport command failed", {
          socketId: socket.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.emit("debugMessageTransport:result", {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  socket.on(
    "debugInstagramSocket",
    async (payload: { timeoutMs?: number; directOnly?: boolean } | undefined) => {
      const timeoutMs = Number(payload?.timeoutMs || 15000);
      const directOnly = Boolean(payload?.directOnly);
      log("debugInstagramSocket command received", { socketId: socket.id, timeoutMs, directOnly });
      try {
        const frames = await client.debugInstagramSocket(timeoutMs);
        const directFrames = frames.filter((f) => f.hasDirectSignal);
        const output = directOnly ? directFrames : frames;
        log("debugInstagramSocket command completed", {
          socketId: socket.id,
          ok: true,
          count: output.length,
          directFrames: directFrames.length,
        });
        socket.emit("debugInstagramSocket:result", {
          ok: true,
          count: output.length,
          directFrames: directFrames.length,
          directOnly,
          frames: output,
        });
      } catch (error) {
        log("debugInstagramSocket command failed", {
          socketId: socket.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.emit("debugInstagramSocket:result", {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  socket.on("probeInstagramRealtime", async (payload: { timeoutMs?: number } | undefined) => {
    const timeoutMs = Number(payload?.timeoutMs || 15000);
    log("probeInstagramRealtime command received", { socketId: socket.id, timeoutMs });
    try {
      const result = await client.probeInstagramRealtime(timeoutMs);
      log("probeInstagramRealtime command completed", {
        socketId: socket.id,
        ok: true,
        totalFrames: result.totalFrames,
        directSignalFrames: result.directSignalFrames,
        channels: result.channels.length,
      });
      socket.emit("probeInstagramRealtime:result", {
        ok: true,
        ...result,
      });
    } catch (error) {
      log("probeInstagramRealtime command failed", {
        socketId: socket.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit("probeInstagramRealtime:result", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on(
    "openConversation",
    async (payload: { conversationTitle?: string; dedicatedTab?: boolean; autoStartDmTap?: boolean } | undefined) => {
      const conversationTitle = String(payload?.conversationTitle || "").trim();
      const dedicatedTab = Boolean(payload?.dedicatedTab);
      const autoStartDmTap = Boolean(payload?.autoStartDmTap);
      log("openConversation command received", {
        socketId: socket.id,
        conversationTitle,
        dedicatedTab,
        autoStartDmTap,
      });
      try {
        if (!conversationTitle) {
          throw new Error("conversationTitle e obrigatorio.");
        }
        if (autoStartDmTap) {
          await ensureDmTapIfIdle(false, "openConversation(mto)");
        }
        const result = await client.openConversationByTitle(conversationTitle, { dedicatedTab });
        log("openConversation command completed", {
          socketId: socket.id,
          ok: true,
          conversationTitle,
          dedicatedTab,
          url: result.url,
        });
        socket.emit("openConversation:result", {
          ok: true,
          ...result,
        });
      } catch (error) {
        log("openConversation command failed", {
          socketId: socket.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.emit("openConversation:result", {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  socket.on(
    "sendMessage",
    async (payload: { conversationTitle?: string; text?: string; dedicatedTab?: boolean } | undefined) => {
      const conversationTitle = String(payload?.conversationTitle || "").trim();
      const text = String(payload?.text || "");
      const dedicatedTab = Boolean(payload?.dedicatedTab);
      log("sendMessage command received", {
        socketId: socket.id,
        conversationTitle,
        textLength: text.length,
        dedicatedTab,
      });
      try {
        if (!conversationTitle || !text) {
          throw new Error("conversationTitle e text sao obrigatorios.");
        }
        const result = await client.sendMessageToConversation(conversationTitle, text, {
          dedicatedTab,
        });
        log("sendMessage command completed", {
          socketId: socket.id,
          ok: true,
          conversationTitle,
          dedicatedTab,
        });
        socket.emit("sendMessage:result", {
          ok: true,
          ...result,
        });
      } catch (error) {
        log("sendMessage command failed", {
          socketId: socket.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.emit("sendMessage:result", {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  socket.on(
    "listMessages",
    async (payload: { threadId?: string; limit?: number } | undefined) => {
      const threadId = String(payload?.threadId || "").trim();
      const limit = Number(payload?.limit || 20);
      log("listMessages command received", {
        socketId: socket.id,
        threadId,
        limit,
      });
      try {
        if (!threadId) {
          throw new Error("threadId e obrigatorio.");
        }
        const result = await client.listMessagesByThreadId(threadId, limit);
        log("listMessages command completed", {
          socketId: socket.id,
          ok: true,
          threadId,
          count: result.count,
        });
        socket.emit("listMessages:result", {
          ok: true,
          ...result,
        });
      } catch (error) {
        log("listMessages command failed", {
          socketId: socket.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.emit("listMessages:result", {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  socket.on("startMessageListener", async () => {
    log("startMessageListener command received", { socketId: socket.id });
    try {
      if (!startListenerPromise) {
        startListenerPromise = client.startMessageListener((event) => {
          log("newMessage event", {
            socketId: socket.id,
            threadId: event.threadId,
            messageId: event.messageId,
            senderUsername: event.senderUsername,
            preview: event.text.slice(0, 80),
          });
          socket.emit("newMessage", event);
        });
      }

      const result = await startListenerPromise;
      listenerStarted = true;
      log("startMessageListener command completed", {
        socketId: socket.id,
        ok: true,
        url: result.url,
      });
      socket.emit("startMessageListener:result", {
        ok: true,
        ...result,
      });
    } catch (error) {
      startListenerPromise = null;
      listenerStarted = false;
      log("startMessageListener command failed", {
        socketId: socket.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit("startMessageListener:result", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on("stopMessageListener", () => {
    log("stopMessageListener command received", { socketId: socket.id });
    const finishStop = () => {
      const result = client.stopMessageListener();
      startListenerPromise = null;
      listenerStarted = false;
      log("stopMessageListener command completed", {
        socketId: socket.id,
        ok: true,
      });
      socket.emit("stopMessageListener:result", {
        ok: true,
        ...result,
      });
    };

    try {
      if (startListenerPromise && !listenerStarted) {
        startListenerPromise
          .then(() => finishStop())
          .catch(() => finishStop());
        return;
      }
      finishStop();
    } catch (error) {
      startListenerPromise = null;
      listenerStarted = false;
      log("stopMessageListener command failed", {
        socketId: socket.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit("stopMessageListener:result", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on(
    "startThreadListener",
    async (payload: { threadId?: string } | undefined) => {
      const threadId = String(payload?.threadId || "").trim();
      log("startThreadListener command received", { socketId: socket.id, threadId });
      try {
        if (!threadId) {
          throw new Error("threadId e obrigatorio.");
        }
        const result = await client.startThreadListener(threadId, (event) => {
          log("newMessage event", {
            socketId: socket.id,
            threadId: event.threadId,
            messageId: event.messageId,
            senderUsername: event.senderUsername,
            preview: event.text.slice(0, 80),
          });
          socket.emit("newMessage", event);
        });
        log("startThreadListener command completed", {
          socketId: socket.id,
          ok: true,
          threadId,
          url: result.url,
        });
        socket.emit("startThreadListener:result", {
          ok: true,
          ...result,
        });
      } catch (error) {
        log("startThreadListener command failed", {
          socketId: socket.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.emit("startThreadListener:result", {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  socket.on("startDmTap", async (opts?: { debug?: boolean }) => {
    const debugEnabled = Boolean(opts && opts.debug);
    log("startDmTap command received", { socketId: socket.id, debug: debugEnabled });
    try {
      const result = await executeStartDmTap(debugEnabled);
      log("startDmTap command completed", {
        socketId: socket.id,
        ok: true,
        url: result.url,
      });
      socket.emit("startDmTap:result", {
        ok: true,
        ...result,
      });
    } catch (error) {
      log("startDmTap command failed", {
        socketId: socket.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit("startDmTap:result", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on("getDmTapStats", async () => {
    log("getDmTapStats command received", { socketId: socket.id });
    try {
      const stats = await client.getDmTapStats();
      socket.emit("getDmTapStats:result", { ok: true, stats });
    } catch (error) {
      socket.emit("getDmTapStats:result", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on("stopDmTap", () => {
    log("stopDmTap command received", { socketId: socket.id });
    try {
      const result = client.stopDmTap();
      log("stopDmTap command completed", {
        socketId: socket.id,
        ok: true,
      });
      socket.emit("stopDmTap:result", {
        ok: true,
        ...result,
      });
    } catch (error) {
      log("stopDmTap command failed", {
        socketId: socket.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit("stopDmTap:result", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on("stopThreadListener", () => {
    log("stopThreadListener command received", { socketId: socket.id });
    try {
      const result = client.stopThreadListener();
      log("stopThreadListener command completed", {
        socketId: socket.id,
        ok: true,
      });
      socket.emit("stopThreadListener:result", {
        ok: true,
        ...result,
      });
    } catch (error) {
      log("stopThreadListener command failed", {
        socketId: socket.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit("stopThreadListener:result", {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});

}


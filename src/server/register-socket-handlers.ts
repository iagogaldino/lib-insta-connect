import type { Server } from "socket.io";
import type { InstaConnect } from "../insta-connect/InstaConnect";
import type { MediaProxy } from "./media-proxy";
import type { OpenConversationResult } from "../types";

function extractThreadIdFromDirectUrl(url: string): string | null {
  const m = url.match(/\/direct\/t\/([^/?#]+)/i);
  return m?.[1] ?? null;
}

type SessionContext = {
  client: InstaConnect;
  media: MediaProxy;
  createdAt: Date;
};

export function registerSocketServer(
  io: Server,
  options: {
    getSession: (sessionId: string) => SessionContext | undefined;
    listSessions: () => Array<{ sessionId: string; createdAt: Date; context: SessionContext }>;
    createSession: (sessionId?: string) => { sessionId: string; created: boolean; context: SessionContext };
    closeSession: (sessionId: string) => Promise<boolean>;
    log: (message: string, meta?: Record<string, unknown>) => void;
  },
): void {
  const { getSession, listSessions, createSession, closeSession, log } = options;

  io.on("connection", (socket) => {
    const startListenerPromises = new Map<string, Promise<{ started: boolean; url: string }>>();
    const listenerStarted = new Set<string>();

    function requireSessionId(payload: { sessionId?: string } | undefined): string | null {
      const sessionId = String(payload?.sessionId || "").trim();
      return sessionId || null;
    }

    function requireContext(
      payload: { sessionId?: string } | undefined,
      eventName: string,
    ): { sessionId: string; context: SessionContext } | null {
      const sessionId = requireSessionId(payload);
      if (!sessionId) {
        socket.emit(`${eventName}:result`, { ok: false, error: "sessionId e obrigatorio" });
        return null;
      }
      const context = getSession(sessionId);
      if (!context) {
        socket.emit(`${eventName}:result`, { ok: false, error: "sessao nao encontrada", sessionId });
        return null;
      }
      return { sessionId, context };
    }

    const executeStartDmTap = async (sessionId: string, debugEnabled: boolean) => {
      const context = getSession(sessionId);
      if (!context) throw new Error("sessao nao encontrada");
      return context.client.startDmTap(
        (evt) => {
          const voiceMeta = context.media.rememberVoiceEvent(evt);
          const imageMeta = context.media.rememberImageEvent(evt);
          socket.emit("dmTap:newMessage", {
            ...evt,
            sessionId,
            ...(voiceMeta ? { voiceSimpleId: voiceMeta.voiceSimpleId, playbackUrl: voiceMeta.playbackUrl } : {}),
            ...(imageMeta ? { imageSimpleId: imageMeta.imageSimpleId, imageViewUrl: imageMeta.imageViewUrl } : {}),
          });
        },
        debugEnabled ? (msg) => socket.emit("dmTap:debug", { ...msg, sessionId }) : undefined,
      );
    };

    const ensureDmTapIfIdle = async (sessionId: string, debugEnabled: boolean, reason: string): Promise<void> => {
      const context = getSession(sessionId);
      if (!context) {
        throw new Error("sessao nao encontrada");
      }
      if (context.client.isDmTapActive()) {
        return;
      }
      try {
        const result = await executeStartDmTap(sessionId, debugEnabled);
        socket.emit("startDmTap:result", { ok: true, sessionId, ...result, auto: true, reason });
      } catch (error) {
        socket.emit("startDmTap:result", {
          ok: false,
          sessionId,
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

    socket.on("createSession", (payload: { sessionId?: string } | undefined) => {
      try {
        const desiredId = String(payload?.sessionId || "").trim() || undefined;
        const result = createSession(desiredId);
        socket.emit("createSession:result", {
          ok: true,
          sessionId: result.sessionId,
          created: result.created,
          createdAt: result.context.createdAt.toISOString(),
        });
      } catch (error) {
        socket.emit("createSession:result", {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on("listSessions", async () => {
      try {
        const sessionsWithStatus = await Promise.all(
          listSessions().map(async (s) => {
            const status = await s.context.client.getSessionStatus().catch(() => ({
              browserOpen: false,
              currentUrl: null,
              loggedIn: false,
              challengeRequired: false,
              message: "Falha ao consultar status da sessao.",
            }));
            return {
              sessionId: s.sessionId,
              createdAt: s.createdAt.toISOString(),
              status,
            };
          }),
        );
        socket.emit("listSessions:result", {
          ok: true,
          sessions: sessionsWithStatus,
        });
      } catch (error) {
        socket.emit("listSessions:result", {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on("closeSession", async (payload: { sessionId?: string } | undefined) => {
      const sessionId = requireSessionId(payload);
      if (!sessionId) {
        socket.emit("closeSession:result", { ok: false, error: "sessionId e obrigatorio" });
        return;
      }
      try {
        const closed = await closeSession(sessionId);
        socket.emit("closeSession:result", { ok: closed, sessionId, ...(closed ? {} : { error: "sessao nao encontrada" }) });
      } catch (error) {
        socket.emit("closeSession:result", {
          ok: false,
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on("openLogin", async (payload: { sessionId?: string } | undefined) => {
      const resolved = requireContext(payload, "openLogin");
      if (!resolved) return;
      try {
        const url = await resolved.context.client.openLoginPage();
        socket.emit("openLogin:result", { ok: true, sessionId: resolved.sessionId, url });
      } catch (error) {
        socket.emit("openLogin:result", {
          ok: false,
          sessionId: resolved.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on("login", async (payload: { sessionId?: string; username?: string; password?: string } | undefined) => {
      const resolved = requireContext(payload, "login");
      if (!resolved) return;
      try {
        const username = String(payload?.username || "").trim();
        const password = String(payload?.password || "");
        if (!username || !password) {
          socket.emit("login:result", { ok: false, sessionId: resolved.sessionId, error: "username e password sao obrigatorios" });
          return;
        }
        const result = await resolved.context.client.login(username, password);
        socket.emit("login:result", { ok: true, sessionId: resolved.sessionId, ...result });
      } catch (error) {
        socket.emit("login:result", {
          ok: false,
          sessionId: resolved.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on("submitSecurityCode", async (payload: { sessionId?: string; code?: string } | undefined) => {
      const resolved = requireContext(payload, "submitSecurityCode");
      if (!resolved) return;
      try {
        const code = String(payload?.code || "").trim();
        if (!code) {
          socket.emit("submitSecurityCode:result", {
            ok: false,
            sessionId: resolved.sessionId,
            error: "code e obrigatorio",
          });
          return;
        }
        const result = await resolved.context.client.submitSecurityCode(code);
        socket.emit("submitSecurityCode:result", { ok: true, sessionId: resolved.sessionId, ...result });
      } catch (error) {
        socket.emit("submitSecurityCode:result", {
          ok: false,
          sessionId: resolved.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on(
      "resolveVoiceMessage",
      (payload: { sessionId?: string; senderUsername?: string; messageId?: string; voiceSimpleId?: number } | undefined) => {
        const resolved = requireContext(payload, "resolveVoiceMessage");
        if (!resolved) return;
        socket.emit("resolveVoiceMessage:result", {
          sessionId: resolved.sessionId,
          ...resolved.context.media.resolveVoiceMessage(payload),
        });
      },
    );

    socket.on(
      "resolveImageMessage",
      (payload: { sessionId?: string; senderUsername?: string; messageId?: string; imageSimpleId?: number } | undefined) => {
        const resolved = requireContext(payload, "resolveImageMessage");
        if (!resolved) return;
        socket.emit("resolveImageMessage:result", {
          sessionId: resolved.sessionId,
          ...resolved.context.media.resolveImageMessage(payload),
        });
      },
    );

    socket.on("closeBrowser", async (payload: { sessionId?: string } | undefined) => {
      const resolved = requireContext(payload, "closeBrowser");
      if (!resolved) return;
      try {
        await resolved.context.client.close();
        socket.emit("closeBrowser:result", { ok: true, sessionId: resolved.sessionId });
      } catch (error) {
        socket.emit("closeBrowser:result", {
          ok: false,
          sessionId: resolved.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on("listConversations", async (payload: { sessionId?: string; limit?: number } | undefined) => {
      const resolved = requireContext(payload, "listConversations");
      if (!resolved) return;
      const limit = Number(payload?.limit || 20);
      try {
        const conversations = await resolved.context.client.listConversations(limit);
        socket.emit("listConversations:result", { ok: true, sessionId: resolved.sessionId, count: conversations.length, conversations });
      } catch (error) {
        socket.emit("listConversations:result", { ok: false, sessionId: resolved.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("searchUsers", async (payload: { sessionId?: string; query?: string; limit?: number } | undefined) => {
      const resolved = requireContext(payload, "searchUsers");
      if (!resolved) return;
      const query = String(payload?.query || "").trim();
      const limit = Number(payload?.limit);
      try {
        if (!query) throw new Error("query e obrigatorio.");
        const result = await resolved.context.client.searchUsers(query, {
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        });
        socket.emit("searchUsers:result", { ok: true, sessionId: resolved.sessionId, ...result });
      } catch (error) {
        socket.emit("searchUsers:result", { ok: false, sessionId: resolved.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("listSuggestedPeople", async (payload: { sessionId?: string; limit?: number } | undefined) => {
      const resolved = requireContext(payload, "listSuggestedPeople");
      if (!resolved) return;
      const limit = Number(payload?.limit);
      try {
        const result = await resolved.context.client.listSuggestedPeople({
          limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
        });
        socket.emit("listSuggestedPeople:result", {
          ok: true,
          sessionId: resolved.sessionId,
          count: result.users.length,
          ...result,
        });
      } catch (error) {
        socket.emit("listSuggestedPeople:result", {
          ok: false,
          sessionId: resolved.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on(
      "getSuggestedUsersData",
      async (payload: { sessionId?: string; targetId?: string; limit?: number; module?: "profile" | "home" } | undefined) => {
        const resolved = requireContext(payload, "getSuggestedUsersData");
        if (!resolved) return;
        const targetId = String(payload?.targetId || "").trim();
        const limit = Number(payload?.limit);
        try {
          if (!targetId) {
            throw new Error("targetId e obrigatorio.");
          }
          const result = await resolved.context.client.getSuggestedUsersDataByTargetId(targetId, {
            limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
            module: payload?.module,
          });
          socket.emit("getSuggestedUsersData:result", {
            ok: true,
            sessionId: resolved.sessionId,
            count: result.users.length,
            ...result,
          });
        } catch (error) {
          socket.emit("getSuggestedUsersData:result", {
            ok: false,
            sessionId: resolved.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
    );

    socket.on("followUser", async (payload: { sessionId?: string; userId?: string } | undefined) => {
      const resolved = requireContext(payload, "followUser");
      if (!resolved) return;
      const userId = String(payload?.userId || "").trim();
      try {
        if (!userId) {
          throw new Error("userId e obrigatorio.");
        }
        const result = await resolved.context.client.followUserById(userId);
        socket.emit("followUser:result", {
          ok: true,
          sessionId: resolved.sessionId,
          ...result,
        });
      } catch (error) {
        socket.emit("followUser:result", {
          ok: false,
          sessionId: resolved.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on(
      "autoFollowSuggested",
      async (payload: { sessionId?: string; quantity?: number; privacyFilter?: "any" | "public" | "private" } | undefined) => {
      const resolved = requireContext(payload, "autoFollowSuggested");
      if (!resolved) return;
      const quantity = Number(payload?.quantity);
      const privacyFilter = payload?.privacyFilter;
      try {
        if (!Number.isFinite(quantity) || quantity <= 0) {
          throw new Error("quantity deve ser maior que zero.");
        }
        const result = await resolved.context.client.autoFollowSuggestedUsers(quantity, {
          privacyFilter,
        });
        socket.emit("autoFollowSuggested:result", {
          ok: true,
          sessionId: resolved.sessionId,
          ...result,
        });
      } catch (error) {
        socket.emit("autoFollowSuggested:result", {
          ok: false,
          sessionId: resolved.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    );

    socket.on("listConversationsIntercept", async (payload: { sessionId?: string; timeoutMs?: number } | undefined) => {
      const resolved = requireContext(payload, "listConversationsIntercept");
      if (!resolved) return;
      const timeoutMs = Number(payload?.timeoutMs || 25000);
      try {
        const conversations = await resolved.context.client.listConversationsByNetworkIntercept(timeoutMs);
        socket.emit("listConversationsIntercept:result", { ok: true, sessionId: resolved.sessionId, count: conversations.length, conversations });
      } catch (error) {
        socket.emit("listConversationsIntercept:result", { ok: false, sessionId: resolved.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("debugInboxTraffic", async (payload: { sessionId?: string; timeoutMs?: number } | undefined) => {
      const resolved = requireContext(payload, "debugInboxTraffic");
      if (!resolved) return;
      const timeoutMs = Number(payload?.timeoutMs || 12000);
      try {
        const traffic = await resolved.context.client.debugInboxTraffic(timeoutMs);
        const interesting = traffic.filter((t) => t.url.includes("direct") || t.url.includes("graphql") || t.type === "websocket");
        socket.emit("debugInboxTraffic:result", { ok: true, sessionId: resolved.sessionId, count: traffic.length, interestingCount: interesting.length, traffic });
      } catch (error) {
        socket.emit("debugInboxTraffic:result", { ok: false, sessionId: resolved.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("debugMessageTransport", async (payload: { sessionId?: string; timeoutMs?: number; withMessagesOnly?: boolean } | undefined) => {
      const resolved = requireContext(payload, "debugMessageTransport");
      if (!resolved) return;
      const timeoutMs = Number(payload?.timeoutMs || 15000);
      const withMessagesOnly = Boolean(payload?.withMessagesOnly);
      try {
        const records = await resolved.context.client.debugMessageTransport(timeoutMs);
        const withMessagesRecords = records.filter((r) => r.phase === "response" && (r.messageCount || 0) > 0);
        const outputRecords = withMessagesOnly ? withMessagesRecords : records;
        socket.emit("debugMessageTransport:result", { ok: true, sessionId: resolved.sessionId, count: outputRecords.length, withMessages: withMessagesRecords.length, withMessagesOnly, records: outputRecords });
      } catch (error) {
        socket.emit("debugMessageTransport:result", { ok: false, sessionId: resolved.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("debugInstagramSocket", async (payload: { sessionId?: string; timeoutMs?: number; directOnly?: boolean } | undefined) => {
      const resolved = requireContext(payload, "debugInstagramSocket");
      if (!resolved) return;
      const timeoutMs = Number(payload?.timeoutMs || 15000);
      const directOnly = Boolean(payload?.directOnly);
      try {
        const frames = await resolved.context.client.debugInstagramSocket(timeoutMs);
        const directFrames = frames.filter((f) => f.hasDirectSignal);
        const output = directOnly ? directFrames : frames;
        socket.emit("debugInstagramSocket:result", { ok: true, sessionId: resolved.sessionId, count: output.length, directFrames: directFrames.length, directOnly, frames: output });
      } catch (error) {
        socket.emit("debugInstagramSocket:result", { ok: false, sessionId: resolved.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("probeInstagramRealtime", async (payload: { sessionId?: string; timeoutMs?: number } | undefined) => {
      const resolved = requireContext(payload, "probeInstagramRealtime");
      if (!resolved) return;
      const timeoutMs = Number(payload?.timeoutMs || 15000);
      try {
        const result = await resolved.context.client.probeInstagramRealtime(timeoutMs);
        socket.emit("probeInstagramRealtime:result", { ok: true, sessionId: resolved.sessionId, ...result });
      } catch (error) {
        socket.emit("probeInstagramRealtime:result", { ok: false, sessionId: resolved.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("openConversation", async (payload: {
      sessionId?: string;
      conversationTitle?: string;
      dedicatedTab?: boolean;
      autoStartDmTap?: boolean;
      preloadMessages?: boolean;
    } | undefined) => {
      const resolved = requireContext(payload, "openConversation");
      if (!resolved) return;
      const conversationTitle = String(payload?.conversationTitle || "").trim();
      const dedicatedTab = Boolean(payload?.dedicatedTab);
      const autoStartDmTap = Boolean(payload?.autoStartDmTap);
      const preloadMessages = Boolean(payload?.preloadMessages);
      try {
        if (!conversationTitle) {
          throw new Error("conversationTitle e obrigatorio.");
        }
        if (autoStartDmTap) {
          await ensureDmTapIfIdle(resolved.sessionId, false, "openConversation(mto)");
        }
        const result = await resolved.context.client.openConversationByTitle(conversationTitle, { dedicatedTab });
        let messagesPayload: Pick<
          OpenConversationResult,
          "threadId" | "messageCount" | "messages" | "messagesLoadError"
        > = {};
        if (preloadMessages) {
          const threadId = extractThreadIdFromDirectUrl(result.url);
          if (threadId) {
            try {
              const lm = await resolved.context.client.listMessagesByThreadId(threadId, 30);
              messagesPayload = {
                threadId: lm.threadId,
                messageCount: lm.count,
                messages: lm.messages,
              };
            } catch (e) {
              messagesPayload = {
                messagesLoadError: e instanceof Error ? e.message : String(e),
              };
            }
          } else {
            messagesPayload = {
              messagesLoadError: "Nao foi possivel obter o threadId a partir da URL da conversa.",
            };
          }
        }
        socket.emit("openConversation:result", {
          ok: true,
          sessionId: resolved.sessionId,
          ...result,
          ...messagesPayload,
        });
      } catch (error) {
        socket.emit("openConversation:result", {
          ok: false,
          sessionId: resolved.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on("sendMessage", async (payload: {
      sessionId?: string;
      conversationTitle?: string;
      text?: string;
      dedicatedTab?: boolean;
    } | undefined) => {
      const resolved = requireContext(payload, "sendMessage");
      if (!resolved) return;
      const conversationTitle = String(payload?.conversationTitle || "").trim();
      const text = String(payload?.text || "");
      const dedicatedTab = Boolean(payload?.dedicatedTab);
      try {
        if (!conversationTitle || !text) {
          throw new Error("conversationTitle e text sao obrigatorios.");
        }
        const result = await resolved.context.client.sendMessageToConversation(conversationTitle, text, {
          dedicatedTab,
        });
        socket.emit("sendMessage:result", {
          ok: true,
          sessionId: resolved.sessionId,
          ...result,
        });
      } catch (error) {
        socket.emit("sendMessage:result", {
          ok: false,
          sessionId: resolved.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on("listMessages", async (payload: { sessionId?: string; threadId?: string; limit?: number } | undefined) => {
      const resolved = requireContext(payload, "listMessages");
      if (!resolved) return;
      const threadId = String(payload?.threadId || "").trim();
      const limit = Number(payload?.limit || 20);
      try {
        if (!threadId) {
          throw new Error("threadId e obrigatorio.");
        }
        const result = await resolved.context.client.listMessagesByThreadId(threadId, limit);
        socket.emit("listMessages:result", {
          ok: true,
          sessionId: resolved.sessionId,
          ...result,
        });
      } catch (error) {
        socket.emit("listMessages:result", {
          ok: false,
          sessionId: resolved.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on("startMessageListener", async (payload: { sessionId?: string } | undefined) => {
      const resolved = requireContext(payload, "startMessageListener");
      if (!resolved) return;
    try {
        const activePromise = startListenerPromises.get(resolved.sessionId);
        if (!activePromise) {
          const promise = resolved.context.client.startMessageListener((event) => {
            socket.emit("newMessage", {
              ...event,
              sessionId: resolved.sessionId,
            });
          });
          startListenerPromises.set(resolved.sessionId, promise);
        }
        const result = await startListenerPromises.get(resolved.sessionId)!;
        listenerStarted.add(resolved.sessionId);
        socket.emit("startMessageListener:result", { ok: true, sessionId: resolved.sessionId, ...result });
      } catch (error) {
        startListenerPromises.delete(resolved.sessionId);
        listenerStarted.delete(resolved.sessionId);
        socket.emit("startMessageListener:result", { ok: false, sessionId: resolved.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("stopMessageListener", (payload: { sessionId?: string } | undefined) => {
      const resolved = requireContext(payload, "stopMessageListener");
      if (!resolved) return;
      const finishStop = () => {
        const result = resolved.context.client.stopMessageListener();
        startListenerPromises.delete(resolved.sessionId);
        listenerStarted.delete(resolved.sessionId);
        socket.emit("stopMessageListener:result", { ok: true, sessionId: resolved.sessionId, ...result });
      };
      try {
        const activePromise = startListenerPromises.get(resolved.sessionId);
        if (activePromise && !listenerStarted.has(resolved.sessionId)) {
          activePromise.then(() => finishStop()).catch(() => finishStop());
          return;
        }
        finishStop();
      } catch (error) {
        startListenerPromises.delete(resolved.sessionId);
        listenerStarted.delete(resolved.sessionId);
        socket.emit("stopMessageListener:result", { ok: false, sessionId: resolved.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("startThreadListener", async (payload: { sessionId?: string; threadId?: string } | undefined) => {
      const resolved = requireContext(payload, "startThreadListener");
      if (!resolved) return;
      const threadId = String(payload?.threadId || "").trim();
      try {
        if (!threadId) {
          throw new Error("threadId e obrigatorio.");
        }
        const result = await resolved.context.client.startThreadListener(threadId, (event) => {
          socket.emit("newMessage", {
            ...event,
            sessionId: resolved.sessionId,
          });
        });
        socket.emit("startThreadListener:result", {
          ok: true,
          sessionId: resolved.sessionId,
          ...result,
        });
      } catch (error) {
        socket.emit("startThreadListener:result", {
          ok: false,
          sessionId: resolved.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    socket.on("startDmTap", async (payload: { sessionId?: string; debug?: boolean } | undefined) => {
      const resolved = requireContext(payload, "startDmTap");
      if (!resolved) return;
      const debugEnabled = Boolean(payload && payload.debug);
      try {
        const result = await executeStartDmTap(resolved.sessionId, debugEnabled);
        socket.emit("startDmTap:result", { ok: true, sessionId: resolved.sessionId, ...result });
      } catch (error) {
        socket.emit("startDmTap:result", { ok: false, sessionId: resolved.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("getDmTapStats", async (payload: { sessionId?: string } | undefined) => {
      const resolved = requireContext(payload, "getDmTapStats");
      if (!resolved) return;
      try {
        const stats = await resolved.context.client.getDmTapStats();
        socket.emit("getDmTapStats:result", { ok: true, sessionId: resolved.sessionId, stats });
      } catch (error) {
        socket.emit("getDmTapStats:result", { ok: false, sessionId: resolved.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("stopDmTap", (payload: { sessionId?: string } | undefined) => {
      const resolved = requireContext(payload, "stopDmTap");
      if (!resolved) return;
      try {
        const result = resolved.context.client.stopDmTap();
        socket.emit("stopDmTap:result", { ok: true, sessionId: resolved.sessionId, ...result });
      } catch (error) {
        socket.emit("stopDmTap:result", { ok: false, sessionId: resolved.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    });

    socket.on("stopThreadListener", (payload: { sessionId?: string } | undefined) => {
      const resolved = requireContext(payload, "stopThreadListener");
      if (!resolved) return;
      try {
        const result = resolved.context.client.stopThreadListener();
        socket.emit("stopThreadListener:result", { ok: true, sessionId: resolved.sessionId, ...result });
      } catch (error) {
        socket.emit("stopThreadListener:result", { ok: false, sessionId: resolved.sessionId, error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
}


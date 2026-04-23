import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Server } from "socket.io";
import { InstaConnect } from "./insta-connect/InstaConnect";
import { createMediaProxy } from "./server/media-proxy";
import { registerSocketServer } from "./server/register-socket-handlers";
import type { InstaConnectSocketServerConfig } from "./types";

export function startInstaConnectSocketServer(
  config: InstaConnectSocketServerConfig,
  onListening?: (info: { port: number; publicBaseUrl: string }) => void,
): { httpServer: HttpServer; io: Server } {
  const { port, publicBaseUrl, insta = {}, customizeLaunch, log: customLog } = config;
  const log =
    customLog ??
    function log(message: string, meta?: Record<string, unknown>): void {
      const payload = meta ? ` ${JSON.stringify(meta)}` : "";
      console.log(`[${new Date().toISOString()}] [socket-server] ${message}${payload}`);
    };

  type SessionContext = {
    client: InstaConnect;
    media: ReturnType<typeof createMediaProxy>;
    createdAt: Date;
  };
  const sessions = new Map<string, SessionContext>();

  const scopeSessionDir = (value: string, sessionId: string): string => {
    if (path.isAbsolute(value)) {
      return path.join(value, sessionId);
    }
    return path.join(path.dirname(value), sessionId, path.basename(value));
  };
  const scopeSeenMessagesFile = (value: string, sessionId: string): string => {
    if (path.isAbsolute(value)) {
      const dir = path.dirname(value);
      const file = path.basename(value);
      return path.join(dir, sessionId, file);
    }
    return path.join(path.dirname(value), sessionId, path.basename(value));
  };
  const ensureDefaultSessionPaths = (sessionId: string) => {
    const basePath = insta.basePath ?? process.cwd();
    const baseSessionDir = insta.sessionDir ?? ".session/chrome-profile";
    const baseSeenFile = insta.seenMessagesFile ?? ".session/seen-message-ids.json";
    return {
      ...insta,
      sessionDir: scopeSessionDir(baseSessionDir, sessionId),
      seenMessagesFile: scopeSeenMessagesFile(baseSeenFile, sessionId),
      basePath,
    };
  };

  const nextSessionId = (): string => {
    let candidate = "";
    do {
      candidate = randomUUID();
    } while (sessions.has(candidate));
    return candidate;
  };

  const createSession = (sessionId?: string) => {
    const id = String(sessionId || "").trim() || nextSessionId();
    const existing = sessions.get(id);
    if (existing) {
      return { sessionId: id, created: false, context: existing };
    }
    const client = new InstaConnect({ insta: ensureDefaultSessionPaths(id) }, customizeLaunch);
    const media = createMediaProxy(client, publicBaseUrl, id);
    const context: SessionContext = { client, media, createdAt: new Date() };
    sessions.set(id, context);
    return { sessionId: id, created: true, context };
  };

  const closeSession = async (sessionId: string): Promise<boolean> => {
    const existing = sessions.get(sessionId);
    if (!existing) {
      return false;
    }
    await existing.client.close();
    sessions.delete(sessionId);
    return true;
  };

  const httpServer = createServer((req, res) => {
    for (const context of sessions.values()) {
      if (context.media.tryHandleMediaGet(req, res)) {
        return;
      }
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  registerSocketServer(io, {
    getSession: (sessionId) => sessions.get(sessionId),
    listSessions: () =>
      Array.from(sessions.entries()).map(([sessionId, context]) => ({
        sessionId,
        createdAt: context.createdAt,
        context,
      })),
    createSession,
    closeSession,
    log,
  });

  httpServer.listen(port, () => {
    log(`running at http://localhost:${port}`);
    onListening?.({ port, publicBaseUrl });
  });

  return { httpServer, io };
}

if (require.main === module) {
  const port = Number(process.argv[2] || 4010);
  const publicBaseUrl = process.argv[3] || `http://localhost:${port}`;
  startInstaConnectSocketServer(
    { port, publicBaseUrl, insta: {} },
  );
}

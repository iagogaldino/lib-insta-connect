import { createServer, type Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { InstaConnect } from "./insta-connect/InstaConnect";
import { createMediaProxy } from "./server/media-proxy";
import { registerSocketServer } from "./server/register-socket-handlers";
import type { InstaConnectSocketServerConfig } from "./types";

export function startInstaConnectSocketServer(
  config: InstaConnectSocketServerConfig,
  onListening?: (info: { port: number; publicBaseUrl: string }) => void,
): { httpServer: HttpServer; io: Server; client: InstaConnect } {
  const { port, publicBaseUrl, insta = {}, customizeLaunch, log: customLog } = config;
  const log =
    customLog ??
    function log(message: string, meta?: Record<string, unknown>): void {
      const payload = meta ? ` ${JSON.stringify(meta)}` : "";
      console.log(`[${new Date().toISOString()}] [socket-server] ${message}${payload}`);
    };

  const client = new InstaConnect({ insta }, customizeLaunch);
  const media = createMediaProxy(client, publicBaseUrl);

  const httpServer = createServer((req, res) => {
    if (media.tryHandleMediaGet(req, res)) {
      return;
    }
    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });

  const io = new Server(httpServer, {
    cors: {
      origin: "*",
    },
  });

  registerSocketServer(io, { client, media, log });

  httpServer.listen(port, () => {
    log(`running at http://localhost:${port}`);
    onListening?.({ port, publicBaseUrl });
  });

  return { httpServer, io, client };
}

if (require.main === module) {
  const port = Number(process.argv[2] || 4010);
  const publicBaseUrl = process.argv[3] || `http://localhost:${port}`;
  startInstaConnectSocketServer(
    { port, publicBaseUrl, insta: {} },
  );
}

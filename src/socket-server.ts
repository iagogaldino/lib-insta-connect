import "dotenv/config";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { InstaConnect } from "./insta-connect/InstaConnect";
import { createMediaProxy } from "./server/media-proxy";
import { registerSocketServer } from "./server/register-socket-handlers";

const port = Number(process.env.PORT || 4010);
const client = new InstaConnect();
const publicBaseUrl = process.env.PUBLIC_BASE_URL || `http://localhost:${port}`;
const media = createMediaProxy(client, publicBaseUrl);

function log(message: string, meta?: Record<string, unknown>): void {
  const payload = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[${new Date().toISOString()}] [socket-server] ${message}${payload}`);
}

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
});

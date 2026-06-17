import type { IncomingMessage, ServerResponse } from "node:http";
import type { InstaConnect } from "../insta-connect/InstaConnect";

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function challengeAssistHtml(sessionId: string, basePath: string): string {
  const safeSessionId = JSON.stringify(sessionId);
  const safeBasePath = JSON.stringify(basePath);
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>InstaConnect — Verificacao remota</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; }
    body { margin: 0; background: #0f1115; color: #e8eaed; }
    main { max-width: 1100px; margin: 0 auto; padding: 20px; }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { color: #9aa0a6; margin: 0 0 16px; line-height: 1.5; }
    .bar { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
    button { background: #3b82f6; color: #fff; border: 0; border-radius: 8px; padding: 8px 14px; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    #status { font-size: 0.9rem; color: #cbd5e1; }
    #viewport { cursor: crosshair; max-width: 100%; border: 1px solid #334155; border-radius: 8px; background: #111; }
    .hint { font-size: 0.85rem; color: #94a3b8; margin-top: 8px; }
    .ok { color: #4ade80; }
    .warn { color: #fbbf24; }
    .err { color: #f87171; }
  </style>
</head>
<body>
  <main>
    <h1>Verificacao remota do Instagram</h1>
    <p>Clique na imagem abaixo para interagir com a pagina do navegador no servidor (reCAPTCHA, botoes, etc.). A tela atualiza automaticamente.</p>
    <div class="bar">
      <button id="refreshBtn" type="button">Atualizar agora</button>
      <span id="status">Carregando...</span>
    </div>
    <img id="viewport" alt="Tela da sessao" />
    <div class="hint">Sessao: <code>${sessionId}</code></div>
  </main>
  <script>
    const sessionId = ${safeSessionId};
    const basePath = ${safeBasePath};
    const statusEl = document.getElementById("status");
    const imgEl = document.getElementById("viewport");
    const refreshBtn = document.getElementById("refreshBtn");
    let pollTimer = null;
    let viewportWidth = 1000;
    let viewportHeight = 600;

    function setStatus(text, cls) {
      statusEl.textContent = text;
      statusEl.className = cls || "";
    }

    async function fetchStatus() {
      const res = await fetch(basePath + "/status", { cache: "no-store" });
      return res.json();
    }

    async function refreshScreenshot() {
      const res = await fetch(basePath + "/screenshot.json?t=" + Date.now(), { cache: "no-store" });
      if (!res.ok) throw new Error("Falha ao capturar tela (" + res.status + ")");
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Falha ao capturar tela");
      viewportWidth = data.width || viewportWidth;
      viewportHeight = data.height || viewportHeight;
      imgEl.src = "data:image/png;base64," + data.base64;
      return data;
    }

    async function relayClick(x, y) {
      const res = await fetch(basePath + "/click", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ x, y }),
      });
      return res.json();
    }

    async function tick() {
      try {
        const status = await fetchStatus();
        if (!status.ok) {
          setStatus(status.error || "Sessao indisponivel", "err");
          return;
        }
        if (status.loggedIn) {
          setStatus("Login concluido. Pode fechar esta pagina.", "ok");
          if (pollTimer) clearInterval(pollTimer);
          return;
        }
        if (status.challengeRequired && !status.manualInteractionRequired) {
          setStatus("Verificacao visual concluida. Continue o login na aplicacao (codigo 2FA/e-mail).", "warn");
        } else if (status.challengeRequired) {
          setStatus("Desafio ativo (" + (status.challengeType || "manual") + "). Clique na tela para interagir.", "warn");
        } else {
          setStatus("Nenhum desafio pendente.", "ok");
        }
        await refreshScreenshot();
      } catch (error) {
        setStatus(error.message || String(error), "err");
      }
    }

    imgEl.addEventListener("click", async (event) => {
      const rect = imgEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const scaleX = viewportWidth / rect.width;
      const scaleY = viewportHeight / rect.height;
      const x = Math.round((event.clientX - rect.left) * scaleX);
      const y = Math.round((event.clientY - rect.top) * scaleY);
      setStatus("Enviando clique em (" + x + ", " + y + ")...", "");
      try {
        const result = await relayClick(x, y);
        if (!result.ok) throw new Error(result.error || "Falha ao enviar clique");
        await tick();
      } catch (error) {
        setStatus(error.message || String(error), "err");
      }
    });

    refreshBtn.addEventListener("click", () => { void tick(); });
    void tick();
    pollTimer = setInterval(() => { void tick(); }, 2500);
  </script>
</body>
</html>`;
}

export function createChallengeAssist(
  getClient: (sessionId: string) => InstaConnect | undefined,
  publicBaseUrl: string,
  sessionId: string,
) {
  const sessionPrefix = `/session/${encodeURIComponent(sessionId)}/challenge`;

  async function tryHandleChallenge(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", publicBaseUrl);
    if (!url.pathname.startsWith(sessionPrefix)) {
      return false;
    }

    const client = getClient(sessionId);
    if (!client) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "sessao nao encontrada" }));
      return true;
    }

    const subPath = url.pathname.slice(sessionPrefix.length) || "/";

    if (method === "GET" && (subPath === "" || subPath === "/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(challengeAssistHtml(sessionId, sessionPrefix));
      return true;
    }

    if (method === "GET" && subPath === "/status") {
      try {
        const status = await client.getSessionStatus();
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(
          JSON.stringify({
            ok: true,
            sessionId,
            ...status,
            manualInteractionRequired:
              status.challengeRequired &&
              status.challengeType !== undefined &&
              client.isManualInteractionChallengeType(status.challengeType),
          }),
        );
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return true;
    }

    if (method === "GET" && (subPath === "/screenshot.json" || subPath === "/screenshot")) {
      try {
        const shot = await client.getChallengeScreenshot();
        if (subPath === "/screenshot") {
          const buffer = Buffer.from(shot.base64, "base64");
          res.writeHead(200, {
            "content-type": shot.mimeType,
            "cache-control": "no-store",
            "x-viewport-width": String(shot.width),
            "x-viewport-height": String(shot.height),
            "x-page-url": shot.url,
          });
          res.end(buffer);
          return true;
        }
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true, sessionId, ...shot }));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return true;
    }

    if (method === "POST" && subPath === "/click") {
      try {
        const body = await readJsonBody(req);
        const x = Number(body.x);
        const y = Number(body.y);
        const result = await client.relayChallengeClick(x, y);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: true, sessionId, ...result }));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        res.end(
          JSON.stringify({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      }
      return true;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ ok: false, error: "not found" }));
    return true;
  }

  return {
    sessionId,
    challengeAssistUrl: `${publicBaseUrl}${sessionPrefix}`,
    tryHandleChallenge,
  };
}

export type ChallengeAssist = ReturnType<typeof createChallengeAssist>;

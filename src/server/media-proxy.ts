import type { ServerResponse, IncomingMessage } from "node:http";
import type { InstaConnect } from "../insta-connect/InstaConnect";
import type { DmTapEvent } from "../types";

type MediaRecord = { mediaUrl: string; senderUsername: string | null; createdAt: number };

export function createMediaProxy(client: InstaConnect, publicBaseUrl: string, sessionId: string) {
  const voiceMessages = new Map<string, MediaRecord>();
  const latestVoiceByUser = new Map<string, string>();
  let nextVoiceSimpleId = 1;
  const igMessageIdToSimpleVoiceId = new Map<string, number>();
  const simpleVoiceIdToIgMessageId = new Map<number, string>();

  const imageMessages = new Map<string, MediaRecord>();
  const latestImageByUser = new Map<string, string>();
  let nextImageSimpleId = 1;
  const igMessageIdToSimpleImageId = new Map<string, number>();
  const simpleImageIdToIgMessageId = new Map<number, string>();

  function resolveSimpleIdFromRoute(
    routeSegment: string,
    simpleIdToMessageId: Map<number, string>,
  ): string | null {
    const trimmed = routeSegment.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number.parseInt(trimmed, 10);
      return simpleIdToMessageId.get(n) || null;
    }
    return trimmed.length > 0 ? trimmed : null;
  }

  async function streamProxyMedia(
    store: Map<string, MediaRecord>,
    simpleIdToMessageId: Map<number, string>,
    routeKey: string,
    notFoundError: string,
    fetchErrorLabel: string,
    defaultContentType: string,
    writeHead: (statusCode: number, headers?: Record<string, string>) => void,
    end: (chunk?: string | Buffer) => void,
  ): Promise<void> {
    const messageId = resolveSimpleIdFromRoute(routeKey, simpleIdToMessageId);
    if (!messageId) {
      writeHead(404, { "content-type": "application/json; charset=utf-8" });
      end(JSON.stringify({ ok: false, error: "id invalido" }));
      return;
    }
    const record = store.get(messageId);
    if (!record) {
      writeHead(404, { "content-type": "application/json; charset=utf-8" });
      end(JSON.stringify({ ok: false, error: notFoundError }));
      return;
    }

    try {
      const authHeaders = await client.getInstagramMediaAuthHeaders();
      const response = await fetch(record.mediaUrl, {
        headers: authHeaders,
      });
      if (!response.ok) {
        writeHead(response.status, { "content-type": "application/json; charset=utf-8" });
        end(
          JSON.stringify({
            ok: false,
            error: `${fetchErrorLabel} (${response.status})`,
          }),
        );
        return;
      }

      const arrayBuffer = await response.arrayBuffer();
      const contentType = response.headers.get("content-type") || defaultContentType;
      writeHead(200, {
        "content-type": contentType,
        "cache-control": "no-store",
        "content-length": String(arrayBuffer.byteLength),
      });
      end(Buffer.from(arrayBuffer));
    } catch (error) {
      writeHead(500, { "content-type": "application/json; charset=utf-8" });
      end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  function streamVoiceMessage(
    routeKey: string,
    writeHead: (statusCode: number, headers?: Record<string, string>) => void,
    end: (chunk?: string | Buffer) => void,
  ): Promise<void> {
    return streamProxyMedia(
      voiceMessages,
      simpleVoiceIdToIgMessageId,
      routeKey,
      "voice message nao encontrada",
      "falha ao buscar midia remota",
      "audio/mpeg",
      writeHead,
      end,
    );
  }

  function streamImageMessage(
    routeKey: string,
    writeHead: (statusCode: number, headers?: Record<string, string>) => void,
    end: (chunk?: string | Buffer) => void,
  ): Promise<void> {
    return streamProxyMedia(
      imageMessages,
      simpleImageIdToIgMessageId,
      routeKey,
      "imagem nao encontrada",
      "falha ao buscar imagem remota",
      "image/jpeg",
      writeHead,
      end,
    );
  }

  function tryHandleMediaGet(req: IncomingMessage, res: ServerResponse, base: string): boolean {
    const method = req.method || "GET";
    const url = new URL(req.url || "/", base);
    const sessionPrefix = `/session/${encodeURIComponent(sessionId)}`;
    const voicePrefix = `${sessionPrefix}/voice/`;
    if (method === "GET" && url.pathname.startsWith(voicePrefix)) {
      const routeSegment = decodeURIComponent(url.pathname.slice(voicePrefix.length)).trim();
      void streamVoiceMessage(
        routeSegment,
        (statusCode, headers) => res.writeHead(statusCode, headers),
        (chunk) => res.end(chunk),
      );
      return true;
    }
    const imagePrefix = `${sessionPrefix}/image/`;
    if (method === "GET" && url.pathname.startsWith(imagePrefix)) {
      const routeSegment = decodeURIComponent(url.pathname.slice(imagePrefix.length)).trim();
      void streamImageMessage(
        routeSegment,
        (statusCode, headers) => res.writeHead(statusCode, headers),
        (chunk) => res.end(chunk),
      );
      return true;
    }
    return false;
  }

  function rememberVoiceEvent(evt: DmTapEvent): { voiceSimpleId: number; playbackUrl: string } | null {
    const messageId = String(evt.messageId || "").trim();
    const mediaUrl = String(evt.voiceMediaUrl || "").trim();
    const senderUsername = String(evt.senderUsername || "").trim().toLowerCase();
    if (!messageId || !mediaUrl) return null;

    let voiceSimpleId = igMessageIdToSimpleVoiceId.get(messageId);
    if (voiceSimpleId === undefined) {
      voiceSimpleId = nextVoiceSimpleId++;
      igMessageIdToSimpleVoiceId.set(messageId, voiceSimpleId);
      simpleVoiceIdToIgMessageId.set(voiceSimpleId, messageId);
    }

    voiceMessages.set(messageId, {
      mediaUrl,
      senderUsername: senderUsername || null,
      createdAt: Date.now(),
    });
    if (senderUsername) {
      latestVoiceByUser.set(senderUsername, messageId);
    }

    const playbackUrl = `${publicBaseUrl}/session/${encodeURIComponent(sessionId)}/voice/${voiceSimpleId}`;
    return { voiceSimpleId, playbackUrl };
  }

  function rememberImageEvent(evt: DmTapEvent): { imageSimpleId: number; imageViewUrl: string } | null {
    if (String(evt.voiceMediaUrl || "").trim()) {
      return null;
    }
    const messageId = String(evt.messageId || "").trim();
    const mediaUrl = String(evt.imageMediaUrl || "").trim();
    const senderUsername = String(evt.senderUsername || "").trim().toLowerCase();
    if (!messageId || !mediaUrl) {
      return null;
    }

    let imageSimpleId = igMessageIdToSimpleImageId.get(messageId);
    if (imageSimpleId === undefined) {
      imageSimpleId = nextImageSimpleId++;
      igMessageIdToSimpleImageId.set(messageId, imageSimpleId);
      simpleImageIdToIgMessageId.set(imageSimpleId, messageId);
    }

    imageMessages.set(messageId, {
      mediaUrl,
      senderUsername: senderUsername || null,
      createdAt: Date.now(),
    });
    if (senderUsername) {
      latestImageByUser.set(senderUsername, messageId);
    }

    const imageViewUrl = `${publicBaseUrl}/session/${encodeURIComponent(sessionId)}/image/${imageSimpleId}`;
    return { imageSimpleId, imageViewUrl };
  }

  function resolveVoiceMessage(payload: {
    senderUsername?: string;
    messageId?: string;
    voiceSimpleId?: number;
  } | undefined) {
    const voiceSimpleIdArg =
      typeof payload?.voiceSimpleId === "number" && Number.isFinite(payload.voiceSimpleId)
        ? Math.floor(payload.voiceSimpleId)
        : null;
    if (voiceSimpleIdArg !== null) {
      const messageId = simpleVoiceIdToIgMessageId.get(voiceSimpleIdArg);
      if (!messageId) return { ok: false, error: "audio nao encontrado para esse id" };
      const voice = voiceMessages.get(messageId);
      if (!voice) return { ok: false, error: "mensagem de audio expirada ou inexistente" };
      return {
        ok: true,
        messageId,
        voiceSimpleId: voiceSimpleIdArg,
        senderUsername: voice.senderUsername,
        playbackUrl: `${publicBaseUrl}/session/${encodeURIComponent(sessionId)}/voice/${voiceSimpleIdArg}`,
      };
    }

    const senderUsername = String(payload?.senderUsername || "").trim().toLowerCase();
    const explicitMessageId = String(payload?.messageId || "").trim();
    const messageId = explicitMessageId || (senderUsername ? latestVoiceByUser.get(senderUsername) || "" : "");
    if (!messageId) return { ok: false, error: "nenhuma mensagem de audio encontrada para esse usuario" };
    const voice = voiceMessages.get(messageId);
    if (!voice) return { ok: false, error: "mensagem de audio expirada ou inexistente" };
    const voiceSimpleId = igMessageIdToSimpleVoiceId.get(messageId) ?? null;
    const playbackPath = voiceSimpleId != null ? String(voiceSimpleId) : encodeURIComponent(messageId);
    return {
      ok: true,
      messageId,
      voiceSimpleId,
      senderUsername: voice.senderUsername,
      playbackUrl: `${publicBaseUrl}/session/${encodeURIComponent(sessionId)}/voice/${playbackPath}`,
    };
  }

  function resolveImageMessage(payload: {
    senderUsername?: string;
    messageId?: string;
    imageSimpleId?: number;
  } | undefined) {
    const imageSimpleIdArg =
      typeof payload?.imageSimpleId === "number" && Number.isFinite(payload.imageSimpleId)
        ? Math.floor(payload.imageSimpleId)
        : null;
    if (imageSimpleIdArg !== null) {
      const messageId = simpleImageIdToIgMessageId.get(imageSimpleIdArg);
      if (!messageId) return { ok: false, error: "imagem nao encontrada para esse id" };
      const image = imageMessages.get(messageId);
      if (!image) return { ok: false, error: "imagem expirada ou inexistente" };
      return {
        ok: true,
        messageId,
        imageSimpleId: imageSimpleIdArg,
        senderUsername: image.senderUsername,
        imageViewUrl: `${publicBaseUrl}/session/${encodeURIComponent(sessionId)}/image/${imageSimpleIdArg}`,
      };
    }

    const senderUsername = String(payload?.senderUsername || "").trim().toLowerCase();
    const explicitMessageId = String(payload?.messageId || "").trim();
    const messageId = explicitMessageId || (senderUsername ? latestImageByUser.get(senderUsername) || "" : "");
    if (!messageId) return { ok: false, error: "nenhuma imagem encontrada para esse usuario" };
    const image = imageMessages.get(messageId);
    if (!image) return { ok: false, error: "imagem expirada ou inexistente" };
    const imageSimpleId = igMessageIdToSimpleImageId.get(messageId) ?? null;
    const viewPath = imageSimpleId != null ? String(imageSimpleId) : encodeURIComponent(messageId);
    return {
      ok: true,
      messageId,
      imageSimpleId,
      senderUsername: image.senderUsername,
      imageViewUrl: `${publicBaseUrl}/session/${encodeURIComponent(sessionId)}/image/${viewPath}`,
    };
  }

  return {
    sessionId,
    publicBaseUrl,
    tryHandleMediaGet: (req: IncomingMessage, res: ServerResponse) => tryHandleMediaGet(req, res, publicBaseUrl),
    rememberVoiceEvent,
    rememberImageEvent,
    resolveVoiceMessage,
    resolveImageMessage,
  };
}

export type MediaProxy = ReturnType<typeof createMediaProxy>;

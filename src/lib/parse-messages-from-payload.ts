import type { IncomingMessageEvent } from "../types";

export function parseMessagesFromPayload(payload: unknown): IncomingMessageEvent[] {
  const found: IncomingMessageEvent[] = [];
  const fallbackIds = new Set<string>();

  const pushMessage = (item: any, threadIdCtx: string): void => {
    const text = String(item?.text || item?.message || item?.body || "").trim();
    if (!text) return;
    const threadId = String(
      item?.thread_id || item?.threadId || item?.thread?.id || threadIdCtx || "",
    );
    if (!threadId) return;

    const senderUsername =
      item?.user?.username ||
      item?.user?.full_name ||
      item?.profile?.username ||
      item?.sender?.username ||
      item?.owner?.username ||
      null;
    const timestampRaw =
      item?.timestamp || item?.created_at || item?.time || item?.sent_at || item?.client_time || null;
    const timestamp = timestampRaw ? String(timestampRaw) : null;
    const explicitId = String(item?.item_id || item?.id || item?.pk || "").trim();
    const fallbackId = `${threadId}:${senderUsername ?? "unknown"}:${text}:${timestamp ?? ""}`;
    const messageId = explicitId || fallbackId;

    if (!explicitId) {
      if (fallbackIds.has(messageId)) return;
      fallbackIds.add(messageId);
    }

    found.push({
      messageId,
      threadId,
      senderUsername: typeof senderUsername === "string" ? senderUsername : null,
      text,
      timestamp,
    });
  };

  const walk = (node: any, threadIdCtx = ""): void => {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, threadIdCtx);
      return;
    }
    if (typeof node !== "object") return;

    const currentThreadId = String(node?.thread_id || node?.threadId || node?.id || threadIdCtx || "");

    if (Array.isArray(node?.items) && currentThreadId) {
      for (const item of node.items) {
        pushMessage(item, currentThreadId);
      }
    }

    const looksLikeMessage =
      ("item_id" in node || "id" in node || "pk" in node || "text" in node || "message" in node) &&
      ("text" in node || "message" in node || "body" in node);
    if (looksLikeMessage) {
      pushMessage(node, currentThreadId);
    }

    for (const value of Object.values(node)) {
      walk(value, currentThreadId);
    }
  };

  walk(payload, "");
  return found;
}

export function isMessageTransportUrl(url: string): boolean {
  return (
    url.includes("/api/v1/direct_v2/") ||
    url.includes("/api/v1/direct_v2/web_inbox/") ||
    url.includes("/api/v1/direct_v2/inbox/") ||
    url.includes("/graphql/query") ||
    url.includes("/api/graphql")
  );
}

export function decodeWebsocketPayload(
  payloadData: string,
  opcode: number,
): {
  payloadBytes: number;
  payloadEncoding: "text" | "base64-binary";
  textPreview: string;
  hasDirectSignal: boolean;
} {
  const looksLikeDirectSignal = (text: string): boolean => {
    const normalized = text.toLowerCase();
    return (
      normalized.includes("direct") ||
      normalized.includes("thread") ||
      normalized.includes("message") ||
      normalized.includes("item_id") ||
      normalized.includes("ig_direct")
    );
  };

  if (opcode === 2) {
    const binary = Buffer.from(String(payloadData || ""), "base64");
    const utf8 = binary.toString("utf-8");
    const sanitized = utf8.replace(/[^\x20-\x7E\r\n\t]/g, "");
    const preview = sanitized.slice(0, 260);
    return {
      payloadBytes: binary.length,
      payloadEncoding: "base64-binary",
      textPreview: preview,
      hasDirectSignal: looksLikeDirectSignal(utf8),
    };
  }

  const text = String(payloadData || "");
  return {
    payloadBytes: Buffer.byteLength(text, "utf-8"),
    payloadEncoding: "text",
    textPreview: text.slice(0, 260),
    hasDirectSignal: looksLikeDirectSignal(text),
  };
}

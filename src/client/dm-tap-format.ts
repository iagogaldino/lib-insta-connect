export function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as Record<string, unknown>;
}

export function formatDmTapMessage(payload: unknown): string | null {
  const data = toRecord(payload);
  if (!data) {
    return null;
  }

  const senderUsername = String(data.senderUsername ?? "").trim();
  const senderName = String(data.senderName ?? "").trim();
  const senderId = String(data.senderId ?? "").trim();
  const text = String(data.text ?? "").trim();
  const voiceSimpleId =
    typeof data.voiceSimpleId === "number" && Number.isFinite(data.voiceSimpleId)
      ? data.voiceSimpleId
      : null;
  const imageSimpleId =
    typeof data.imageSimpleId === "number" && Number.isFinite(data.imageSimpleId)
      ? data.imageSimpleId
      : null;
  const isVoice = Boolean(
    data.voiceMediaUrl || /voice message/i.test(text) || /mensagem de voz/i.test(text),
  );
  const isPhoto = Boolean(
    data.imageMediaUrl ||
      /sent a photo|enviou uma foto|sent an image|photo message|foto\./i.test(text),
  );

  if (isVoice) {
    if (!text) {
      const sender = senderUsername || senderName || senderId || "desconhecido";
      if (voiceSimpleId != null) {
        return `[#${voiceSimpleId}] ${sender}: (audio)`;
      }
      return `${sender}: (audio)`;
    }
    const sender = senderUsername || senderName || senderId || "desconhecido";
    if (voiceSimpleId != null) {
      return `[#${voiceSimpleId}] ${sender}: ${text}`;
    }
    return `${sender}: ${text}`;
  }

  if (isPhoto) {
    if (!text) {
      const sender = senderUsername || senderName || senderId || "desconhecido";
      if (imageSimpleId != null) {
        return `[#${imageSimpleId}] ${sender}: (foto)`;
      }
      return `${sender}: (foto)`;
    }
    const sender = senderUsername || senderName || senderId || "desconhecido";
    if (imageSimpleId != null) {
      return `[#${imageSimpleId}] ${sender}: ${text}`;
    }
    return `${sender}: ${text}`;
  }

  if (!text) {
    return null;
  }

  const sender = senderUsername || senderName || senderId || "desconhecido";
  return `${sender}: ${text}`;
}

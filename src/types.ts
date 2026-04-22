import type { LaunchOptions } from "puppeteer";

export interface InstaConnectOptions extends LaunchOptions {}

export interface LoginResult {
  success: boolean;
  url: string;
}

export interface ConversationSummary {
  title: string;
  preview: string;
  href: string;
}

export interface InterceptedConversation {
  threadId: string;
  title: string;
  users: string[];
  lastMessage: string;
}

export interface TrafficRecord {
  type: string;
  method: string;
  url: string;
  status?: number;
}

export interface MessageTransportRecord {
  phase: "request" | "response";
  method: string;
  url: string;
  status?: number;
  payloadBytes?: number;
  messageCount?: number;
  threadIds?: string[];
  textPreview?: string[];
  topLevelKeys?: string[];
  timestamp: string;
}

export interface InstagramSocketFrameRecord {
  direction: "sent" | "received";
  url: string;
  opcode: number;
  payloadBytes: number;
  payloadEncoding: "text" | "base64-binary";
  textPreview: string;
  hasDirectSignal: boolean;
  timestamp: string;
}

export interface InstagramSocketProbeResult {
  timeoutMs: number;
  totalFrames: number;
  directSignalFrames: number;
  channels: Array<{
    url: string;
    count: number;
    received: number;
    sent: number;
    opcodes: number[];
  }>;
  topPayloadPatterns: Array<{
    signature: string;
    count: number;
    opcode: number;
    encoding: "text" | "base64-binary";
  }>;
  sampleDirectFrames: InstagramSocketFrameRecord[];
}

export interface SendMessageResult {
  success: boolean;
  conversationTitle: string;
  text: string;
  url: string;
}

export interface OpenConversationResult {
  success: boolean;
  conversationTitle: string;
  url: string;
}

export interface MessageItem {
  text: string;
  sender: "me" | "other";
  timestamp: string | null;
}

export interface IncomingMessageEvent {
  messageId: string;
  threadId: string;
  senderUsername: string | null;
  text: string;
  timestamp: string | null;
}

/** Resultado de linha de busca de perfil (contas) no Instagram Web. */
export interface InstagramSearchUser {
  username: string;
  fullName: string;
  href: string;
  isVerified?: boolean;
}

export interface DmTapEvent {
  url: string;
  topic: string;
  senderId: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  threadId: string | null;
  text: string;
  messageId?: string | null;
  seqId?: string | null;
  typename?: string | null;
  voiceMediaUrl?: string | null;
  imageMediaUrl?: string | null;
  /** Atribuido pelo servidor: ID simples (1, 2, 3) para o proxy de audio. */
  voiceSimpleId?: number | null;
  /** URL do servidor para tocar o audio (proxy autenticado). */
  playbackUrl?: string | null;
  /** Atribuido pelo servidor: ID simples para o proxy de imagem. */
  imageSimpleId?: number | null;
  /** URL do servidor para ver a imagem (proxy autenticado). */
  imageViewUrl?: string | null;
  timestamp: string;
  source: "thrift" | "json";
}

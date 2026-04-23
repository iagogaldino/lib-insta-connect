import type { LaunchOptions } from "puppeteer";

/** Configuracao de caminhos e defaults do `InstaConnect` (passe a partir da app integradora, sem .env). */
export interface InstaConnectConfig {
  /** Diretório base para resolver `sessionDir` e `seenMessagesFile` relativos. Padrão: `process.cwd()`. */
  basePath?: string;
  /** Perfil do Chrome: caminho absoluto ou relativo a `basePath`. Padrão: `.session/chrome-profile`. */
  sessionDir?: string;
  /** Arquivo de persistência de IDs de mensagens já vistas. Padrão: `.session/seen-message-ids.json`. */
  seenMessagesFile?: string;
  /** Largura do viewport em px (layout desktop do Instagram). Padrão: 1000. */
  viewportWidth?: number;
  /** Altura do viewport em px. Padrão: 600. */
  viewportHeight?: number;
  /**
   * `headless` do Puppeteer quando `LaunchOptions.headless` não for informado.
   * Padrão: `false`.
   */
  headless?: boolean;
}

export type InstaConnectLaunchCustomize = (launch: LaunchOptions) => LaunchOptions;

export interface InstaConnectOptions extends LaunchOptions {
  insta?: InstaConnectConfig;
}

/** Inicia o servidor HTTP + Socket.IO que expõe o `InstaConnect` (sem leitura de .env). */
export interface InstaConnectSocketServerConfig {
  port: number;
  /** URL pública usada em links de mídia (ex.: `http://seu-servidor:4010`). */
  publicBaseUrl: string;
  /** Padrão: `{}` (caminhos relativos a `process.cwd()`). */
  insta?: InstaConnectConfig;
  /** Ajusta as opções finais do `puppeteer.launch` (args, `slowMo`, etc.). */
  customizeLaunch?: InstaConnectLaunchCustomize;
  /** Opcional: substitui o `console.log` interno. */
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface SessionPayload {
  sessionId: string;
}

export interface CreateSessionPayload {
  sessionId?: string;
}

export interface SessionSummary {
  sessionId: string;
  createdAt: string;
  status?: {
    browserOpen: boolean;
    currentUrl: string | null;
    loggedIn: boolean;
    challengeRequired: boolean;
    challengeType?: "security_code" | "two_factor" | "unknown";
    message?: string;
  };
}

export interface LoginResult {
  success: boolean;
  url: string;
  challengeRequired?: boolean;
  challengeType?: "security_code" | "two_factor" | "unknown";
  message?: string;
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

export interface MessageItem {
  text: string;
  sender: "me" | "other";
  timestamp: string | null;
}

export interface OpenConversationResult {
  success: boolean;
  conversationTitle: string;
  url: string;
  /** Preenchido quando o cliente pede `preloadMessages` (ex.: `mto:user`). */
  threadId?: string;
  messageCount?: number;
  messages?: MessageItem[];
  messagesLoadError?: string;
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

export interface InstagramSuggestedUser {
  username: string;
  fullName: string;
  href: string;
  userId?: string;
  reason?: string;
  isVerified?: boolean;
  isPrivate?: boolean;
  profilePicUrl?: string;
}

export interface InstagramFriendshipStatus {
  following: boolean;
  is_bestie?: boolean;
  is_feed_favorite?: boolean;
  is_private?: boolean;
  is_restricted?: boolean;
  incoming_request?: boolean;
  outgoing_request?: boolean;
  followed_by?: boolean;
  muting?: boolean;
  blocking?: boolean;
  is_eligible_to_subscribe?: boolean;
  subscribed?: boolean;
}

export interface FollowUserResult {
  userId: string;
  previousFollowing?: boolean;
  friendshipStatus: InstagramFriendshipStatus;
  status: string;
  error?: string | null;
}

export interface AutoFollowItemResult {
  username: string;
  userId?: string;
  isPrivate?: boolean;
  success: boolean;
  following?: boolean;
  error?: string;
}

export type AutoFollowPrivacyFilter = "any" | "public" | "private";

export interface AutoFollowSuggestedResult {
  requested: number;
  attempted: number;
  followed: number;
  privacyFilter: AutoFollowPrivacyFilter;
  results: AutoFollowItemResult[];
}

export interface AutoFollowFollowersOfUserResult {
  targetUsername: string;
  targetUserId: string;
  /** Como o perfil alvo foi aberto: `search` (resultado exato) ou `direct` (URL direta). */
  profileOpenedVia: "search" | "direct";
  requested: number;
  attempted: number;
  followed: number;
  privacyFilter: AutoFollowPrivacyFilter;
  results: AutoFollowItemResult[];
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

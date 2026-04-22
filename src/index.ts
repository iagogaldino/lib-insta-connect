import puppeteer, { Browser, LaunchOptions, Page } from "puppeteer";
import fs from "node:fs/promises";
import path from "node:path";
import { DM_TAP_SOURCE } from "./browser/dm-tap.source";

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
  /** Atribuido pelo servidor: ID simples (1, 2, 3) para o proxy de audio. */
  voiceSimpleId?: number | null;
  /** URL do servidor para tocar o audio (proxy autenticado). */
  playbackUrl?: string | null;
  timestamp: string;
  source: "thrift" | "json";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (typeof value === "undefined") return fallback;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

export class InstaConnect {
  private options: InstaConnectOptions;
  private sessionDir: string;
  private browser: Browser | null = null;
  private page: Page | null = null;
  private dmTapPage: Page | null = null;
  private conversationPages = new Map<string, Page>();
  private messageListenerActive = false;
  private messageListenerCleanup: (() => void) | null = null;
  private threadListenerActive = false;
  private threadListenerCleanup: (() => void) | null = null;
  private seenMessageIds = new Set<string>();
  private seenStorePath: string;
  private dmTapActive = false;
  private dmTapBridgeInstalled = false;
  private dmTapInitScriptInstalled = false;
  private dmTapHandler: ((evt: DmTapEvent) => void) | null = null;
  private dmTapDebugHandler: ((msg: { kind: string; data: unknown; ts: string }) => void) | null = null;
  private lastSendTargetKey: string | null = null;
  private lastSendThreadId: string | null = null;

  constructor(options: InstaConnectOptions = {}) {
    this.sessionDir = path.resolve(
      process.cwd(),
      process.env.SESSION_DIR || ".session/chrome-profile",
    );
    this.options = {
      headless: parseBooleanEnv(process.env.INSTA_HEADLESS, false),
      defaultViewport: null,
      userDataDir: this.sessionDir,
      ...options,
    };
    this.seenStorePath = path.resolve(
      process.cwd(),
      process.env.SEEN_MESSAGES_FILE || ".session/seen-message-ids.json",
    );
  }

  private async loadSeenMessageIds(): Promise<void> {
    try {
      const raw = await fs.readFile(this.seenStorePath, "utf-8");
      const parsed = JSON.parse(raw) as { ids?: string[] };
      const ids = Array.isArray(parsed?.ids) ? parsed.ids : [];
      this.seenMessageIds = new Set(ids);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.seenMessageIds = new Set();
    }
  }

  private async persistSeenMessageIds(): Promise<void> {
    const dir = path.dirname(this.seenStorePath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.seenStorePath,
      JSON.stringify({ ids: Array.from(this.seenMessageIds).slice(-5000) }, null, 2),
      "utf-8",
    );
  }

  private parseMessagesFromPayload(payload: any): IncomingMessageEvent[] {
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

  private isMessageTransportUrl(url: string): boolean {
    return (
      url.includes("/api/v1/direct_v2/") ||
      url.includes("/api/v1/direct_v2/web_inbox/") ||
      url.includes("/api/v1/direct_v2/inbox/") ||
      url.includes("/graphql/query") ||
      url.includes("/api/graphql")
    );
  }

  private decodeWebsocketPayload(
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

    // opcode 1 = text frame; opcode 2 = binary frame (base64 string in CDP payloadData)
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

  public async launch(): Promise<Browser> {
    if (this.browser) return this.browser;
    await fs.mkdir(this.sessionDir, { recursive: true });
    console.log(
      `[${new Date().toISOString()}] [insta-connect] carregando sessao de ${this.sessionDir}`,
    );
    this.browser = await puppeteer.launch(this.options);
    this.page = await this.browser.newPage();
    return this.browser;
  }

  private async getOrCreateDmTapPage(): Promise<Page> {
    if (!this.browser) {
      await this.launch();
    }
    if (!this.browser) {
      throw new Error("Navegador nao inicializado.");
    }

    if (this.dmTapPage && !this.dmTapPage.isClosed()) {
      return this.dmTapPage;
    }

    this.dmTapPage = await this.browser.newPage();
    this.dmTapBridgeInstalled = false;
    this.dmTapInitScriptInstalled = false;
    return this.dmTapPage;
  }

  private async getOrCreateConversationPage(conversationTitle: string): Promise<Page> {
    const key = conversationTitle.trim().toLowerCase();
    if (!key) {
      throw new Error("conversationTitle e obrigatorio.");
    }

    if (!this.browser) {
      await this.launch();
    }
    if (!this.browser) {
      throw new Error("Navegador nao inicializado.");
    }

    const existing = this.conversationPages.get(key);
    if (existing && !existing.isClosed()) {
      await existing.bringToFront().catch(() => null);
      return existing;
    }

    const page = await this.browser.newPage();
    this.conversationPages.set(key, page);
    await page.bringToFront().catch(() => null);
    return page;
  }

  public async openLoginPage(): Promise<string> {
    if (!this.browser || !this.page) {
      await this.launch();
    }

    await this.page!.goto("https://www.instagram.com/accounts/login/", {
      waitUntil: "networkidle2",
    });

    return this.page!.url();
  }

  private async acceptCookiesIfPresent(): Promise<void> {
    const selectors = [
      'button[tabindex="0"]',
      'button[type="button"]',
    ];

    for (const selector of selectors) {
      const buttons = await this.page!.$$(selector);
      for (const button of buttons) {
        const text = (await this.page!.evaluate((el) => el.textContent || "", button)).toLowerCase();
        const shouldClick =
          text.includes("allow all cookies") ||
          text.includes("accept all") ||
          text.includes("permitir todos os cookies") ||
          text.includes("aceitar tudo");
        if (shouldClick) {
          await button.click().catch(() => null);
          return;
        }
      }
    }
  }

  private async clickFirstActionByText(candidates: string[]): Promise<boolean> {
    const selectors = ['button', 'div[role="button"]', 'a[role="button"]'];
    for (const selector of selectors) {
      const nodes = await this.page!.$$(selector);
      for (const node of nodes) {
        const rawText = await this.page!.evaluate((el) => el.textContent || "", node);
        const text = rawText.trim().toLowerCase();
        const isMatch = candidates.some((candidate) => text === candidate.toLowerCase());
        if (isMatch) {
          await node.click().catch(() => null);
          return true;
        }
      }
    }
    return false;
  }

  private async clickXPathIfExists(xpath: string): Promise<boolean> {
    return this.page!.evaluate((targetXPath) => {
      const result = document.evaluate(
        targetXPath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      const node = result.singleNodeValue as HTMLElement | null;
      if (!node) return false;
      node.click();
      return true;
    }, xpath);
  }

  private async handlePostLoginPrompts(): Promise<void> {
    for (let i = 0; i < 4; i += 1) {
      await sleep(1200);

      const dismissedSaveInfo = await this.clickFirstActionByText([
        "not now",
        "agora não",
        "agora nao",
      ]);
      if (dismissedSaveInfo) {
        await sleep(900);
      }

      const dismissedNotificationsByText = await this.clickFirstActionByText([
        "not now",
        "agora não",
        "agora nao",
        "cancel",
        "cancelar",
      ]);

      // Fallback especifico enviado pelo usuario para modal de notificacoes.
      const dismissedNotificationsByXPath = dismissedNotificationsByText
        ? false
        : await this.clickXPathIfExists(
            "/html/body/div[2]/div[1]/div/div[2]/div/div/div/div/div[2]/div/div/div[3]/button[2]",
          );

      if (dismissedNotificationsByText || dismissedNotificationsByXPath) {
        await sleep(800);
        continue;
      }

      // Nenhum prompt encontrado nesta rodada.
      break;
    }
  }

  public async login(username: string, password: string): Promise<LoginResult> {
    const loginUrl = await this.openLoginPage();
    const alreadyLogged = !loginUrl.includes("/accounts/login");
    if (alreadyLogged) {
      return {
        success: true,
        url: loginUrl,
      };
    }

    try {
      await this.acceptCookiesIfPresent();
      await this.page!.waitForSelector("form", { timeout: 60000 });
    } catch {
      const currentUrl = this.page!.url();
      const pageTitle = await this.page!.title();
      throw new Error(
        `Campos de login nao encontrados. url=${currentUrl} title=${pageTitle}`,
      );
    }

    const usernameElement =
      (await this.page!.$('input[name="username"]')) ||
      (await this.page!.$('input[autocomplete="username"]')) ||
      (await this.page!.$('input[type="text"]'));

    const passwordElement =
      (await this.page!.$('input[name="password"]')) ||
      (await this.page!.$('input[autocomplete="current-password"]')) ||
      (await this.page!.$('input[type="password"]'));

    const submitElement =
      (await this.page!.$('button[type="submit"]')) ||
      (await this.page!.$("form button")) ||
      (await this.page!.$('form div[role="button"]'));

    if (!usernameElement || !passwordElement || !submitElement) {
      const currentUrl = this.page!.url();
      const pageTitle = await this.page!.title();
      const screenshotDir = path.resolve(process.cwd(), ".debug");
      await fs.mkdir(screenshotDir, { recursive: true });
      const screenshotPath = path.join(screenshotDir, "login-not-found.png");
      await this.page!.screenshot({ path: screenshotPath, fullPage: true }).catch(() => null);
      throw new Error(
        `Campos de login nao encontrados. url=${currentUrl} title=${pageTitle} screenshot=${screenshotPath}`,
      );
    }

    await usernameElement.click({ clickCount: 3 });
    await this.page!.keyboard.press("Backspace");
    await usernameElement.type(username, { delay: 30 });
    await passwordElement.click({ clickCount: 3 });
    await this.page!.keyboard.press("Backspace");
    await passwordElement.type(password, { delay: 30 });

    await Promise.all([
      this.page!.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 }).catch(() => null),
      submitElement.click(),
    ]);

    await this.handlePostLoginPrompts();

    const currentUrl = this.page!.url();
    const onHome =
      currentUrl.includes("instagram.com") &&
      !currentUrl.includes("/accounts/login") &&
      !currentUrl.includes("/challenge/");
    return {
      success: onHome,
      url: currentUrl,
    };
  }

  public async listConversations(limit = 20): Promise<ConversationSummary[]> {
    if (!this.page) {
      await this.launch();
    }

    await this.page!.goto("https://www.instagram.com/direct/inbox/", {
      waitUntil: "networkidle2",
    });

    await this.handlePostLoginPrompts();

    await this.page!.waitForSelector("a[href*='/direct/t/']", { timeout: 60000 });

    const conversations = await this.page!.evaluate((maxItems) => {
      const anchors = Array.from(
        document.querySelectorAll("a[href*='/direct/t/']"),
      ) as HTMLAnchorElement[];

      const unique = new Set<string>();
      const result: Array<{ title: string; preview: string; href: string }> = [];

      for (const anchor of anchors) {
        const href = anchor.getAttribute("href") || "";
        if (!href || unique.has(href)) continue;
        unique.add(href);

        const spans = Array.from(anchor.querySelectorAll("span"))
          .map((el) => (el.textContent || "").trim())
          .filter(Boolean);

        const title = spans[0] || "Sem titulo";
        const preview = spans[1] || "";

        result.push({
          title,
          preview,
          href: href.startsWith("http") ? href : `https://www.instagram.com${href}`,
        });

        if (result.length >= maxItems) break;
      }

      return result;
    }, limit);

    return conversations;
  }

  public async listConversationsByNetworkIntercept(
    timeoutMs = 25000,
  ): Promise<InterceptedConversation[]> {
    if (!this.page) {
      await this.launch();
    }

    const page = this.page;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }

    const collected: InterceptedConversation[] = [];
    let done = false;

    const extractFromAnyPayload = (payload: any): InterceptedConversation[] => {
      const out: InterceptedConversation[] = [];
      const seen = new Set<string>();

      const pushThread = (thread: any): void => {
        const threadId = String(thread?.thread_id || thread?.id || "");
        if (!threadId || seen.has(threadId)) return;
        seen.add(threadId);

        const users = Array.isArray(thread?.users)
          ? thread.users
              .map((u: any) => u?.username || u?.user?.username)
              .filter((v: unknown) => typeof v === "string")
          : [];

        let lastMessage = "";
        if (Array.isArray(thread?.items) && thread.items[0]) {
          lastMessage = String(thread.items[0]?.text || thread.items[0]?.item_type || "");
        } else if (thread?.last_message) {
          lastMessage = String(thread.last_message?.text || thread.last_message || "");
        } else if (thread?.latest_recipients?.[0]?.last_seen_at) {
          lastMessage = "Sem preview";
        }

        const title =
          String(thread?.thread_title || thread?.title || "").trim() ||
          users.join(", ") ||
          "Sem titulo";

        out.push({
          threadId,
          title,
          users,
          lastMessage,
        });
      };

      const walk = (node: any): void => {
        if (!node) return;
        if (Array.isArray(node)) {
          for (const item of node) walk(item);
          return;
        }
        if (typeof node !== "object") return;

        const hasThreadShape =
          "thread_id" in node ||
          (("thread_title" in node || "title" in node) &&
            ("users" in node || "items" in node || "last_message" in node));
        if (hasThreadShape) {
          pushThread(node);
        }

        for (const value of Object.values(node)) {
          walk(value);
        }
      };

      walk(payload);
      return out;
    };

    const onResponse = async (response: any): Promise<void> => {
      try {
        const url = response.url() as string;
        if (
          !url.includes("/api/v1/direct_v2/inbox/") &&
          !url.includes("/api/v1/direct_v2/threads/") &&
          !url.includes("/graphql/query") &&
          !url.includes("/api/graphql")
        ) {
          return;
        }
        const json = await response.json().catch(() => null);
        if (!json || done) return;

        const extracted = extractFromAnyPayload(json);
        collected.push(...extracted);
      } catch {
        // Ignore parse errors from non-JSON or blocked responses.
      }
    };

    page.on("response", onResponse);
    try {
      await page.goto("https://www.instagram.com/direct/inbox/", {
        waitUntil: "networkidle2",
      });
      await this.handlePostLoginPrompts();
      await sleep(timeoutMs);
      done = true;
    } finally {
      page.off("response", onResponse);
    }

    const unique = new Map<string, InterceptedConversation>();
    for (const item of collected) {
      if (!item.threadId) continue;
      if (!unique.has(item.threadId)) {
        unique.set(item.threadId, item);
      }
    }

    if (unique.size === 0) {
      const fetched = await page.evaluate(async () => {
        const endpoints = [
          "/api/v1/direct_v2/web_inbox/",
          "/api/v1/direct_v2/inbox/",
          "/api/v1/direct_v2/web_pending_inbox/",
        ];

        const results: Array<{
          threadId: string;
          title: string;
          users: string[];
          lastMessage: string;
        }> = [];

        for (const endpoint of endpoints) {
          try {
            const response = await fetch(endpoint, {
              method: "GET",
              credentials: "include",
              headers: {
                Accept: "application/json",
                "X-Requested-With": "XMLHttpRequest",
              },
            });
            if (!response.ok) continue;
            const json = await response.json();
            const threads = json?.inbox?.threads || json?.threads || [];
            for (const thread of threads) {
              const users = Array.isArray(thread?.users)
                ? thread.users
                    .map((u: any) => u?.username)
                    .filter((v: unknown) => typeof v === "string")
                : [];
              const title = thread?.thread_title || users.join(", ") || "Sem titulo";
              const lastMessage = thread?.items?.[0]?.text || thread?.items?.[0]?.item_type || "";
              results.push({
                threadId: String(thread?.thread_id || ""),
                title,
                users,
                lastMessage: String(lastMessage || ""),
              });
            }
          } catch {
            // Ignore blocked/unavailable endpoint.
          }
        }
        return results;
      });

      for (const item of fetched) {
        if (!item.threadId) continue;
        if (!unique.has(item.threadId)) {
          unique.set(item.threadId, item);
        }
      }
    }

    if (unique.size === 0) {
      const fromDom = await page.evaluate(() => {
        const results: Array<{
          threadId: string;
          title: string;
          users: string[];
          lastMessage: string;
        }> = [];

        const anchors = Array.from(
          document.querySelectorAll('a[href*="/direct/t/"]'),
        ) as HTMLAnchorElement[];

        for (const anchor of anchors) {
          const href = anchor.getAttribute("href") || "";
          const match = href.match(/\/direct\/t\/([^/]+)/);
          const threadId = match?.[1] || "";
          if (!threadId) continue;

          const textParts = Array.from(anchor.querySelectorAll("span"))
            .map((el) => (el.textContent || "").trim())
            .filter(Boolean);

          results.push({
            threadId,
            title: textParts[0] || "Sem titulo",
            users: [],
            lastMessage: textParts[1] || "",
          });
        }

        // Fallback quando usuario esta dentro de uma thread e a lista lateral nao carregou.
        if (results.length === 0) {
          const currentPath = window.location.pathname;
          const match = currentPath.match(/\/direct\/t\/([^/]+)/);
          const threadId = match?.[1] || "";
          if (threadId) {
            const headerName =
              (document.querySelector("header h2")?.textContent || "").trim() ||
              (document.querySelector("header span")?.textContent || "").trim() ||
              "Thread atual";
            results.push({
              threadId,
              title: headerName,
              users: [],
              lastMessage: "",
            });
          }
        }

        return results;
      });

      for (const item of fromDom) {
        if (!item.threadId) continue;
        if (!unique.has(item.threadId)) {
          unique.set(item.threadId, item);
        }
      }
    }

    return Array.from(unique.values());
  }

  public async debugInboxTraffic(timeoutMs = 12000): Promise<TrafficRecord[]> {
    if (!this.page) {
      await this.launch();
    }

    const page = this.page;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }

    const records: TrafficRecord[] = [];

    const onRequest = (request: any): void => {
      const url = request.url() as string;
      const resourceType = request.resourceType?.() || "unknown";
      if (
        resourceType === "xhr" ||
        resourceType === "fetch" ||
        resourceType === "websocket" ||
        url.includes("direct") ||
        url.includes("graphql")
      ) {
        records.push({
          type: resourceType,
          method: request.method?.() || "GET",
          url,
        });
      }
    };

    const onResponse = (response: any): void => {
      const req = response.request?.();
      if (!req) return;
      const url = req.url?.() || "";
      const resourceType = req.resourceType?.() || "unknown";
      if (
        resourceType === "xhr" ||
        resourceType === "fetch" ||
        resourceType === "websocket" ||
        url.includes("direct") ||
        url.includes("graphql")
      ) {
        records.push({
          type: resourceType,
          method: req.method?.() || "GET",
          url,
          status: response.status?.(),
        });
      }
    };

    page.on("request", onRequest);
    page.on("response", onResponse);
    try {
      await page.goto("https://www.instagram.com/direct/inbox/", {
        waitUntil: "networkidle2",
      });
      await this.handlePostLoginPrompts();
      await sleep(timeoutMs);
    } finally {
      page.off("request", onRequest);
      page.off("response", onResponse);
    }

    const unique = new Map<string, TrafficRecord>();
    for (const item of records) {
      const key = `${item.type}|${item.method}|${item.url}|${item.status ?? ""}`;
      if (!unique.has(key)) unique.set(key, item);
    }
    return Array.from(unique.values());
  }

  public async debugMessageTransport(timeoutMs = 15000): Promise<MessageTransportRecord[]> {
    if (!this.page) {
      await this.launch();
    }

    const page = this.page;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }

    const records: MessageTransportRecord[] = [];

    const onRequest = (request: any): void => {
      const url = request.url() as string;
      if (!this.isMessageTransportUrl(url)) return;
      records.push({
        phase: "request",
        method: request.method?.() || "GET",
        url,
        timestamp: new Date().toISOString(),
      });
    };

    const onResponse = async (response: any): Promise<void> => {
      const req = response.request?.();
      if (!req) return;
      const url = req.url?.() || "";
      if (!this.isMessageTransportUrl(url)) return;

      const method = req.method?.() || "GET";
      const status = response.status?.();
      let payload: any = null;
      let payloadBytes = 0;

      try {
        payload = await response.json().catch(() => null);
        if (!payload) {
          const raw = await response.text().catch(() => "");
          payloadBytes = raw ? Buffer.byteLength(raw, "utf-8") : 0;
          if (raw) {
            payload = JSON.parse(raw);
          }
        } else {
          const raw = JSON.stringify(payload);
          payloadBytes = Buffer.byteLength(raw, "utf-8");
        }
      } catch {
        payload = null;
      }

      if (!payload) {
        records.push({
          phase: "response",
          method,
          url,
          status,
          payloadBytes,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const messages = this.parseMessagesFromPayload(payload);
      const topLevelKeys =
        payload && typeof payload === "object" && !Array.isArray(payload)
          ? Object.keys(payload).slice(0, 15)
          : [];

      records.push({
        phase: "response",
        method,
        url,
        status,
        payloadBytes,
        messageCount: messages.length,
        threadIds: Array.from(new Set(messages.map((m) => m.threadId))).slice(0, 10),
        textPreview: messages
          .map((m) => m.text)
          .filter(Boolean)
          .slice(0, 5),
        topLevelKeys,
        timestamp: new Date().toISOString(),
      });
    };

    page.on("request", onRequest);
    page.on("response", onResponse);
    try {
      await page.goto("https://www.instagram.com/direct/inbox/", {
        waitUntil: "networkidle2",
      });
      await this.handlePostLoginPrompts();
      await sleep(timeoutMs);
    } finally {
      page.off("request", onRequest);
      page.off("response", onResponse);
    }

    const unique = new Map<string, MessageTransportRecord>();
    for (const item of records) {
      const key = `${item.phase}|${item.method}|${item.url}|${item.status ?? ""}|${item.messageCount ?? ""}|${item.payloadBytes ?? ""}|${item.timestamp.slice(0, 19)}`;
      if (!unique.has(key)) unique.set(key, item);
    }
    return Array.from(unique.values());
  }

  public async debugInstagramSocket(timeoutMs = 15000): Promise<InstagramSocketFrameRecord[]> {
    if (!this.page) {
      await this.launch();
    }

    const page = this.page;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }

    const session = await page.target().createCDPSession();
    await session.send("Network.enable");

    const socketUrlByRequestId = new Map<string, string>();
    const records: InstagramSocketFrameRecord[] = [];

    const pushFrame = (
      direction: "sent" | "received",
      requestId: string,
      payloadData: string,
      opcode: number,
    ): void => {
      const url = socketUrlByRequestId.get(requestId) || "";
      if (!url.includes("instagram.com")) return;
      const decoded = this.decodeWebsocketPayload(payloadData, opcode);
      records.push({
        direction,
        url,
        opcode,
        payloadBytes: decoded.payloadBytes,
        payloadEncoding: decoded.payloadEncoding,
        textPreview: decoded.textPreview,
        hasDirectSignal: decoded.hasDirectSignal,
        timestamp: new Date().toISOString(),
      });
    };

    const onCreated = (event: any): void => {
      const requestId = String(event?.requestId || "");
      const url = String(event?.url || "");
      if (!requestId || !url) return;
      socketUrlByRequestId.set(requestId, url);
    };

    const onFrameReceived = (event: any): void => {
      const requestId = String(event?.requestId || "");
      const response = event?.response || {};
      pushFrame(
        "received",
        requestId,
        String(response?.payloadData || ""),
        Number(response?.opcode || 0),
      );
    };

    const onFrameSent = (event: any): void => {
      const requestId = String(event?.requestId || "");
      const response = event?.response || {};
      pushFrame(
        "sent",
        requestId,
        String(response?.payloadData || ""),
        Number(response?.opcode || 0),
      );
    };

    const onClosed = (event: any): void => {
      const requestId = String(event?.requestId || "");
      if (requestId) socketUrlByRequestId.delete(requestId);
    };

    session.on("Network.webSocketCreated", onCreated);
    session.on("Network.webSocketFrameReceived", onFrameReceived);
    session.on("Network.webSocketFrameSent", onFrameSent);
    session.on("Network.webSocketClosed", onClosed);

    try {
      await page.goto("https://www.instagram.com/direct/inbox/", {
        waitUntil: "networkidle2",
      });
      await this.handlePostLoginPrompts();
      await sleep(timeoutMs);
    } finally {
      session.off("Network.webSocketCreated", onCreated);
      session.off("Network.webSocketFrameReceived", onFrameReceived);
      session.off("Network.webSocketFrameSent", onFrameSent);
      session.off("Network.webSocketClosed", onClosed);
      await session.detach().catch(() => null);
    }

    return records.filter((r) => r.url.includes("instagram.com"));
  }

  public async probeInstagramRealtime(timeoutMs = 15000): Promise<InstagramSocketProbeResult> {
    const frames = await this.debugInstagramSocket(timeoutMs);
    const channelsMap = new Map<
      string,
      { url: string; count: number; received: number; sent: number; opcodes: Set<number> }
    >();
    const payloadPatternMap = new Map<
      string,
      { signature: string; count: number; opcode: number; encoding: "text" | "base64-binary" }
    >();

    for (const frame of frames) {
      const channel =
        channelsMap.get(frame.url) || {
          url: frame.url,
          count: 0,
          received: 0,
          sent: 0,
          opcodes: new Set<number>(),
        };
      channel.count += 1;
      if (frame.direction === "received") channel.received += 1;
      if (frame.direction === "sent") channel.sent += 1;
      channel.opcodes.add(frame.opcode);
      channelsMap.set(frame.url, channel);

      const signature = `${frame.payloadEncoding}|op${frame.opcode}|${frame.textPreview.slice(0, 40)}`;
      const pat =
        payloadPatternMap.get(signature) || {
          signature,
          count: 0,
          opcode: frame.opcode,
          encoding: frame.payloadEncoding,
        };
      pat.count += 1;
      payloadPatternMap.set(signature, pat);
    }

    const channels = Array.from(channelsMap.values())
      .map((c) => ({
        url: c.url,
        count: c.count,
        received: c.received,
        sent: c.sent,
        opcodes: Array.from(c.opcodes.values()).sort((a, b) => a - b),
      }))
      .sort((a, b) => b.count - a.count);

    const topPayloadPatterns = Array.from(payloadPatternMap.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    const directFrames = frames.filter((f) => f.hasDirectSignal);
    return {
      timeoutMs,
      totalFrames: frames.length,
      directSignalFrames: directFrames.length,
      channels,
      topPayloadPatterns,
      sampleDirectFrames: directFrames.slice(0, 20),
    };
  }

  public async sendMessageToConversation(
    conversationTitle: string,
    text: string,
    options?: { dedicatedTab?: boolean },
  ): Promise<SendMessageResult> {
    const useDedicatedTab = Boolean(options?.dedicatedTab);
    if (!useDedicatedTab && !this.page) {
      await this.launch();
    }

    const page = useDedicatedTab
      ? await this.getOrCreateConversationPage(conversationTitle)
      : this.page;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }

    await this.ensureConversationOpen(conversationTitle, page);
    await page.bringToFront().catch(() => null);
    await sleep(1800);

    const messageInputSelector =
      'textarea[placeholder*="Message"], textarea[placeholder*="Mensagem"], div[contenteditable="true"][role="textbox"]';

    await page.waitForSelector(messageInputSelector, { timeout: 30000 });
    const input = await page.$(messageInputSelector);
    if (!input) {
      throw new Error("Campo de mensagem nao encontrado.");
    }

    await input.click({ clickCount: 1 });
    await page.keyboard.type(text, { delay: 25 });
    await page.keyboard.press("Enter");
    await sleep(1200);

    const finalThreadId = this.extractThreadIdFromUrl(page.url());
    this.lastSendTargetKey = conversationTitle.trim().toLowerCase();
    this.lastSendThreadId = finalThreadId;

    return {
      success: true,
      conversationTitle,
      text,
      url: page.url(),
    };
  }

  public async openConversationByTitle(
    conversationTitle: string,
    options?: { dedicatedTab?: boolean },
  ): Promise<OpenConversationResult> {
    const useDedicatedTab = Boolean(options?.dedicatedTab);
    if (!useDedicatedTab && !this.page) {
      await this.launch();
    }

    const page = useDedicatedTab
      ? await this.getOrCreateConversationPage(conversationTitle)
      : this.page;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }

    await this.ensureConversationOpen(conversationTitle, page);
    await sleep(700);

    return {
      success: true,
      conversationTitle,
      url: page.url(),
    };
  }

  private extractThreadIdFromUrl(url: string): string | null {
    const match = url.match(/\/direct\/t\/([^/?#]+)/i);
    return match?.[1] ?? null;
  }

  private async ensureConversationOpen(conversationTitle: string, page: Page): Promise<void> {
    const wanted = conversationTitle.trim().toLowerCase();
    if (!wanted) {
      throw new Error("conversationTitle e obrigatorio.");
    }

    const currentThreadId = this.extractThreadIdFromUrl(page.url());
    const canReuseByCache =
      Boolean(currentThreadId) &&
      Boolean(this.lastSendTargetKey) &&
      this.lastSendTargetKey === wanted &&
      this.lastSendThreadId === currentThreadId;

    let shouldNavigateInbox = !canReuseByCache;
    if (!canReuseByCache && currentThreadId) {
      const alreadyOnWantedThread = await page.evaluate((targetTitle) => {
        const wantedTitle = targetTitle.trim().toLowerCase();
        if (!wantedTitle) return false;

        const candidates = Array.from(
          document.querySelectorAll("header h2, header h1, header span, main h2, main h1"),
        ) as HTMLElement[];

        for (const node of candidates) {
          const textContent = (node.textContent || "").trim().toLowerCase();
          if (textContent && textContent.includes(wantedTitle)) {
            return true;
          }
        }

        return false;
      }, conversationTitle);

      shouldNavigateInbox = !alreadyOnWantedThread;
    }

    if (shouldNavigateInbox) {
      await page.goto("https://www.instagram.com/direct/inbox/", {
        waitUntil: "networkidle2",
      });
      await this.handlePostLoginPrompts();
    } else {
      await sleep(250);
    }

    const clicked = shouldNavigateInbox
      ? await page.evaluate((targetTitle) => {
          const wantedTitle = targetTitle.trim().toLowerCase();
          const links = Array.from(
            document.querySelectorAll('a[href*="/direct/t/"]'),
          ) as HTMLAnchorElement[];

          for (const link of links) {
            const linkText = (link.textContent || "").trim().toLowerCase();
            if (linkText.includes(wantedTitle)) {
              link.click();
              return true;
            }
          }
          return false;
        }, conversationTitle)
      : false;

    if (shouldNavigateInbox && !clicked) {
      const threads = await this.listConversationsByNetworkIntercept(7000);
      const match = threads.find((t) => {
        const title = t.title.toLowerCase();
        const users = t.users.join(" ").toLowerCase();
        return title.includes(wanted) || users.includes(wanted);
      });

      if (!match) {
        throw new Error(`Conversa nao encontrada: ${conversationTitle}`);
      }

      await page.goto(`https://www.instagram.com/direct/t/${match.threadId}/`, {
        waitUntil: "networkidle2",
      });
    }

    // Garante que realmente estamos dentro de uma thread antes de enviar.
    await page
      .waitForFunction(() => window.location.pathname.includes("/direct/t/"), {
        timeout: 15000,
      })
      .catch(() => null);

    const onThread = page.url().includes("/direct/t/");
    if (!onThread) {
      throw new Error(
        `Conversa nao ficou ativa para envio: ${conversationTitle}. URL atual: ${page.url()}`,
      );
    }

    const finalThreadId = this.extractThreadIdFromUrl(page.url());
    this.lastSendTargetKey = wanted;
    this.lastSendThreadId = finalThreadId;
  }

  public async listMessagesByThreadId(
    threadId: string,
    limit = 20,
  ): Promise<{ threadId: string; count: number; messages: MessageItem[]; url: string }> {
    if (!this.page) {
      await this.launch();
    }

    const page = this.page;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }

    const targetUrl = `https://www.instagram.com/direct/t/${threadId}/`;
    const currentUrl = page.url();
    const alreadyOnThread =
      currentUrl.startsWith(targetUrl) ||
      currentUrl.startsWith(targetUrl.replace(/\/$/, ""));

    if (!alreadyOnThread) {
      await page.goto(targetUrl, { waitUntil: "networkidle2" });
      await this.handlePostLoginPrompts();
      await sleep(1500);
    } else {
      // Ja estamos na thread: so aguarda o DOM respirar (caso tenha acabado
      // de chegar uma mensagem em tempo real) sem recarregar a pagina.
      await sleep(300);
    }

    const messages = await page.evaluate((maxItems) => {
      const blocked = new Set([
        "message...",
        "mensagem...",
        "send message",
        "enviar mensagem",
        "view profile",
        "ver perfil",
        "active now",
        "agora",
      ]);

      const main = document.querySelector("main") as HTMLElement | null;
      const mainRect = main?.getBoundingClientRect() || null;

      const detectSender = (node: HTMLElement): "me" | "other" => {
        // 1) Caminha pela arvore procurando um container flex com sinal claro
        // de alinhamento (justify-content ou align-self). O web app do Instagram
        // renderiza as linhas da thread como flex com justify-content flex-end
        // para mensagens do usuario logado e flex-start para as dos outros.
        let cursor: HTMLElement | null = node;
        for (let depth = 0; depth < 10 && cursor; depth += 1) {
          const style = window.getComputedStyle(cursor);
          if (style.display === "flex") {
            const jc = style.justifyContent;
            if (jc === "flex-end" || jc === "end" || jc === "right") {
              return "me";
            }
            if (jc === "flex-start" || jc === "start" || jc === "left") {
              // flex-start em linhas de mensagens costuma ser "outro", mas
              // so aceita se a linha for realmente larga o suficiente para
              // indicar alinhamento (nao containers internos pequenos).
              const rect = cursor.getBoundingClientRect();
              if (mainRect && rect.width > mainRect.width * 0.4) {
                return "other";
              }
            }
          }
          const as = style.alignSelf;
          if (as === "flex-end" || as === "end") return "me";
          if (as === "flex-start" || as === "start") {
            const rect = cursor.getBoundingClientRect();
            if (mainRect && rect.width > mainRect.width * 0.4) {
              return "other";
            }
          }
          cursor = cursor.parentElement;
        }

        // 2) Fallback geometrico: compara o espaco livre a esquerda e a
        // direita da bolha dentro do <main>. Se o espaco a esquerda for
        // substancialmente maior, a bolha esta empurrada para a direita (me).
        const rect = node.getBoundingClientRect();
        if (mainRect) {
          const leftSpace = rect.left - mainRect.left;
          const rightSpace = mainRect.right - rect.right;
          if (leftSpace - rightSpace > 40) return "me";
          if (rightSpace - leftSpace > 40) return "other";
        }

        // 3) Ultimo recurso: heuristica antiga (centerX vs viewport).
        const centerX = rect.left + rect.width / 2;
        return centerX > window.innerWidth * 0.55 ? "me" : "other";
      };

      const nodes = Array.from(
        document.querySelectorAll("main div[dir='auto']"),
      ) as HTMLElement[];

      const collected: Array<{
        text: string;
        sender: "me" | "other";
        timestamp: string | null;
      }> = [];
      for (const node of nodes) {
        const text = (node.textContent || "").trim();
        if (!text) continue;
        const normalized = text.toLowerCase();
        if (blocked.has(normalized)) continue;
        if (normalized.length < 2) continue;

        const sender = detectSender(node);

        // Tenta capturar horario relativo/absoluto a partir de elementos <time> proximos.
        let timestamp: string | null = null;
        const parent = node.closest("li, div");
        const timeElement =
          parent?.querySelector("time") ||
          node.parentElement?.querySelector("time") ||
          null;
        if (timeElement) {
          timestamp =
            timeElement.getAttribute("datetime") ||
            (timeElement.textContent || "").trim() ||
            null;
        }

        collected.push({ text, sender, timestamp });
      }

      // Dedup simples mantendo ordem para evitar labels repetidas.
      const deduped: Array<{
        text: string;
        sender: "me" | "other";
        timestamp: string | null;
      }> = [];
      for (const item of collected) {
        const prev = deduped[deduped.length - 1];
        if (
          !prev ||
          prev.text !== item.text ||
          prev.sender !== item.sender ||
          prev.timestamp !== item.timestamp
        ) {
          deduped.push(item);
        }
      }

      return deduped.slice(-maxItems);
    }, limit);

    return {
      threadId,
      count: messages.length,
      messages,
      url: page.url(),
    };
  }

  public async close(): Promise<void> {
    this.stopMessageListener();
    this.stopThreadListener();
    this.stopDmTap();
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
      this.dmTapPage = null;
      this.conversationPages.clear();
      this.dmTapBridgeInstalled = false;
      this.dmTapInitScriptInstalled = false;
    }
  }

  public async startMessageListener(
    onMessage: (event: IncomingMessageEvent) => void,
  ): Promise<{ started: boolean; url: string }> {
    if (!this.page) {
      await this.launch();
    }

    const page = this.page;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }

    if (this.messageListenerActive) {
      return { started: true, url: page.url() };
    }

    await this.loadSeenMessageIds();

    await page.goto("https://www.instagram.com/direct/inbox/", {
      waitUntil: "networkidle2",
    });
    await this.handlePostLoginPrompts();

    const onResponse = async (response: any): Promise<void> => {
      if (!this.messageListenerActive) return;
      try {
        const url = response.url() as string;
        if (!this.isMessageTransportUrl(url)) {
          return;
        }

        let json: any = await response.json().catch(() => null);
        if (!json) {
          const raw = await response.text().catch(() => "");
          if (raw) {
            json = JSON.parse(raw);
          }
        }
        if (!json) return;
        const events = this.parseMessagesFromPayload(json);
        for (const event of events) {
          if (this.seenMessageIds.has(event.messageId)) continue;
          this.seenMessageIds.add(event.messageId);
          onMessage(event);
          await this.persistSeenMessageIds().catch(() => null);
        }
      } catch {
        // Ignore non-JSON and cross-origin parsing issues.
      }
    };

    const lastPreviewByThread = new Map<string, string>();
    let inboxApiCycle = 0;

    const pollInboxApiMessages = async (): Promise<void> => {
      if (!this.messageListenerActive) return;
      try {
        inboxApiCycle += 1;
        // Revezamento leve entre endpoints usados pelo web app.
        const endpoint =
          inboxApiCycle % 3 === 0
            ? "/api/v1/direct_v2/web_pending_inbox/"
            : inboxApiCycle % 2 === 0
              ? "/api/v1/direct_v2/inbox/"
              : "/api/v1/direct_v2/web_inbox/";

        const payload = await page.evaluate(async (url) => {
          try {
            const response = await fetch(url, {
              method: "GET",
              credentials: "include",
              headers: {
                Accept: "application/json",
                "X-Requested-With": "XMLHttpRequest",
              },
            });
            if (!response.ok) return null;
            return await response.json();
          } catch {
            return null;
          }
        }, endpoint);

        if (!payload) return;
        const events = this.parseMessagesFromPayload(payload);
        for (const event of events) {
          if (this.seenMessageIds.has(event.messageId)) continue;
          this.seenMessageIds.add(event.messageId);
          onMessage(event);
        }
        await this.persistSeenMessageIds().catch(() => null);
      } catch {
        // Ignore temporary network/browser-context errors.
      }
    };

    const pollForInboxChanges = async (): Promise<void> => {
      if (!this.messageListenerActive) return;
      try {
        const snapshots = await page.evaluate(() => {
          const anchors = Array.from(
            document.querySelectorAll('a[href*="/direct/t/"]'),
          ) as HTMLAnchorElement[];
          const out: Array<{ threadId: string; preview: string }> = [];
          for (const anchor of anchors) {
            const href = anchor.getAttribute("href") || "";
            const match = href.match(/\/direct\/t\/([^/]+)/);
            const threadId = match?.[1] || "";
            if (!threadId) continue;
            const spans = Array.from(anchor.querySelectorAll("span"))
              .map((el) => (el.textContent || "").trim())
              .filter(Boolean);
            const preview = spans[1] || "";
            out.push({ threadId, preview });
          }
          return out;
        });

        for (const item of snapshots) {
          if (!item.threadId || !item.preview) continue;
          const prev = lastPreviewByThread.get(item.threadId) || "";
          if (prev && prev !== item.preview) {
            const messageId = `poll:${item.threadId}:${item.preview}`;
            if (!this.seenMessageIds.has(messageId)) {
              this.seenMessageIds.add(messageId);
              onMessage({
                messageId,
                threadId: item.threadId,
                senderUsername: null,
                text: item.preview,
                timestamp: null,
              });
              await this.persistSeenMessageIds().catch(() => null);
            }
          }
          lastPreviewByThread.set(item.threadId, item.preview);
        }
      } catch {
        // Ignore transient DOM access issues during navigation.
      }
    };

    let pollTimer: NodeJS.Timeout | null = null;
    page.on("response", onResponse);
    pollTimer = setInterval(() => {
      void pollForInboxChanges();
      void pollInboxApiMessages();
    }, 7000);

    this.messageListenerCleanup = () => {
      page.off("response", onResponse);
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };
    this.messageListenerActive = true;
    // Primeira leitura do snapshot da inbox.
    void pollForInboxChanges();
    void pollInboxApiMessages();

    return { started: true, url: page.url() };
  }

  public stopMessageListener(): { stopped: boolean } {
    if (!this.messageListenerActive) return { stopped: true };
    this.messageListenerActive = false;
    if (this.messageListenerCleanup) {
      this.messageListenerCleanup();
      this.messageListenerCleanup = null;
    }
    return { stopped: true };
  }

  public async startThreadListener(
    threadId: string,
    onMessage: (event: IncomingMessageEvent) => void,
  ): Promise<{ started: boolean; threadId: string; url: string }> {
    if (!this.page) {
      await this.launch();
    }
    const page = this.page;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }
    if (!threadId) {
      throw new Error("threadId e obrigatorio.");
    }

    if (this.threadListenerActive) {
      return { started: true, threadId, url: page.url() };
    }

    await this.loadSeenMessageIds();
    await page.goto(`https://www.instagram.com/direct/t/${threadId}/`, {
      waitUntil: "networkidle2",
    });
    await this.handlePostLoginPrompts();

    let pollTimer: NodeJS.Timeout | null = null;

    const pollThreadMessages = async (emitNew: boolean): Promise<void> => {
      if (!this.threadListenerActive) return;
      try {
        const messages = await this.listMessagesByThreadId(threadId, 30);
        for (const item of messages.messages) {
          const messageId = `thread:${threadId}:${item.sender}:${item.text}:${item.timestamp ?? ""}`;
          if (this.seenMessageIds.has(messageId)) continue;
          this.seenMessageIds.add(messageId);
          if (emitNew) {
            onMessage({
              messageId,
              threadId,
              senderUsername: item.sender === "me" ? "me" : null,
              text: item.text,
              timestamp: item.timestamp,
            });
          }
        }
        await this.persistSeenMessageIds().catch(() => null);
      } catch {
        // Ignore transient issues (navigation/render delays)
      }
    };

    this.threadListenerActive = true;
    // Primeira leitura para "seed" (sem emitir historico).
    await pollThreadMessages(false);
    pollTimer = setInterval(() => {
      void pollThreadMessages(true);
    }, 4000);

    this.threadListenerCleanup = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    return { started: true, threadId, url: page.url() };
  }

  public stopThreadListener(): { stopped: boolean } {
    if (!this.threadListenerActive) return { stopped: true };
    this.threadListenerActive = false;
    if (this.threadListenerCleanup) {
      this.threadListenerCleanup();
      this.threadListenerCleanup = null;
    }
    return { stopped: true };
  }

  public async startDmTap(
    onMessage: (event: DmTapEvent) => void,
    onDebug?: (msg: { kind: string; data: unknown; ts: string }) => void,
  ): Promise<{ started: boolean; url: string }> {
    const page = await this.getOrCreateDmTapPage();

    this.dmTapHandler = onMessage;
    this.dmTapDebugHandler = onDebug || null;

    if (!this.dmTapBridgeInstalled) {
      // exposeFunction falha se chamado duas vezes; guard com flag
      await page.exposeFunction("__igDmTapEmit", (evt: DmTapEvent) => {
        if (!this.dmTapActive || !this.dmTapHandler) return;
        try {
          this.dmTapHandler(evt);
        } catch (err) {
          console.warn(
            `[${new Date().toISOString()}] [insta-connect] dmTap handler error:`,
            err instanceof Error ? err.message : String(err),
          );
        }
      });
      await page.exposeFunction(
        "__igDmTapDebug",
        (msg: { kind: string; data: unknown; ts: string }) => {
          if (!this.dmTapActive || !this.dmTapDebugHandler) return;
          try {
            this.dmTapDebugHandler(msg);
          } catch {
            // swallow
          }
        },
      );
      this.dmTapBridgeInstalled = true;
    }

    // Propaga a preferencia de debug para o IIFE. Sem onDebug -> flag=false
    // (default silencioso, evita flood em producao). O IIFE le isDebugOn()
    // dinamicamente, entao mudar a flag em runtime tem efeito imediato.
    const debugOn = Boolean(onDebug);

    if (!this.dmTapInitScriptInstalled) {
      // evaluateOnNewDocument garante que o monkey-patch roda ANTES de qualquer
      // script do IG, inclusive em navegacoes futuras e iframes.
      // A flag de debug vai em script separado para poder ser ajustada depois.
      await page.evaluateOnNewDocument(
        `window.__IG_DM_TAP_DEBUG__ = ${JSON.stringify(debugOn)};`,
      );
      await page.evaluateOnNewDocument(DM_TAP_SOURCE);
      this.dmTapInitScriptInstalled = true;
    }

    // Injeta/atualiza na pagina atual:
    //  1) seta a flag de debug para o valor desejado AGORA
    //  2) instala o IIFE caso ainda nao esteja ativo nesta pagina
    await page
      .evaluate(
        (src: string, debug: boolean) => {
          const w = window as unknown as {
            __IG_DM_TAP_INSTALLED__?: boolean;
            __IG_DM_TAP_DEBUG__?: boolean;
          };
          w.__IG_DM_TAP_DEBUG__ = debug;
          if (!w.__IG_DM_TAP_INSTALLED__) {
            const fn = new Function(src);
            fn();
          }
        },
        DM_TAP_SOURCE,
        debugOn,
      )
      .catch(() => null);

    this.dmTapActive = true;

    // Garante que estamos em /direct/... - o Instagram so abre a conexao MQTT
    // realtime quando o user esta na inbox/thread, nao na home.
    const current = page.url();
    const onDirect = current.includes("instagram.com/direct");
    if (!onDirect) {
      await page.goto("https://www.instagram.com/direct/inbox/", {
        waitUntil: "networkidle2",
      });
      await this.handlePostLoginPrompts();
    }

    return { started: true, url: page.url() };
  }

  public stopDmTap(): { stopped: boolean } {
    if (!this.dmTapActive) return { stopped: true };
    this.dmTapActive = false;
    this.dmTapHandler = null;
    this.dmTapDebugHandler = null;
    return { stopped: true };
  }

  public async getDmTapStats(): Promise<Record<string, unknown>> {
    const page = this.dmTapPage;
    if (!page || page.isClosed()) {
      throw new Error("Pagina dedicada do dmTap nao inicializada.");
    }
    const stats = await page.evaluate(() => {
      const w = window as unknown as { __IG_DM_TAP_STATS__?: Record<string, unknown> };
      return w.__IG_DM_TAP_STATS__ || null;
    });
    return stats || {};
  }

  public async getInstagramMediaAuthHeaders(): Promise<Record<string, string>> {
    const page = (this.dmTapPage && !this.dmTapPage.isClosed() ? this.dmTapPage : this.page) || null;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }

    const cookies = await page.cookies("https://www.instagram.com");
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => "");

    return {
      cookie: cookieHeader,
      "user-agent": userAgent || "Mozilla/5.0",
      referer: "https://www.instagram.com/direct/inbox/",
      accept: "*/*",
    };
  }
}

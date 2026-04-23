import puppeteer, { Browser, type LaunchOptions, Page } from "puppeteer";
import fs from "node:fs/promises";
import path from "node:path";
import { DM_TAP_SOURCE } from "../browser/dm-tap.source";
import { parseMessagesFromPayload } from "../lib/parse-messages-from-payload";
import { sleep } from "../lib/sleep";
import { decodeWebsocketPayload, isMessageTransportUrl } from "../lib/websocket-payload";
import { collectUsersFromSearchJson } from "../lib/instagram-search-json";
import type { HTTPResponse } from "puppeteer";
import type {
  AutoFollowPrivacyFilter,
  ConversationSummary,
  DmTapEvent,
  AutoFollowSuggestedResult,
  FollowUserResult,
  InstaConnectConfig,
  InstaConnectLaunchCustomize,
  InstaConnectOptions,
  IncomingMessageEvent,
  InstagramSearchUser,
  InstagramSuggestedUser,
  InterceptedConversation,
  InstagramSocketFrameRecord,
  InstagramSocketProbeResult,
  LoginResult,
  MessageItem,
  MessageTransportRecord,
  OpenConversationResult,
  SendMessageResult,
  TrafficRecord,
} from "../types";

export class InstaConnect {
  private instaConfig: InstaConnectConfig & { basePath: string };
  private options: LaunchOptions;
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

  /** Instagram troca para layout "mobile" em viewports estreitas; o padrao e desktop. */
  private getDesktopViewport() {
    const rawW = Number(this.instaConfig.viewportWidth);
    const rawH = Number(this.instaConfig.viewportHeight);
    const w = Math.min(3840, Math.max(1024, Number.isFinite(rawW) && rawW > 0 ? Math.floor(rawW) : 1000));
    const h = Math.min(2160, Math.max(600, Number.isFinite(rawH) && rawH > 0 ? Math.floor(rawH) : 600));
    return { width: w, height: h, deviceScaleFactor: 1, isMobile: false, hasTouch: false } as const;
  }

  private async applyDesktopViewportToPage(page: Page): Promise<void> {
    try {
      await page.setViewport(this.getDesktopViewport());
    } catch {
      // noop
    }
  }

  constructor(
    options: InstaConnectOptions = {},
    customizeLaunch?: InstaConnectLaunchCustomize,
  ) {
    const { insta, args: userArgs, defaultViewport: userViewport, headless: headlessFromLaunch, ...rest } =
      options;
    this.instaConfig = {
      basePath: insta?.basePath ?? process.cwd(),
      sessionDir: insta?.sessionDir,
      seenMessagesFile: insta?.seenMessagesFile,
      viewportWidth: insta?.viewportWidth,
      viewportHeight: insta?.viewportHeight,
      headless: insta?.headless,
    };
    this.sessionDir = path.resolve(
      this.instaConfig.basePath,
      this.instaConfig.sessionDir || ".session/chrome-profile",
    );
    const vp = this.getDesktopViewport();
    const headless: LaunchOptions["headless"] =
      headlessFromLaunch !== undefined
        ? headlessFromLaunch
        : this.instaConfig.headless !== undefined
          ? this.instaConfig.headless
          : false;
    let launch: LaunchOptions = {
      headless,
      userDataDir: this.sessionDir,
      defaultViewport: userViewport !== undefined ? userViewport : { ...vp },
      args: [`--window-size=${vp.width},${vp.height}`, ...(Array.isArray(userArgs) ? userArgs : [])],
      ...rest,
    };
    if (customizeLaunch) {
      launch = customizeLaunch(launch);
    }
    this.options = launch;
    this.seenStorePath = path.resolve(
      this.instaConfig.basePath,
      this.instaConfig.seenMessagesFile || ".session/seen-message-ids.json",
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

  public async launch(): Promise<Browser> {
    if (this.browser) return this.browser;
    await fs.mkdir(this.sessionDir, { recursive: true });
    console.log(
      `[${new Date().toISOString()}] [insta-connect] carregando sessao de ${this.sessionDir}`,
    );
    this.browser = await puppeteer.launch(this.options);
    this.page = await this.browser.newPage();
    await this.applyDesktopViewportToPage(this.page);
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
    await this.applyDesktopViewportToPage(this.dmTapPage);
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
    await this.applyDesktopViewportToPage(page);
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

    // O Web do Instagram muda o DOM com frequencia: listas muitas vezes nao usam mais
    // <a href="/direct/t/...">. listConversationsByNetworkIntercept ja cobre API + fetch + DOM fallback.
    const intercepted = await this.listConversationsByNetworkIntercept(8000);
    const out: ConversationSummary[] = [];
    for (const c of intercepted) {
      if (out.length >= limit) break;
      if (!c.threadId) continue;
      out.push({
        title: c.title,
        preview: c.lastMessage,
        href: `https://www.instagram.com/direct/t/${c.threadId}/`,
      });
    }
    return out;
  }

  /** Indica se ja existe input de busca usavel (painel aberto). */
  private async isSearchInputVisibleNow(page: Page): Promise<boolean> {
    return page.evaluate(() => {
      for (const el of document.querySelectorAll("input")) {
        if (!(el instanceof HTMLInputElement)) continue;
        if (el.offsetParent === null) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 28 || r.height < 4) continue;
        const hint = (el.placeholder + (el.getAttribute("aria-label") || "")).toLowerCase();
        if (/(search|pesquisar|buscar|procurar)/.test(hint)) return true;
      }
      for (const el of document.querySelectorAll("input")) {
        if (!(el instanceof HTMLInputElement)) continue;
        if (el.offsetParent === null) continue;
        const r = el.getBoundingClientRect();
        if (r.width >= 100 && r.top < 480) return true;
      }
      return false;
    });
  }

  /**
   * Abre o painel de busca: tenta varias estrategias (o id mount_* muda; nao depender so de um xpath).
   * Ordem: ja visivel -> aria -> SVG -> nav -> tecla / -> xpath fixo.
   */
  private async openSearchPanelBestEffort(page: Page): Promise<void> {
    if (await this.isSearchInputVisibleNow(page)) {
      return;
    }

    const afterClick = async (): Promise<void> => {
      await sleep(800);
    };

    const trySelectors = [
      'a[aria-label="Search" i]',
      'a[aria-label^="Search" i]',
      'a[aria-label="Pesquisar" i]',
      'a[aria-label^="Pesquisar" i]',
      '[role="link"][aria-label*="Search" i]',
      '[role="link"][aria-label*="Pesquisar" i]',
      'div[role="button"][aria-label*="Search" i]',
      'div[role="button"][aria-label*="Pesquisar" i]',
    ];
    for (const sel of trySelectors) {
      const h = await page.$(sel);
      if (h) {
        await h.click().catch(() => null);
        await afterClick();
        if (await this.isSearchInputVisibleNow(page)) return;
      }
    }

    const svgClick = await page.evaluate(() => {
      for (const svg of document.querySelectorAll("svg[aria-label]")) {
        const al = (svg.getAttribute("aria-label") || "").toLowerCase();
        if (!/search|pesquisar|buscar|explore|explorar|pesquisa/.test(al)) continue;
        const el = svg.closest("a, button, [role='button'], [role='link']");
        if (el instanceof HTMLElement) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (svgClick) {
      await afterClick();
      if (await this.isSearchInputVisibleNow(page)) return;
    }

    const navClick = await page.evaluate(() => {
      const roots: Element[] = [];
      for (const sel of ["nav", 'aside[role="presentation"]', "aside"]) {
        const n = document.querySelector(sel);
        if (n) roots.push(n);
      }
      for (const root of roots) {
        for (const el of root.querySelectorAll("a, [role='link'], [role='button']")) {
          if (!(el instanceof HTMLElement)) continue;
          const label = (el.getAttribute("aria-label") || "").trim().toLowerCase();
          if (
            label === "search" ||
            label === "pesquisar" ||
            label.startsWith("search") ||
            label.startsWith("pesquisar") ||
            /^(buscar|procurar)$/.test(label)
          ) {
            el.click();
            return true;
          }
        }
      }
      return false;
    });
    if (navClick) {
      await sleep(1000);
      if (await this.isSearchInputVisibleNow(page)) return;
    }

    try {
      await page.keyboard.press("/");
      await sleep(600);
      if (await this.isSearchInputVisibleNow(page)) return;
    } catch {
      // ignorar
    }

    const xpathLast =
      '//*[@id="mount_0_0_+6"]/div/div/div[2]/div/div/div[1]/div[1]/div[1]/div/div/div/div/div/div[2]/div/div[4]/span/div/a';
    const xpathClick = await page.evaluate((xp: string) => {
      const r = document.evaluate(
        xp,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      );
      const n = r.singleNodeValue;
      if (n instanceof HTMLElement) {
        n.click();
        return true;
      }
      return false;
    }, xpathLast);
    if (xpathClick) {
      await sleep(1500);
    }
  }

  private async waitForSearchInputReady(page: Page, timeoutMs: number): Promise<void> {
    await page.waitForFunction(
      () => {
        for (const el of document.querySelectorAll("input")) {
          if (!(el instanceof HTMLInputElement)) continue;
          if (el.offsetParent === null) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 28 || r.height < 4) continue;
          const hint = (el.placeholder + (el.getAttribute("aria-label") || "")).toLowerCase();
          if (/(search|pesquisar|buscar|procurar)/.test(hint)) return true;
        }
        for (const el of document.querySelectorAll("input")) {
          if (!(el instanceof HTMLInputElement)) continue;
          if (el.offsetParent === null) continue;
          const r = el.getBoundingClientRect();
          if (r.width >= 100 && r.top < 420) return true;
        }
        return false;
      },
      { timeout: timeoutMs, polling: 200 },
    );
  }

  /** Define valor do input e dispara eventos para frameworks (React) perceberem. */
  private async setSearchInputValueAndDispatch(page: Page, text: string): Promise<void> {
    const ok = await page.evaluate((q: string) => {
      const find = (): HTMLInputElement | null => {
        const scoreHint = (i: HTMLInputElement): number => {
          const h = (i.placeholder + (i.getAttribute("aria-label") || "")).toLowerCase();
          if (/(search|pesquisar|buscar|procurar)/.test(h)) return 4;
          return 0;
        };
        let best: HTMLInputElement | null = null;
        let bestScore = -1;
        for (const el of document.querySelectorAll("input")) {
          if (!(el instanceof HTMLInputElement)) continue;
          if (el.offsetParent === null) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 28 || r.height < 4) continue;
          if (window.getComputedStyle(el).visibility === "hidden") continue;
          const sh = scoreHint(el);
          const wideTop = r.width >= 80 && r.top < 400;
          const sc = sh + (wideTop ? 2 : 0) + Math.min(r.width, 500) / 1000;
          if (sc > bestScore) {
            bestScore = sc;
            best = el;
          }
        }
        return best;
      };
      const input = find();
      if (!input) return false;
      input.focus();
      const proto = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value");
      if (proto?.set) {
        proto.set.call(input, q);
      } else {
        input.value = q;
      }
      input.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
      try {
        input.dispatchEvent(
          new InputEvent("input", { bubbles: true, cancelable: true, data: q, inputType: "insertText" }),
        );
      } catch {
        // InputEvent pode nao existir em contextos antigos
      }
      input.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
      return true;
    }, text);
    if (!ok) {
      throw new Error("Campo de busca encontrado no DOM nao pôde ser preenchido.");
    }
  }

  /**
   * Busca de contas no Instagram Web: preenche o campo de busca global (home) e
   * combina (1) JSON de respostas de rede (fbsearch/typeahead/graphql) e (2) links de perfil no DOM.
   * Requer sessao autenticada. A interface do Instagram muda; resultados vazios podem exigir ajuste de seletores.
   */
  public async searchUsers(
    query: string,
    options?: { limit?: number },
  ): Promise<{
    query: string;
    users: InstagramSearchUser[];
    url: string;
    source: "network" | "dom" | "mixed";
  }> {
    const q = String(query || "").trim();
    if (!q) {
      throw new Error("query e obrigatorio.");
    }
    const limit = Math.min(Math.max(1, options?.limit ?? 25), 100);

    if (!this.page) {
      await this.launch();
    }
    const page = this.page;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }

    const fromNetwork = new Map<string, InstagramSearchUser>();
    const fromDom = new Map<string, InstagramSearchUser>();

    const onResponse = async (res: HTTPResponse): Promise<void> => {
      if (fromNetwork.size >= limit) return;
      try {
        const url = res.url();
        if (!/instagram\.com/i.test(url)) return;
        if (!/(fbsearch|typeahead|graphql|search|api\/v1)/i.test(url)) return;
        const ct = res.headers()["content-type"] || "";
        if (!ct.includes("json") && !ct.includes("javascript")) return;
        const text = await res.text().catch(() => "");
        if (!text || (text[0] !== "{" && text[0] !== "[")) return;
        const data = JSON.parse(text) as unknown;
        const before = fromNetwork.size;
        collectUsersFromSearchJson(data, fromNetwork, limit);
        if (fromNetwork.size > before) {
          // sucesso
        }
      } catch {
        // resposta nao-JSON ou truncada
      }
    };

    page.on("response", onResponse);
    try {
      await page.goto("https://www.instagram.com/", { waitUntil: "networkidle2" });
      await this.handlePostLoginPrompts();
      if (page.url().includes("/accounts/login")) {
        throw new Error("Sessao nao autenticada. Faca login antes de buscar.");
      }

      await this.openSearchPanelBestEffort(page);

      try {
        await this.waitForSearchInputReady(page, 45000);
      } catch {
        throw new Error(
          "Campo de busca nao apareceu a tempo. O Instagram pode ter mudado a UI: abra o Instagram no navegador, inspecione o icone PESQUISAR na barra lateral e envie o seletor atualizado, ou tente fazer login de novo na sessao.",
        );
      }

      await this.setSearchInputValueAndDispatch(page, q);
      await sleep(3000);
      await this.handlePostLoginPrompts().catch(() => null);

      const domList = await page.evaluate((max) => {
        const RESERVED = new Set([
          "explore",
          "accounts",
          "account",
          "direct",
          "reels",
          "reel",
          "stories",
          "p",
          "tv",
          "legal",
          "about",
          "support",
          "help",
          "press",
          "api",
          "saved",
          "locations",
          "location",
          "your_activity",
        ]);

        const isProfilePath = (pathname: string): string | null => {
          const p = pathname.replace(/\/$/, "");
          const m = p.match(/^\/([a-z0-9._]+)$/i);
          if (!m) return null;
          const u = m[1].toLowerCase();
          if (RESERVED.has(u)) return null;
          if (u.length < 1 || u.length > 64) return null;
          return m[1];
        };

        const candidates: InstagramSearchUser[] = [];
        const seen = new Set<string>();

        const tryAdd = (a: HTMLAnchorElement): void => {
          if (candidates.length >= max) return;
          const href = a.getAttribute("href") || "";
          if (!href) return;
          let u: URL;
          try {
            u = new URL(href, "https://www.instagram.com");
          } catch {
            return;
          }
          if (!/instagram\.com$/i.test(u.hostname.replace(/^www\./, ""))) return;
          const uname = isProfilePath(u.pathname);
          if (!uname) return;
          const key = uname.toLowerCase();
          if (seen.has(key)) return;
          const r = a.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return;
          seen.add(key);
          const t = (a.textContent || "")
            .replace(/\s+/g, " ")
            .trim();
          const lines = t
            .split("\n")
            .map((x) => x.trim())
            .filter(Boolean);
          const fullName = lines[0] && !lines[0].startsWith("@") && lines[0] !== uname ? lines[0] : lines[1] || "";
          candidates.push({
            username: uname,
            fullName: fullName || "",
            href: `https://www.instagram.com/${uname}/`,
            isVerified: Boolean(a.querySelector('svg[aria-label*="Verif"], [data-testid="verified-badge"]')),
          });
        };

        for (const sel of [
          '[role="listbox"] a[href]',
          '[role="list"] a[href]',
          "div[role='dialog'] a[href]",
          "main a[href]",
        ]) {
          for (const el of document.querySelectorAll<HTMLAnchorElement>(sel)) {
            tryAdd(el);
            if (candidates.length >= max) return candidates;
          }
        }
        for (const a of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
          tryAdd(a);
          if (candidates.length >= max) return candidates;
        }
        return candidates;
      }, limit);

      for (const u of domList) {
        if (!fromDom.has(u.username.toLowerCase())) {
          fromDom.set(u.username.toLowerCase(), u);
        }
      }
    } finally {
      page.off("response", onResponse);
    }

    const merged = new Map<string, InstagramSearchUser>();
    for (const [k, u] of fromNetwork) {
      const dom = fromDom.get(k);
      if (dom) {
        merged.set(k, {
          ...dom,
          fullName: u.fullName || dom.fullName,
          isVerified: u.isVerified ?? dom.isVerified,
        });
      } else {
        merged.set(k, u);
      }
    }
    for (const [k, u] of fromDom) {
      if (!merged.has(k)) {
        merged.set(k, u);
      }
    }

    const users = Array.from(merged.values()).slice(0, limit);
    let source: "network" | "dom" | "mixed" = "dom";
    if (fromNetwork.size > 0 && fromDom.size > 0) {
      source = "mixed";
    } else if (fromNetwork.size > 0) {
      source = "network";
    }

    return {
      query: q,
      users,
      url: page.url(),
      source,
    };
  }

  public async listConversationsByNetworkIntercept(
    /** Tempo maximo (ms) aguardando a primeira carga de threads via rede antes de cair no fetch/DOM. */
    timeoutMs = 8000,
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
      // `networkidle2` e raro com Instagram; demora muito. `load` basta p/ as APIs da inbox.
      await page.goto("https://www.instagram.com/direct/inbox/", {
        waitUntil: "load",
        timeout: 90000,
      });
      await this.handlePostLoginPrompts();

      const t0 = Date.now();
      const maxMs = Math.min(20000, Math.max(2000, timeoutMs));
      /** Se nada chegar na intercept (inbox vazia ou resposta muito atrasada), nao fica 20s em loop. */
      const noDataGiveUpMs = 4500;

      const hasAnyThread = (): boolean => {
        const seen = new Set<string>();
        for (const c of collected) {
          if (c.threadId) seen.add(c.threadId);
        }
        return seen.size > 0;
      };

      for (;;) {
        if (hasAnyThread()) {
          await sleep(400);
          break;
        }
        const elapsed = Date.now() - t0;
        if (elapsed >= maxMs) break;
        if (elapsed >= noDataGiveUpMs) break;
        await sleep(120);
      }
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

  public async listSuggestedPeople(
    options?: { limit?: number },
  ): Promise<{ users: InstagramSuggestedUser[]; url: string }> {
    const limit = Math.min(Math.max(1, options?.limit ?? 24), 100);
    if (!this.page) {
      await this.launch();
    }
    const page = this.page;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }

    await page.goto("https://www.instagram.com/explore/people/", { waitUntil: "networkidle2" });
    await this.handlePostLoginPrompts();
    if (page.url().includes("/accounts/login")) {
      throw new Error("Sessao nao autenticada. Faca login antes de listar sugestoes.");
    }

    await sleep(1200);
    const users = await page.evaluate((max) => {
      const out: InstagramSuggestedUser[] = [];
      const seen = new Set<string>();
      const RESERVED = new Set([
        "explore",
        "accounts",
        "account",
        "direct",
        "reels",
        "reel",
        "stories",
        "p",
        "tv",
        "legal",
        "about",
        "support",
        "help",
        "press",
        "api",
        "saved",
        "locations",
        "location",
        "your_activity",
      ]);

      const normalizeProfilePath = (pathname: string): string | null => {
        const p = pathname.replace(/\/$/, "");
        const m = p.match(/^\/([a-z0-9._]+)$/i);
        if (!m) return null;
        const uname = m[1].toLowerCase();
        if (RESERVED.has(uname)) return null;
        if (uname.length < 1 || uname.length > 64) return null;
        return m[1];
      };

      const collectFromCard = (card: Element): void => {
        if (out.length >= max) return;
        const link = card.querySelector<HTMLAnchorElement>('a[href^="/"][href$="/"]');
        if (!link) return;
        const rawHref = link.getAttribute("href") || "";
        let url: URL;
        try {
          url = new URL(rawHref, "https://www.instagram.com");
        } catch {
          return;
        }
        const username = normalizeProfilePath(url.pathname);
        if (!username) return;
        const key = username.toLowerCase();
        if (seen.has(key)) return;

        const textNodes = Array.from(card.querySelectorAll("span, div"))
          .map((el) => (el.textContent || "").replace(/\s+/g, " ").trim())
          .filter(Boolean);
        const buttonUserId =
          card.querySelector<HTMLElement>("[data-user-id]")?.getAttribute("data-user-id") ||
          card.querySelector<HTMLElement>("[data-testid][data-id]")?.getAttribute("data-id") ||
          undefined;
        let fullName = "";
        let reasonText = "";
        for (const t of textNodes) {
          const normalized = t.toLowerCase();
          if (!fullName && normalized !== key && !/^(follow|seguir)$/i.test(normalized)) {
            fullName = t;
            continue;
          }
          if (!reasonText && /(suggested for you|sugest|para voce|for you)/i.test(normalized)) {
            reasonText = t;
          }
        }
        seen.add(key);
        out.push({
          username,
          fullName,
          href: `https://www.instagram.com/${username}/`,
          userId: buttonUserId || undefined,
          reason: reasonText || undefined,
          isVerified: Boolean(card.querySelector('svg[aria-label*="Verif"], [data-testid="verified-badge"]')),
        });
      };

      // 1) Preferencial: cards que tem botao Follow/Seguir (layout como screenshot)
      const followButtons = Array.from(
        document.querySelectorAll("button, div[role='button']"),
      ).filter((el) => {
        const t = (el.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
        return t === "follow" || t === "seguir";
      });
      for (const btn of followButtons) {
        if (out.length >= max) break;
        const card =
          btn.closest("article, li, section") ||
          btn.closest("div")?.parentElement ||
          btn.closest("div");
        if (!card) continue;
        collectFromCard(card);
      }

      // 2) Fallback: scan geral do main
      const cards = Array.from(document.querySelectorAll("main article, main section, main li, main div"));
      for (const card of cards) {
        if (out.length >= max) break;
        collectFromCard(card);
      }

      if (out.length < max) {
        for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href^="/"][href$="/"]')) {
          if (out.length >= max) break;
          const href = anchor.getAttribute("href") || "";
          let u: URL;
          try {
            u = new URL(href, "https://www.instagram.com");
          } catch {
            continue;
          }
          const username = normalizeProfilePath(u.pathname);
          if (!username) continue;
          const key = username.toLowerCase();
          if (seen.has(key)) continue;
          const block = anchor.closest("article, li, section, div") || anchor;
          const text = (block.textContent || "").replace(/\s+/g, " ").trim();
          seen.add(key);
          out.push({
            username,
            fullName: text || "",
            href: `https://www.instagram.com/${username}/`,
            userId: undefined,
            isVerified: Boolean(block.querySelector('svg[aria-label*="Verif"], [data-testid="verified-badge"]')),
          });
        }
      }

      return out.slice(0, max);
    }, limit);

    return { users, url: page.url() };
  }

  public async getSuggestedUsersDataByTargetId(
    targetId: string,
    options?: { limit?: number; module?: "profile" | "home" },
  ): Promise<{ targetId: string; users: InstagramSuggestedUser[]; url: string }> {
    const resolvedTargetId = String(targetId || "").trim();
    if (!/^\d+$/.test(resolvedTargetId)) {
      throw new Error("targetId invalido. Informe um id numerico.");
    }
    const limit = Math.min(Math.max(1, options?.limit ?? 50), 200);
    const module = options?.module ?? "profile";
    const page = await this.ensureExplorePeopleReady();

    const result = await page.evaluate(
      async (payload: { targetId: string; limit: number; module: string }) => {
        const variables = {
          module: payload.module,
          target_id: payload.targetId,
        };
        const body = new URLSearchParams({
          fb_api_caller_class: "RelayModern",
          fb_api_req_friendly_name: "PolarisProfileSuggestedUsersWithPreloadableQuery",
          server_timestamps: "true",
          variables: JSON.stringify(variables),
          doc_id: "25814188068245954",
        });

        const response = await fetch("/graphql/query", {
          method: "POST",
          credentials: "include",
          headers: {
            accept: "*/*",
            "content-type": "application/x-www-form-urlencoded",
            "x-ig-app-id": "936619743392459",
            "x-fb-friendly-name": "PolarisProfileSuggestedUsersWithPreloadableQuery",
            "x-root-field-name": "xdt_api__v1__discover__chaining",
          },
          body: body.toString(),
        });

        let json: any = null;
        try {
          json = await response.json();
        } catch {
          json = null;
        }
        if (!response.ok || !json) {
          return {
            ok: false,
            error: `Falha ao consultar chaining (${response.status})`,
            users: [],
          };
        }
        const users = Array.isArray(json?.data?.xdt_api__v1__discover__chaining?.users)
          ? json.data.xdt_api__v1__discover__chaining.users
          : [];
        const mapped = users.slice(0, payload.limit).map((u: any) => ({
          username: String(u?.username || ""),
          fullName: String(u?.full_name || ""),
          href: `https://www.instagram.com/${String(u?.username || "").trim()}/`,
          userId: String(u?.id || u?.pk || ""),
          reason: String(u?.social_context || ""),
          isVerified: Boolean(u?.is_verified),
          isPrivate: Boolean(u?.is_private),
          profilePicUrl: String(u?.profile_pic_url || ""),
        }));
        return {
          ok: true,
          users: mapped,
        };
      },
      { targetId: resolvedTargetId, limit, module },
    );

    if (!result.ok) {
      throw new Error(result.error || "Falha ao obter usuarios sugeridos via chaining.");
    }
    return {
      targetId: resolvedTargetId,
      users: result.users,
      url: page.url(),
    };
  }

  private async getViewerUserIdFromCookie(): Promise<string | null> {
    if (!this.page) {
      await this.launch();
    }
    const page = this.page;
    if (!page) {
      return null;
    }
    const viewerId = await page.evaluate(() => {
      const m = document.cookie.match(/(?:^|;\s*)ds_user_id=([^;]+)/);
      return m?.[1] ? decodeURIComponent(m[1]) : null;
    });
    const id = String(viewerId || "").trim();
    return /^\d+$/.test(id) ? id : null;
  }

  private normalizeAutoFollowPrivacyFilter(filter?: string): AutoFollowPrivacyFilter {
    const value = String(filter || "")
      .trim()
      .toLowerCase();
    if (value === "public") return "public";
    if (value === "private") return "private";
    return "any";
  }

  private shouldIncludeByPrivacy(
    user: Pick<InstagramSuggestedUser, "isPrivate">,
    filter: AutoFollowPrivacyFilter,
  ): boolean {
    if (filter === "any") return true;
    if (typeof user.isPrivate !== "boolean") return false;
    return filter === "private" ? user.isPrivate : !user.isPrivate;
  }

  private async resolveUserProfileByUsername(
    username: string,
  ): Promise<{ userId: string; isPrivate?: boolean }> {
    const uname = String(username || "").trim().replace(/^@+/, "");
    if (!uname) {
      throw new Error("username e obrigatorio.");
    }
    if (!this.page) {
      await this.launch();
    }
    const page = this.page;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }

    const result = await page.evaluate(async (u) => {
      const endpoint = `/api/v1/users/web_profile_info/?username=${encodeURIComponent(u)}`;
      try {
        const res = await fetch(endpoint, {
          method: "GET",
          credentials: "include",
          headers: {
            accept: "*/*",
            "x-ig-app-id": "936619743392459",
            "x-requested-with": "XMLHttpRequest",
          },
        });
        if (!res.ok) {
          return { ok: false, error: `http_${res.status}` };
        }
        const payload = (await res.json()) as any;
        const user = payload?.data?.user;
        const userId = String(user?.id || "").trim();
        const isPrivate = typeof user?.is_private === "boolean" ? Boolean(user.is_private) : undefined;
        if (!userId) {
          return { ok: false, error: "user_id_not_found" };
        }
        return { ok: true, userId, isPrivate };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }, uname);

    if (!result.ok || !result.userId) {
      throw new Error(`Falha ao resolver userId de @${uname}: ${result.error || "erro desconhecido"}`);
    }
    return {
      userId: result.userId,
      isPrivate: typeof result.isPrivate === "boolean" ? result.isPrivate : undefined,
    };
  }

  public async resolveUserIdByUsername(username: string): Promise<string> {
    const profile = await this.resolveUserProfileByUsername(username);
    return profile.userId;
  }

  private async ensureExplorePeopleReady(): Promise<Page> {
    if (!this.page) {
      await this.launch();
    }
    const page = this.page;
    if (!page) {
      throw new Error("Pagina do navegador nao inicializada.");
    }
    const onExplorePeople = page.url().includes("/explore/people/");
    if (!onExplorePeople) {
      await page.goto("https://www.instagram.com/explore/people/", { waitUntil: "networkidle2" });
      await this.handlePostLoginPrompts();
    }
    if (page.url().includes("/accounts/login")) {
      throw new Error("Sessao nao autenticada. Faca login antes de seguir.");
    }
    return page;
  }

  private async executeFollowByIdOnCurrentPage(userId: string): Promise<FollowUserResult> {
    const targetUserId = String(userId || "").trim();
    if (!/^\d+$/.test(targetUserId)) {
      throw new Error("userId invalido. Informe o id numerico do Instagram.");
    }
    const page = await this.ensureExplorePeopleReady();

    const response = await page.evaluate(async (id) => {
      const csrf = (() => {
        const fromCookie = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)?.[1];
        return fromCookie ? decodeURIComponent(fromCookie) : "";
      })();

      const body = new URLSearchParams({
        container_module: "unknown",
        include_follow_friction_check: "true",
        nav_chain: "PolarisExplorePeopleRoot:discoverPeoplePage:1:via_cold_start",
        user_id: id,
      });

      const res = await fetch(`/api/v1/friendships/create/${id}/`, {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "*/*",
          "content-type": "application/x-www-form-urlencoded",
          "x-csrftoken": csrf,
          "x-ig-app-id": "936619743392459",
          "x-requested-with": "XMLHttpRequest",
        },
        body: body.toString(),
      });
      let payload: unknown = null;
      try {
        payload = await res.json();
      } catch {
        payload = null;
      }
      return {
        ok: res.ok,
        statusCode: res.status,
        payload,
      };
    }, targetUserId);

    const payload = (response.payload || {}) as {
      friendship_status?: Record<string, unknown>;
      previous_following?: boolean;
      status?: string;
      error?: string | null;
      message?: string;
    };

    if (!response.ok) {
      throw new Error(payload.message || payload.error || `Falha ao seguir usuario (${response.statusCode})`);
    }

    return {
      userId: targetUserId,
      previousFollowing: payload.previous_following,
      friendshipStatus: {
        following: Boolean(payload.friendship_status?.following),
        is_bestie: Boolean(payload.friendship_status?.is_bestie),
        is_feed_favorite: Boolean(payload.friendship_status?.is_feed_favorite),
        is_private: Boolean(payload.friendship_status?.is_private),
        is_restricted: Boolean(payload.friendship_status?.is_restricted),
        incoming_request: Boolean(payload.friendship_status?.incoming_request),
        outgoing_request: Boolean(payload.friendship_status?.outgoing_request),
        followed_by: Boolean(payload.friendship_status?.followed_by),
        muting: Boolean(payload.friendship_status?.muting),
        blocking: Boolean(payload.friendship_status?.blocking),
        is_eligible_to_subscribe: Boolean(payload.friendship_status?.is_eligible_to_subscribe),
        subscribed: Boolean(payload.friendship_status?.subscribed),
      },
      status: String(payload.status || "ok"),
      error: payload.error ?? null,
    };
  }

  public async followUserById(userId: string): Promise<FollowUserResult> {
    return this.executeFollowByIdOnCurrentPage(userId);
  }

  public async autoFollowSuggestedUsers(
    quantity: number,
    options?: { privacyFilter?: AutoFollowPrivacyFilter | string },
  ): Promise<AutoFollowSuggestedResult> {
    const requested = Math.min(Math.max(1, Math.floor(Number(quantity) || 0)), 100);
    const privacyFilter = this.normalizeAutoFollowPrivacyFilter(options?.privacyFilter);
    await this.ensureExplorePeopleReady();
    const results: AutoFollowSuggestedResult["results"] = [];
    let followed = 0;
    let attempted = 0;
    const processedUsernames = new Set<string>();
    const viewerId = await this.getViewerUserIdFromCookie().catch(() => null);
    const maxCandidates = Math.min(300, Math.max(requested * 20, 40));
    let currentLimit = Math.min(Math.max(requested * 2, 10), 100);
    const maxRounds = 5;
    let roundsWithoutNewCandidates = 0;

    const fetchCandidates = async (limit: number): Promise<InstagramSuggestedUser[]> => {
      try {
        if (viewerId) {
          const chaining = await this.getSuggestedUsersDataByTargetId(viewerId, {
            limit,
            module: "profile",
          });
          if (chaining.users.length > 0) {
            return chaining.users;
          }
        }
      } catch {
        // fallback DOM abaixo
      }
      try {
        const suggested = await this.listSuggestedPeople({ limit });
        return suggested.users;
      } catch {
        return [];
      }
    };

    for (let round = 0; round < maxRounds; round += 1) {
      if (followed >= requested) break;
      if (processedUsernames.size >= maxCandidates) break;

      const suggestedUsers = await fetchCandidates(currentLimit);
      if (suggestedUsers.length === 0) {
        roundsWithoutNewCandidates += 1;
        if (roundsWithoutNewCandidates >= 2) break;
        currentLimit = Math.min(currentLimit + 50, 200);
        continue;
      }

      let newCandidatesThisRound = 0;
      for (const item of suggestedUsers) {
        if (followed >= requested) break;
        if (processedUsernames.size >= maxCandidates) break;

        const username = String(item.username || "").trim();
        if (!username) continue;
        const usernameKey = username.toLowerCase();
        if (processedUsernames.has(usernameKey)) continue;
        processedUsernames.add(usernameKey);
        newCandidatesThisRound += 1;

        try {
          let resolvedPrivacy = typeof item.isPrivate === "boolean" ? item.isPrivate : undefined;
          let userId = String(item.userId || "").trim();
          if (!userId || (privacyFilter !== "any" && typeof resolvedPrivacy !== "boolean")) {
            const profile = await this.resolveUserProfileByUsername(username);
            userId = userId || profile.userId;
            if (typeof resolvedPrivacy !== "boolean") {
              resolvedPrivacy = profile.isPrivate;
            }
          }
          if (!this.shouldIncludeByPrivacy({ isPrivate: resolvedPrivacy }, privacyFilter)) {
            continue;
          }
          attempted += 1;
          const followResult = await this.executeFollowByIdOnCurrentPage(userId);
          const isFollowing = Boolean(followResult.friendshipStatus.following);
          if (isFollowing) followed += 1;
          results.push({
            username,
            userId,
            isPrivate: resolvedPrivacy,
            success: isFollowing,
            following: isFollowing,
            ...(isFollowing ? {} : { error: followResult.error || "nao foi possivel confirmar follow" }),
          });
        } catch (error) {
          results.push({
            username,
            isPrivate: typeof item.isPrivate === "boolean" ? item.isPrivate : undefined,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (newCandidatesThisRound === 0) {
        roundsWithoutNewCandidates += 1;
      } else {
        roundsWithoutNewCandidates = 0;
      }
      if (roundsWithoutNewCandidates >= 2) {
        break;
      }
      if (followed < requested) {
        currentLimit = Math.min(currentLimit + 50, 200);
      }
    }

    return {
      requested,
      attempted,
      followed,
      privacyFilter,
      results,
    };
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
      if (!isMessageTransportUrl(url)) return;
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
      if (!isMessageTransportUrl(url)) return;

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

      const messages = parseMessagesFromPayload(payload);
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
      const decoded = decodeWebsocketPayload(payloadData, opcode);
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
        if (!isMessageTransportUrl(url)) {
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
        const events = parseMessagesFromPayload(json);
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
        const events = parseMessagesFromPayload(payload);
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

  public isDmTapActive(): boolean {
    return this.dmTapActive;
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

/**
 * Cria o cliente com `InstaConnectConfig` e, opcionalmente, ajusta o `LaunchOptions` do Puppeteer
 * (equivalente a `new InstaConnect({ insta }, customizeLaunch)`).
 */
export function createInstaConnect(
  insta: InstaConnectConfig,
  customizeLaunch?: InstaConnectLaunchCustomize,
): InstaConnect {
  return new InstaConnect({ insta }, customizeLaunch);
}

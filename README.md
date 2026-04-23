# insta-connect-delsuc

Biblioteca TypeScript/Node.js para automação do Instagram Web via Puppeteer, com servidor Socket.IO para controle em tempo real e um interceptador de DMs (`dmTap`) que decodifica mensagens diretamente do WebSocket MQTT do Instagram.

---

## Sumário

- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Scripts NPM](#scripts-npm)
- [Configuração por variáveis de ambiente](#configuração-por-variáveis-de-ambiente)
- [Uso rápido como biblioteca](#uso-rápido-como-biblioteca)
- [Servidor Socket.IO em tempo real](#servidor-socketio-em-tempo-real)
  - [Comandos aceitos](#comandos-aceitos)
  - [Eventos emitidos](#eventos-emitidos)
- [Cliente CLI interativo](#cliente-cli-interativo)
- [DM Tap — interceptação de mensagens em tempo real](#dm-tap--interceptação-de-mensagens-em-tempo-real)
  - [Como funciona](#como-funciona)
  - [Exemplo via Socket.IO](#exemplo-via-socketio)
  - [Exemplo programático (sem socket)](#exemplo-programático-sem-socket)
  - [Userscript standalone (Tampermonkey)](#userscript-standalone-tampermonkey)
  - [Estrutura de `DmTapEvent`](#estrutura-de-dmtapevent)
  - [Debug e telemetria](#debug-e-telemetria)
- [Envio de mensagens](#envio-de-mensagens)
- [Persistência de sessão](#persistência-de-sessão)
- [Estrutura de pastas](#estrutura-de-pastas)
- [Limitações conhecidas](#limitações-conhecidas)

---

## Requisitos

- Node.js 18+ (recomendado 20+)
- Windows, macOS ou Linux
- Chromium é baixado automaticamente pelo `puppeteer` na primeira `npm install`

## Instalação

```bash
cd lib-insta-connect
npm install
```

## Scripts NPM

| Script | Descrição |
| --- | --- |
| `npm run dev` | Sobe o servidor Socket.IO em modo dev: nodemon + `ts-node` conforme `nodemon.json` (por padrão `src/socket-server.ts`; mesma intenção de `socket:dev`) |
| `npm run build` | Compila TypeScript para `dist/` |
| `npm start` | Roda `dist/example.js` (exemplo compilado) |
| `npm run socket:dev` | Sobe o servidor Socket.IO em modo dev (TS + nodemon) — porta em `PORT` (default `4010`) |
| `npm run socket` | Roda o servidor Socket.IO compilado |
| `npm run socket:client:dev` | CLI interativo (cliente Socket.IO) em TS |
| `npm run socket:client` | CLI interativo compilado |
| `npm run build:userscript` | Gera `src/browser/dm-tap.user.js` a partir de `dm-tap.source.ts` (Tampermonkey) |

Para experimentar a classe `InstaConnect` sem o socket, use o exemplo: `npx ts-node src/example.ts` (ou `npm start` após `npm run build`).

## Configuração por variáveis de ambiente

| Variável | Default | Função |
| --- | --- | --- |
| `PORT` | `4010` | Porta HTTP do `socket-server` (Socket.IO + proxy `/voice` e `/image`). |
| `PUBLIC_BASE_URL` | `http://localhost:<PORT>` | Base pública usada nas URLs de mídia retornadas ao cliente; em deploy atrás de domínio, aponte para a URL acessível de fora. |
| `SESSION_DIR` | `.session/chrome-profile` | Diretório do perfil do Chromium (cookies, localStorage). Alterar permite múltiplas contas. |
| `SEEN_MESSAGES_FILE` | `.session/seen-message-ids.json` | Cache LRU de `messageId`s já emitidos pelo `dmTap` (deduplicação entre reinicializações). |
| `SOCKET_URL` | `http://localhost:4010` | URL usada pelo cliente CLI e pelos scripts de exemplo para conectar no socket-server (alinhada a `PORT` se você mudar a porta). |
| `INSTA_HEADLESS` | `false` | Define se o Chromium roda em headless (`true`) ou visível (`false`). |
| `INSTA_VIEWPORT_WIDTH` / `INSTA_VIEWPORT_HEIGHT` | efetivo **1024**×**600** se omitidos (com clamp) | Viewport “desktop” do Chromium. Largura nunca fica abaixo de 1024 nem altura abaixo de 600, para evitar layout mobile. |
| `DM_TAP_DEBUG` | `0` | Quando `1`, habilita o canal `dmTap:debug` no live client de exemplo. |

Exemplo:

```bash
SESSION_DIR=.session/conta-secundaria npm run socket:dev
```

```bash
INSTA_HEADLESS=true npm run socket:dev
```

---

## Uso rápido como biblioteca

```ts
import { InstaConnect } from "insta-connect-delsuc"; // re-exporta `./src/insta-connect/InstaConnect` e tipos em `./src/types`

const client = new InstaConnect({ headless: false });

await client.openLoginPage();
await client.login("seu_usuario", "sua_senha");

const conversas = await client.listConversations(20);
console.log(conversas);

await client.sendMessageToConversation("Iago Galdino", "Oi!");

await client.close();
```

Principais métodos públicos da classe `InstaConnect`:

- `launch()` — sobe o Chromium com o perfil persistido
- `openLoginPage()` — navega para a tela de login
- `login(username, password)` — faz login e persiste cookies no profile
- `close()` — encerra o browser
- `listConversations(limit)` — scraping DOM da inbox
- `searchUsers(query, { limit? })` — busca de contas combinando respostas de rede (JSON) e links no DOM; requer sessão autenticada
- `listConversationsByNetworkIntercept(timeoutMs)` — extrai inbox via interceptação de rede (mais robusto que DOM)
- `sendMessageToConversation(title, text)` — envia uma DM por simulação de teclado (DOM)
- `openConversationByTitle(title, { dedicatedTab? })` — abre conversa por título; base para o comando socket `openConversation` e o fluxo `mto:` no CLI
- `listMessagesByThreadId(threadId, limit)` — lê mensagens de uma thread
- `startMessageListener(onEvent)` / `stopMessageListener()` — escuta toda mensagem nova (via interceptação de rede)
- `startThreadListener(threadId, onEvent)` / `stopThreadListener()` — escuta novas mensagens de uma thread específica
- **`startDmTap(onMessage, onDebug?)` / `stopDmTap()` / `isDmTapActive()` / `getDmTapStats()`** — interceptação direta do WebSocket MQTT do IG (ver [DM Tap](#dm-tap--interceptação-de-mensagens-em-tempo-real))
- `getInstagramMediaAuthHeaders()` — cabeçalhos de autenticação para o proxy de mídia (cookies/sessão)
- `debugInboxTraffic(timeoutMs)` / `debugMessageTransport(timeoutMs)` / `debugInstagramSocket(timeoutMs)` / `probeInstagramRealtime(timeoutMs)` — helpers de diagnóstico de tráfego

---

## Servidor Socket.IO em tempo real

Suba o servidor:

```bash
npm run socket:dev
```

Endpoint: `http://localhost:<PORT>` com Socket.IO (ex.: `ws://localhost:4010` se `PORT=4010`, transporte típico `websocket`).

Assim que um cliente conecta, recebe o evento `status`:

```json
{ "message": "connected", "socketId": "abc123" }
```

### Comandos aceitos

| Comando | Payload | Descrição |
| --- | --- | --- |
| `openLogin` | — | Abre a página de login (reutiliza sessão se já logado) |
| `login` | `{ username, password }` | Faz login com credenciais |
| `closeBrowser` | — | Encerra o Chromium |
| `listConversations` | `{ limit? }` | Lista conversas da inbox via DOM |
| `searchUsers` | `{ query, limit? }` | Busca de usuários; `query` é obrigatório |
| `listConversationsIntercept` | `{ timeoutMs? }` | Lista conversas via interceptação de rede |
| `debugInboxTraffic` | `{ timeoutMs? }` | Snapshot de requests/respostas da inbox |
| `debugMessageTransport` | `{ timeoutMs?, withMessagesOnly? }` | Snapshot de tráfego relacionado a mensagens |
| `debugInstagramSocket` | `{ timeoutMs?, directOnly? }` | Captura frames dos WebSockets do IG |
| `probeInstagramRealtime` | `{ timeoutMs? }` | Perfil agregado dos canais realtime do IG |
| `sendMessage` | `{ conversationTitle, text }` | Envia DM via simulação de teclado |
| `listMessages` | `{ threadId, limit? }` | Lê mensagens de uma thread |
| `startMessageListener` | — | Começa a emitir `newMessage` para mensagens em qualquer thread |
| `stopMessageListener` | — | Para o listener global |
| `startThreadListener` | `{ threadId }` | Começa a emitir `newMessage` apenas para uma thread |
| `stopThreadListener` | — | Para o listener de thread |
| **`startDmTap`** | `{ debug? }` | Liga o interceptador de DMs via MQTT (emite `dmTap:newMessage`) |
| **`stopDmTap`** | — | Desliga o interceptador |
| **`getDmTapStats`** | — | Retorna telemetria do parser (frames vistos, payloads JSON, Thrift, erros) |
| **`openConversation`** | `{ conversationTitle, dedicatedTab?, autoStartDmTap?, preloadMessages? }` | Abre conversa por título; `preloadMessages` tenta anexar últimas mensagens da thread; `autoStartDmTap` liga o tap se ainda inativo. No CLI, o prefixo `mto:` aplica aba dedicada e dmTap automático. |
| **`resolveVoiceMessage`** | `{ senderUsername? \| voiceSimpleId? \| messageId? }` | Último áudio do usuário ou link por id simples (proxy `GET /voice/:id`) |
| **`resolveImageMessage`** | `{ senderUsername? \| imageSimpleId? \| messageId? }` | Última imagem do usuário ou link por id simples (proxy `GET /image/:id`) |

### Eventos emitidos

| Evento | Quando |
| --- | --- |
| `status` | Na conexão inicial |
| `openLogin:result` | Resposta de `openLogin` |
| `login:result` | Resposta de `login` |
| `closeBrowser:result` | Resposta de `closeBrowser` |
| `listConversations:result` | Resposta de `listConversations` |
| `searchUsers:result` | Resposta de `searchUsers` |
| `listConversationsIntercept:result` | Resposta de `listConversationsIntercept` |
| `debugInboxTraffic:result` | Resposta de `debugInboxTraffic` |
| `debugMessageTransport:result` | Resposta de `debugMessageTransport` |
| `debugInstagramSocket:result` | Resposta de `debugInstagramSocket` |
| `probeInstagramRealtime:result` | Resposta de `probeInstagramRealtime` |
| `sendMessage:result` | Resposta de `sendMessage` |
| `listMessages:result` | Resposta de `listMessages` |
| `startMessageListener:result` / `stopMessageListener:result` | Ack de ligar/desligar listener global |
| `startThreadListener:result` / `stopThreadListener:result` | Ack de ligar/desligar listener de thread |
| `startDmTap:result` / `stopDmTap:result` | Ack de ligar/desligar dmTap |
| `getDmTapStats:result` | Resposta de `getDmTapStats` |
| `openConversation:result` | Resposta de `openConversation` (inclui URL da thread e, com `preloadMessages`, mensagens carregadas ou erro) |
| `newMessage` | Mensagem nova capturada por `startMessageListener` / `startThreadListener` |
| **`dmTap:newMessage`** | Mensagem decodificada pelo dmTap (MQTT/JSON/Thrift) |
| **`dmTap:debug`** | Telemetria opcional do parser (apenas quando iniciado com `{ debug: true }`) |
| **`resolveVoiceMessage:result`** / **`resolveImageMessage:result`** | Resposta com URL de proxy para ouvir/ver mídia |

---

## Cliente CLI interativo

Em um segundo terminal:

```bash
npm run socket:client:dev
```

Comandos disponíveis (espelhados em `src/client/help.ts`):

```
openLogin
login <username> <password>
listConversations [limit]
searchUsers <query> [limit]
listConversationsIntercept [timeoutMs]
debugInboxTraffic [timeoutMs]
debugMessageTransport [timeoutMs]
debugMessageTransportOnly [timeoutMs]
debugInstagramSocket [timeoutMs]
debugInstagramSocketDirect [timeoutMs]
probeInstagramRealtime [timeoutMs]
openConversation <conversationTitle>
sendMessage <conversationTitle> | <text>
listMessages <threadId> [limit]
startMessageListener
stopMessageListener
startThreadListener <threadId>
stopThreadListener
startDmTap [debug]
stopDmTap
getDmTapStats
resolveVoiceMessage <senderUsername> | <id numerico do audio>
resolveImageMessage <senderUsername> | <id numerico da foto>
mto:<senderUsername>
closeBrowser
help
exit
```

Com o prefixo `mto:` (ex.: `mto:contaamiga`), o CLI abre a conversa em aba dedicada, pode iniciar o `dmTap` e entra no modo de envio (mensagem livre + atalhos `/audio`, `/foto`, etc. — ver `printMessageModeHelp` no mesmo ficheiro).

Para testes mínimos só de socket/dmTap, ainda podes usar `scripts/live-dm-tap-client.ts` ou outro cliente Socket.IO.

---

## DM Tap — interceptação de mensagens em tempo real

O `dmTap` é o recurso mais poderoso da lib: ele intercepta **diretamente** o WebSocket MQTT usado pelo Instagram Web (`wss-edge.instagram.com`, `edge-chat.instagram.com`), decodifica os pacotes `PUBLISH` do MQTT e extrai de forma heurística o texto da mensagem, remetente e thread. É **muito mais rápido** e **mais confiável** que polling de DOM ou interceptação de HTTP.

### Como funciona

1. Um IIFE (`src/browser/dm-tap.source.ts`) é injetado via `page.evaluateOnNewDocument`, **antes** do Instagram carregar.
2. Ele faz monkey-patch de `window.WebSocket` para interceptar `onmessage`.
3. Para cada frame binário (`ArrayBuffer` / `Blob`):
   - Filtra pelos URLs de chat do Meta.
   - Decodifica o wrapping MQTT (control byte `0x30` = PUBLISH, variable length, tópico, payload).
   - Faz `DecompressionStream("deflate")` caso o payload tenha magic bytes de zlib.
   - Tenta parse como **JSON** (formato atual do IG Web) — extrai `text_body`, `igd_snippet`, `sender_fbid`, `thread_fbid` etc. com heurísticas.
   - Fallback estrutural para **Thrift Compact** sem schema (útil para clientes antigos).
4. Deduplica `messageId` por LRU cache (evita emitir a mesma mensagem duas vezes).
5. Emite cada mensagem normalizada como `DmTapEvent` via `window.__igDmTapEmit(...)` — ponte criada por `page.exposeFunction`.

A classe `InstaConnect` recebe esses eventos em Node e repassa via callback ou Socket.IO (`dmTap:newMessage`).

### Exemplo via Socket.IO

```ts
import { io } from "socket.io-client";

const socket = io("http://localhost:4010", { transports: ["websocket"] });

socket.on("connect", () => {
  socket.emit("openLogin");
});

socket.on("openLogin:result", () => {
  socket.emit("startDmTap", { debug: false });
});

socket.on("startDmTap:result", (r) => console.log("dmTap started:", r));

socket.on("dmTap:newMessage", (evt) => {
  console.log(
    `[Grampo DM] Remetente: ${evt.senderName || evt.senderId} | Mensagem: "${evt.text}"`,
  );
});

socket.on("dmTap:debug", (msg) => {
  console.log("[dmTap:debug]", msg);
});
```

Há um cliente pronto para teste em `scripts/live-dm-tap-client.ts`:

```bash
# Em um terminal
npm run socket:dev

# Em outro terminal
npx ts-node --transpile-only scripts/live-dm-tap-client.ts
# opcionalmente: WAIT_MS=120000 DM_TAP_DEBUG=1 npx ts-node --transpile-only scripts/live-dm-tap-client.ts
```

### Exemplo programático (sem socket)

```ts
import { InstaConnect } from "./src/index";

const client = new InstaConnect({ headless: false });
await client.openLoginPage();

await client.startDmTap(
  (evt) => {
    console.log(`[DM] ${evt.senderName ?? evt.senderId}: ${evt.text}`);
  },
  // opcional: callback de debug (deixe undefined em produção para evitar flood)
  undefined,
);

// ... dispare `client.stopDmTap()` quando quiser parar
```

### Userscript standalone (Tampermonkey)

O mesmo IIFE roda sem Puppeteer. Para gerar o `.user.js`:

```bash
npm run build:userscript
# Saída: src/browser/dm-tap.user.js
```

Instale o arquivo no Tampermonkey/Violentmonkey e navegue para `https://www.instagram.com/direct/inbox/`. Os eventos serão impressos no `console.log` do DevTools:

```
[Grampo DM] Remetente: 12345 | Mensagem: 'oi tudo bem?'
```

Para ligar logs detalhados do parser, adicione `?dm-tap-debug=1` na URL ou execute no console:

```js
window.__IG_DM_TAP_DEBUG__ = true;
```

### Estrutura de `DmTapEvent`

```ts
interface DmTapEvent {
  url: string;                       // URL do WebSocket de onde veio
  topic: string;                     // Tópico MQTT (ex. "/ig_send_message_response")
  senderId: string | null;           // user_id (i64)
  senderName?: string | null;        // full_name (quando presente no payload)
  senderUsername?: string | null;    // @handle (quando presente)
  threadId: string | null;           // thread_fbid / thread_id / thread_key
  text: string;                      // conteúdo da mensagem
  messageId?: string | null;         // item_id (usado para dedup)
  seqId?: string | null;             // sequence id (quando disponível)
  typename?: string | null;          // tipo do payload (ex. "XDTMessageText")
  voiceMediaUrl?: string | null;     // URL de áudio no CDN (heurístico)
  imageMediaUrl?: string | null;     // URL de imagem no CDN (heurístico)
  // Campos adicionados pelo socket-server (proxy + ids simples):
  voiceSimpleId?: number | null;
  playbackUrl?: string | null;
  imageSimpleId?: number | null;
  imageViewUrl?: string | null;
  timestamp: string;                 // ISO-8601 do momento de parse
  source: "thrift" | "json";         // decoder que extraiu o dado
}
```

O servidor HTTP do `socket-server` expõe proxies autenticados (cookies do Chromium): `GET /voice/<id>` (áudio) e `GET /image/<id>` (imagem), com `<id>` numérico. Em deploy remoto, defina `PUBLIC_BASE_URL` para que os links retornados ao cliente apontem para o host público.

### Debug e telemetria

- `getDmTapStats()` retorna um objeto com contadores globais: total de frames, `publishFrames`, `jsonOk`, `thriftOk`, `parseErrors`, `emitted`, `dedupHits`, etc.
- `dmTap:debug` (opt-in) emite eventos ricos para cada frame (cabeçalho MQTT, topic, tamanho do payload, razão de descarte). **Não ligue em produção** — pode gerar centenas de eventos por minuto.
- O LRU de `messageId` é persistido em `SEEN_MESSAGES_FILE` para sobreviver a restart do processo.

---

## Envio de mensagens

O método oficial para enviar DMs é **`sendMessageToConversation(title, text)`** (ou o evento socket `sendMessage`). Ele:

1. Navega até `/direct/inbox/`
2. Clica na conversa pelo título visível
3. Foca a caixa de texto e simula digitação + `Enter`

Latência típica: **15–25 s** (dominada pelo tempo de navegação/renderização). É o caminho **mais confiável e resistente a mudanças** da interface, porque reusa os mesmos componentes que o usuário humano.

> **Nota técnica**: O Instagram Web migrou o envio programático para uma **GraphQL mutation** (`IGDirectTextSendMutation` em `POST /api/graphql`) que depende de tokens dinâmicos (`fb_dtsg`, `lsd`, `__spin_t`, `doc_id`, …) renovados a cada build. Implementar envio via `fetch` direto é possível mas frágil: qualquer deploy do IG pode quebrar o `doc_id`. Por isso a lib mantém apenas o envio via DOM.

---

## Persistência de sessão

- Cookies, localStorage e cache do Chromium são salvos em `SESSION_DIR` (default `.session/chrome-profile`).
- Isso elimina a necessidade de logar novamente a cada execução.
- Para múltiplas contas, use `SESSION_DIR` distinto por instância.
- Para limpar completamente a sessão, delete o diretório:

  ```bash
  # Windows (PowerShell)
  Remove-Item -Recurse -Force .session\chrome-profile

  # macOS / Linux
  rm -rf .session/chrome-profile
  ```

> Ao matar o processo do Chrome "na marra", pode restar o arquivo de lock `Singleton*` no profile. Se o próximo `launch` falhar com `already running`, remova-o manualmente.

---

## Estrutura de pastas

```
insta-connect-delsuc/
├── src/
│   ├── index.ts                    # Re-export: tipos + InstaConnect
│   ├── types.ts
│   ├── example.ts
│   ├── socket-server.ts            # HTTP + Socket.IO; usa `PORT` e `PUBLIC_BASE_URL`
│   ├── socket-client.ts            # CLI interativo
│   ├── insta-connect/
│   │   └── InstaConnect.ts
│   ├── server/
│   │   ├── register-socket-handlers.ts
│   │   └── media-proxy.ts
│   ├── client/
│   │   ├── help.ts
│   │   └── dm-tap-format.ts
│   ├── lib/                        # utilitários (env, parse, etc.)
│   └── browser/
│       ├── dm-tap.source.ts
│       └── dm-tap.user.js
├── scripts/
│   ├── build-userscript.ts
│   ├── live-dm-tap-client.ts
│   ├── smoke-dm-tap.ts
│   └── smoke-dm-tap-advanced.ts
└── .session/                       # (runtime) perfil Chromium + cache dedup
```

---

## Limitações conhecidas

- **Envio rápido via API interna**: desabilitado. O IG Web usa GraphQL mutations com tokens voláteis; manter isso estável exige re-engenharia contínua.
- **Cloudflare / 2FA / checkpoints**: não tratados automaticamente. Use `headless: false` para resolver manualmente quando aparecer desafio.
- **Tópicos MQTT fora do DM**: o `dmTap` filtra apenas frames que pareçam mensagens diretas. Outras notificações (likes, follows) não são propagadas.
- **Parser Thrift**: heurístico (sem schema oficial). A maior parte do IG Web atual transmite JSON puro; o fallback Thrift existe por robustez histórica.
- **Windows + nodemon**: ao editar `src/*.ts` com o socket em dev, o nodemon reinicia o processo Node mas **não** fecha o Chromium. Em casos raros o lock do profile permanece — reinicie o dev server e, se necessário, remova `Singleton*` do profile.

---

## Licença

MIT

# insta-connect-delsuc

Biblioteca TypeScript/Node.js para automação do Instagram Web via Puppeteer, com servidor Socket.IO para controle em tempo real e um interceptador de DMs (`dmTap`) que decodifica mensagens diretamente do WebSocket MQTT do Instagram.

---

## Sumário

- [Requisitos](#requisitos)
- [Instalação](#instalação)
- [Scripts NPM](#scripts-npm)
- [Configuração em código](#configuração-em-código)
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

Em outro projeto, como dependência npm: `npm install insta-connect-delsuc@^0.1.4`. O método `autoFollowFollowersOfUser` está incluído a partir da versão **0.1.4**.

## Scripts NPM

| Script | Descrição |
| --- | --- |
| `npm run dev` | Sobe o servidor Socket.IO em modo dev: nodemon + `ts-node` conforme `nodemon.json` (por padrão `src/socket-server.ts`; mesma intenção de `socket:dev`) |
| `npm run build` | Compila TypeScript para `dist/` |
| `npm start` | Roda `dist/example.js` (exemplo compilado) |
| `npm run socket:dev` | Sobe o servidor Socket.IO em modo dev (TS + nodemon); por padrão porta **4010** (ou `node dist/socket-server.js <porta> <publicBaseUrl>`) |
| `npm run socket` | Roda o servidor Socket.IO compilado |
| `npm run socket:client:dev` | CLI interativo (cliente Socket.IO) em TS |
| `npm run socket:client` | CLI interativo compilado |
| `npm run build:userscript` | Gera `src/browser/dm-tap.user.js` a partir de `dm-tap.source.ts` (Tampermonkey) |
| `npm pack` | Gera o tarball `insta-connect-delsuc-<versão>.tgz` no diretório atual (o mesmo conteúdo publicável; executar após `npm run build`) |

Para experimentar a classe `InstaConnect` sem o socket, use o exemplo: `npx ts-node src/example.ts` (ou `npm start` após `npm run build`).

## Configuração em código

A biblioteca **não** lê `.env` nem `process.env` para caminhos do browser ou defaults do `InstaConnect`. Quem integra passa um objeto `InstaConnectConfig` (e, se quiser, uma função que ajusta o `puppeteer.launch`).

| Campo em `InstaConnectConfig` | Padrão | Função |
| --- | --- | --- |
| `basePath` | `process.cwd()` | Base para resolver `sessionDir` e `seenMessagesFile` quando forem relativos. |
| `sessionDir` | `.session/chrome-profile` | Perfil do Chromium (cookies, localStorage). Vários `basePath` + `sessionDir` distintos = várias contas. |
| `seenMessagesFile` | `.session/seen-message-ids.json` | Cache de `messageId` do `dmTap` (deduplicação entre reinícios). |
| `headless` | `false` se `LaunchOptions.headless` não for passado | Modo headless; `headless` em `new InstaConnect({ headless: true, insta: {...} })` tem prioridade. |
| `viewportWidth` / `viewportHeight` | efetivo **1000**×**600** (com clamp) | Viewport “desktop”. Largura mín. efetiva 1024, altura mín. 600, para evitar layout mobile. |

Ajuste fino do Puppeteer: segundo argumento do construtor, ou o tipo `InstaConnectLaunchCustomize` — recebe o `LaunchOptions` já resolvido e devolve o objeto final (ex.: acrescentar `--no-sandbox` em `args`).

**Uso mínimo (factory):**

```ts
import { createInstaConnect } from "insta-connect-delsuc";

const client = createInstaConnect(
  { basePath: process.cwd(), headless: true },
  (launch) => ({ ...launch, slowMo: 50 }),
);
```

**Servidor HTTP + Socket.IO (programático):** use `startInstaConnectSocketServer` com `port`, `publicBaseUrl` (URLs de mídia por sessão: `/session/:sessionId/voice/:id` e `/session/:sessionId/image/:id`), `insta?` e opcionalmente `customizeLaunch` e `log`.

```ts
import { startInstaConnectSocketServer } from "insta-connect-delsuc";

startInstaConnectSocketServer({
  port: 4010,
  publicBaseUrl: "https://seu-servidor.com",
  insta: { sessionDir: ".session/conta-1" },
});
```

**CLI do repositório (dev):** o executável `dist/socket-server.js` usa argumentos de linha de comando, não `.env`: `node dist/socket-server.js [porta] [publicBaseUrl]`. O **cliente** CLI: `node dist/socket-client.js [url]` (default `http://localhost:4010`). Em scripts próprios, carregue `.env` na **sua** aplicação e mapeie para `InstaConnectConfig` / `startInstaConnectSocketServer` se quiser.

---

## Uso rápido como biblioteca

```ts
import { InstaConnect } from "insta-connect-delsuc"; // tipos em `types`, `createInstaConnect` e `startInstaConnectSocketServer` no barrel

const client = new InstaConnect({
  headless: false,
  insta: { basePath: process.cwd() },
});

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
- `login(username, password)` — faz login; se cair em challenge retorna `challengeRequired: true`
- `submitSecurityCode(code)` — envia o código de segurança/2FA quando o login entra em challenge
- `close()` — encerra o browser
- `listConversations(limit)` — scraping DOM da inbox
- `searchUsers(query, { limit? })` — busca de contas combinando respostas de rede (JSON) e links no DOM; requer sessão autenticada
- `listSuggestedPeople({ limit? })` — lista sugestões de usuários em `https://www.instagram.com/explore/people/`
- `getSuggestedUsersDataByTargetId(targetId, { limit?, module? })` — busca sugestões via GraphQL chaining (inclui `isPrivate`, `userId`, etc.)
- `followUserById(userId)` — executa follow via endpoint interno do Instagram
- `autoFollowSuggestedUsers(quantity, { privacyFilter? })` — segue automaticamente sugestões com filtro `public`/`private`/`any`, tentando bater a meta da quantidade solicitada
- `autoFollowFollowersOfUser(targetUsername, quantity, { privacyFilter? })` — busca o perfil (mesma lógica que `searchUsers` com match exato; se não achar, acessa a URL `/<username>/`), lista seguidores via API web e segue a quantidade pedida, sem redirecionar para Explore a cada follow
- `listConversationsByNetworkIntercept(timeoutMs)` — extrai inbox via interceptação de rede (mais robusto que DOM)
- `sendMessageToConversation(title, text)` — envia uma DM por simulação de teclado (DOM)
- `openConversationByTitle(title, { dedicatedTab? })` — abre conversa por título; base para o comando socket `openConversation` e o fluxo `mto:` no CLI
- `listMessagesByThreadId(threadId, limit)` — lê mensagens de uma thread
- `startMessageListener(onEvent)` / `stopMessageListener()` — escuta toda mensagem nova (via interceptação de rede)
- `startThreadListener(threadId, onEvent)` / `stopThreadListener()` — escuta novas mensagens de uma thread específica
- **`startDmTap(onMessage, onDebug?)` / `stopDmTap()` / `isDmTapActive()` / `getDmTapStats()`** — interceptação direta do WebSocket MQTT do IG (ver [DM Tap](#dm-tap--interceptação-de-mensagens-em-tempo-real))
- `getInstagramMediaAuthHeaders()` — cabeçalhos de autenticação para o proxy de mídia (cookies/sessão)
- `debugInboxTraffic(timeoutMs)` / `debugMessageTransport(timeoutMs)` / `debugInstagramSocket(timeoutMs)` / `probeInstagramRealtime(timeoutMs)` — helpers de diagnóstico de tráfego

**Integração HTTP/REST:** em um backend próprio, você pode expor rotas (por exemplo `POST` com JSON) que reutilizam a mesma instância de `InstaConnect` (sessão com login já feito) e chamam `autoFollowFollowersOfUser`, `autoFollowSuggestedUsers` ou outros métodos, com validação e limites no seu serviço — o contrato fica a cargo da aplicação.

---

## Servidor Socket.IO em tempo real

Em um projeto integrador, chame `startInstaConnectSocketServer` (ver [Configuração em código](#configuração-em-código)). Para testar **este** repositório:

```bash
npm run socket:dev
```

Endpoint: `http://localhost:<porta>` com Socket.IO (ex.: `ws://localhost:4010`, transporte típico `websocket`). A porta padrão do binário é **4010**; para outra: `node dist/socket-server.js 5000 http://localhost:5000`.

Assim que um cliente conecta, recebe o evento `status`:

```json
{ "message": "connected", "socketId": "abc123" }
```

### Comandos aceitos

| Comando | Payload | Descrição |
| --- | --- | --- |
| `createSession` | `{ sessionId? }` | Cria sessão no registry. Se omitido, o servidor gera GUID (`randomUUID`) |
| `listSessions` | — | Lista sessões ativas no processo |
| `closeSession` | `{ sessionId }` | Fecha browser/recursos da sessão e remove do registry |
| `openLogin` | `{ sessionId }` | Abre a página de login da sessão |
| `login` | `{ sessionId, username, password }` | Faz login com credenciais na sessão |
| `submitSecurityCode` | `{ sessionId, code }` | Envia o código de segurança quando o login entrar em challenge |
| `closeBrowser` | `{ sessionId }` | Encerra o Chromium da sessão |
| `listConversations` | `{ sessionId, limit? }` | Lista conversas da inbox via DOM |
| `searchUsers` | `{ sessionId, query, limit? }` | Busca de usuários; `query` é obrigatório |
| `listSuggestedPeople` | `{ sessionId, limit? }` | Lista usuários sugeridos da página Explore People |
| `getSuggestedUsersData` | `{ sessionId, targetId, limit?, module? }` | Busca sugestões via GraphQL chaining (`module`: `profile` ou `home`) |
| `followUser` | `{ sessionId, userId }` | Segue um usuário pelo `userId` numérico |
| `autoFollowSuggested` | `{ sessionId, quantity, privacyFilter? }` | Auto-follow de sugeridos com filtro (`public`, `private` ou `any`) e tentativa de bater a meta |
| `autoFollowFollowers` | `{ sessionId, targetUsername, quantity, privacyFilter? }` | Abre o perfil alvo (busca + URL direta se preciso), segue N seguidores desse perfil com o mesmo filtro de privacidade |
| `listConversationsIntercept` | `{ sessionId, timeoutMs? }` | Lista conversas via interceptação de rede |
| `debugInboxTraffic` | `{ sessionId, timeoutMs? }` | Snapshot de requests/respostas da inbox |
| `debugMessageTransport` | `{ sessionId, timeoutMs?, withMessagesOnly? }` | Snapshot de tráfego relacionado a mensagens |
| `debugInstagramSocket` | `{ sessionId, timeoutMs?, directOnly? }` | Captura frames dos WebSockets do IG |
| `probeInstagramRealtime` | `{ sessionId, timeoutMs? }` | Perfil agregado dos canais realtime do IG |
| `sendMessage` | `{ sessionId, conversationTitle, text }` | Envia DM via simulação de teclado |
| `listMessages` | `{ sessionId, threadId, limit? }` | Lê mensagens de uma thread |
| `startMessageListener` | `{ sessionId }` | Começa a emitir `newMessage` para mensagens em qualquer thread |
| `stopMessageListener` | `{ sessionId }` | Para o listener global da sessão |
| `startThreadListener` | `{ sessionId, threadId }` | Começa a emitir `newMessage` apenas para uma thread |
| `stopThreadListener` | `{ sessionId }` | Para o listener de thread da sessão |
| **`startDmTap`** | `{ sessionId, debug? }` | Liga o interceptador de DMs via MQTT (emite `dmTap:newMessage`) |
| **`stopDmTap`** | `{ sessionId }` | Desliga o interceptador |
| **`getDmTapStats`** | `{ sessionId }` | Retorna telemetria do parser (frames vistos, payloads JSON, Thrift, erros) |
| **`openConversation`** | `{ sessionId, conversationTitle, dedicatedTab?, autoStartDmTap?, preloadMessages? }` | Abre conversa por título; `preloadMessages` tenta anexar últimas mensagens da thread; `autoStartDmTap` liga o tap se ainda inativo. No CLI, o prefixo `mto:` aplica aba dedicada e dmTap automático. |
| **`resolveVoiceMessage`** | `{ sessionId, senderUsername? \| voiceSimpleId? \| messageId? }` | Último áudio do usuário ou link por id simples (proxy `GET /session/:sessionId/voice/:id`) |
| **`resolveImageMessage`** | `{ sessionId, senderUsername? \| imageSimpleId? \| messageId? }` | Última imagem do usuário ou link por id simples (proxy `GET /session/:sessionId/image/:id`) |

### Eventos emitidos

| Evento | Quando |
| --- | --- |
| `status` | Na conexão inicial |
| `createSession:result` | Resposta de `createSession` |
| `listSessions:result` | Resposta de `listSessions` |
| `closeSession:result` | Resposta de `closeSession` |
| `openLogin:result` | Resposta de `openLogin` |
| `login:result` | Resposta de `login` |
| `submitSecurityCode:result` | Resposta de `submitSecurityCode` |
| `closeBrowser:result` | Resposta de `closeBrowser` |
| `listConversations:result` | Resposta de `listConversations` |
| `searchUsers:result` | Resposta de `searchUsers` |
| `listSuggestedPeople:result` | Resposta de `listSuggestedPeople` |
| `getSuggestedUsersData:result` | Resposta de `getSuggestedUsersData` |
| `followUser:result` | Resposta de `followUser` |
| `autoFollowSuggested:result` | Resposta de `autoFollowSuggested` |
| `autoFollowFollowers:result` | Resposta de `autoFollowFollowers` (inclui `targetUserId`, `profileOpenedVia`, `results` por seguidor) |
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

Em um segundo terminal (com o servidor já no ar):

```bash
npm run socket:client:dev
```

Opcionalmente passe a URL do servidor: `node dist/socket-client.js http://127.0.0.1:5000`.

Comandos disponíveis (espelhados em `src/client/help.ts`):

```
createSession [sessionId]
listSessions
useSession <sessionId>
closeSession <sessionId>
openLogin
login <username> <password>
submitSecurityCode <codigo>
cancel2fa
listConversations [limit]
searchUsers <query> [limit]
listSuggestedPeople [limit]
getSuggestedUsersData <targetId> [limit]
followUser <userId>
autoFollow <quantidade> [public|private|any]
autoFollowFollowers <targetUsername> <quantidade> [public|private|any]
autoFollow:<quantidade>  # legado
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

No fluxo de login, se `login` retornar challenge (`challengeRequired: true`), o CLI entra no prompt `2fa>` para você digitar o código recebido. Também é possível enviar manualmente com `submitSecurityCode <codigo>` e sair desse modo com `cancel2fa`.

Exemplos de auto-follow por filtro:

```bash
autoFollow 3 public
autoFollow 2 private
autoFollow 5 any
```

Ao usar filtro (`public`/`private`), a automação ignora sugestões fora do perfil e continua buscando novos candidatos para tentar alcançar a quantidade pedida.

**Seguidores de um perfil específico** (`autoFollowFollowersOfUser` / socket `autoFollowFollowers` / CLI abaixo): localiza o `@targetUsername` pela busca com match exato; se não aparecer na lista, abre `https://www.instagram.com/<username>/`. Obtém a lista de seguidores com `GET /api/v1/friendships/{id}/followers/` (paginado) e aplica o mesmo `privacyFilter` antes de dar follow (sem `goto` em Explore a cada clique, ao contrário de `autoFollow`).

```bash
autoFollowFollowers smartfit 3 public
autoFollowFollowers outraconta 2 any
```

Para empacotar a biblioteca após o build: `npm pack` (ou `npm publish` no registry que usares).

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
let sessionId = "";

socket.on("connect", () => {
  socket.emit("createSession", {}); // sem id => GUID
});

socket.on("createSession:result", (r) => {
  sessionId = r.sessionId;
  socket.emit("openLogin", { sessionId });
});

socket.on("openLogin:result", () => {
  socket.emit("startDmTap", { sessionId, debug: false });
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

const client = new InstaConnect({ headless: false, insta: { basePath: process.cwd() } });
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

O servidor HTTP do `socket-server` expõe proxies autenticados (cookies do Chromium): `GET /session/<sessionId>/voice/<id>` (áudio) e `GET /session/<sessionId>/image/<id>` (imagem), com `<id>` numérico. Em deploy remoto, passe `publicBaseUrl` em `startInstaConnectSocketServer` para que os links retornados ao cliente apontem para o host público.

### Debug e telemetria

- `getDmTapStats()` retorna um objeto com contadores globais: total de frames, `publishFrames`, `jsonOk`, `thriftOk`, `parseErrors`, `emitted`, `dedupHits`, etc.
- `dmTap:debug` (opt-in) emite eventos ricos para cada frame (cabeçalho MQTT, topic, tamanho do payload, razão de descarte). **Não ligue em produção** — pode gerar centenas de eventos por minuto.
- O LRU de `messageId` é persistido em `insta.seenMessagesFile` (default `.session/seen-message-ids.json` relativo a `basePath`) para sobreviver a restart do processo.

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

- No modo Socket server, cada sessão do registry (`sessionId`) ganha paths isolados automaticamente para profile e dedup (`seenMessagesFile`).
- Se `createSession` vier sem `sessionId`, o servidor gera um GUID (`randomUUID`).
- Cookies, localStorage e cache do Chromium são salvos em `insta.sessionDir` (default base `.session/chrome-profile`) com namespace por sessão.
- Isso elimina a necessidade de logar novamente ao recriar a mesma sessão (mesmo `sessionId`).
- Para limpar completamente uma sessão específica, delete o diretório da sessão:

  ```bash
  # Windows (PowerShell)
  Remove-Item -Recurse -Force .session\<sessionId>

  # macOS / Linux
  rm -rf .session/<sessionId>
  ```

> Ao matar o processo do Chrome "na marra", pode restar o arquivo de lock `Singleton*` no profile. Se o próximo `launch` falhar com `already running`, remova-o manualmente.

---

## Estrutura de pastas

```
insta-connect-delsuc/
├── src/
│   ├── index.ts                    # Re-export: tipos, InstaConnect, createInstaConnect, startInstaConnectSocketServer
│   ├── types.ts
│   ├── example.ts
│   ├── socket-server.ts            # HTTP + Socket.IO; `startInstaConnectSocketServer` + CLI por argv
│   ├── socket-client.ts            # CLI interativo (URL via argv)
│   ├── insta-connect/
│   │   └── InstaConnect.ts
│   ├── server/
│   │   ├── register-socket-handlers.ts
│   │   └── media-proxy.ts
│   ├── client/
│   │   ├── help.ts
│   │   └── dm-tap-format.ts
│   ├── lib/                        # utilitários (parse, websocket, etc.)
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
- **Cloudflare / checkpoints avançados**: não tratados automaticamente. Para challenge de código (`security code` / `two_factor`), a lib agora suporta envio assistido via `submitSecurityCode`, mas desafios adicionais podem exigir intervenção manual.
- **Tópicos MQTT fora do DM**: o `dmTap` filtra apenas frames que pareçam mensagens diretas. Outras notificações (likes, follows) não são propagadas.
- **Parser Thrift**: heurístico (sem schema oficial). A maior parte do IG Web atual transmite JSON puro; o fallback Thrift existe por robustez histórica.
- **Windows + nodemon**: ao editar `src/*.ts` com o socket em dev, o nodemon reinicia o processo Node mas **não** fecha o Chromium. Em casos raros o lock do profile permanece — reinicie o dev server e, se necessário, remova `Singleton*` do profile.
- **Auto-follow a partir dos seguidores de outro perfil**: perfis privados ou o Instagram a bloquear a API de followers (`403`/`400` ou resposta inesperada) impedem a listagem; a API pública muda e pode exigir ajuste de parâmetros. Filtro `public`/`private` pode precisar de **mais** páginas de listagem se muitas contas forem ignoradas. Uso intenso pode acionar limites de ação da plataforma.

---

## Licença

MIT

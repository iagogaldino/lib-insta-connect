// ==UserScript==
// @name         IG DM Tap PoC
// @namespace    https://github.com/insta-connect-delsuc
// @version      0.1.0
// @description  Intercepta DMs do Instagram Web via monkey-patch do WebSocket + parser MQTT/Thrift.
// @author       insta-connect-delsuc
// @match        https://www.instagram.com/*
// @match        https://*.instagram.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

// AUTOGERADO a partir de src/browser/dm-tap.source.ts
// Para editar, modifique a fonte e rode: npm run build:userscript
(() => {
  if (typeof window === "undefined") return;
  if (window.__IG_DM_TAP_INSTALLED__) return;
  window.__IG_DM_TAP_INSTALLED__ = true;

  // ---------------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------------
  var URL_RE = /(edge-chat|wss-edge|realtime|mqtt|chat-e2ee)\.instagram\.com|instagram\.com\/ws|edge-chat\.facebook\.com|mqtt\.facebook\.com/i;
  var LOG_PREFIX = "[Grampo DM]";
  var MIN_PK = 100000000;           // 1e8  - menor PK plausivel
  var MAX_PK = 100000000000000;     // 1e14 - maior PK plausivel (IG usa ~10^12..10^13)
  var MIN_TEXT_LEN = 1;
  // Strings que NAO sao mensagem (topics MQTT, campos conhecidos, prefixos Thrift)
  var NOISE_RE = /^(\/ig_|\/t_|\/fbns|\/messenger|\/mqtt|ig_message_|ig_realtime|ig_|thread_|item_|client_|messaging|direct_|presence|typing_|activity)/i;

  // ---------------------------------------------------------------------------
  // Monkey patch do WebSocket
  // ---------------------------------------------------------------------------
  var NativeWS = window.WebSocket;
  if (!NativeWS) return;

  function PatchedWS(url, protocols) {
    var ws = (arguments.length <= 1)
      ? new NativeWS(url)
      : new NativeWS(url, protocols);
    try {
      var sUrl = String(url);
      if (typeof window.__IG_DM_TAP_STATS__ !== "undefined") {
        window.__IG_DM_TAP_STATS__.wsAllUrls.push(sUrl);
      }
      try { dbg("ws-open", { url: sUrl, matched: URL_RE.test(sUrl) }); } catch (_) {}
      if (URL_RE.test(sUrl)) {
        installTap(ws, sUrl);
      }
    } catch (err) {
      try { console.warn(LOG_PREFIX, "install-fail", err); } catch (_) {}
    }
    return ws;
  }
  PatchedWS.prototype = NativeWS.prototype;
  PatchedWS.prototype.constructor = PatchedWS;
  PatchedWS.CONNECTING = NativeWS.CONNECTING;
  PatchedWS.OPEN = NativeWS.OPEN;
  PatchedWS.CLOSING = NativeWS.CLOSING;
  PatchedWS.CLOSED = NativeWS.CLOSED;
  try {
    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: PatchedWS,
    });
  } catch (_) {
    window.WebSocket = PatchedWS;
  }

  try { console.log(LOG_PREFIX, "installed (monkey-patch ativo)"); } catch (_) {}

  // Telemetria agregada (acessivel via window.__IG_DM_TAP_STATS__)
  var STATS = {
    wsAllUrls: [],        // TODAS as URLs de WS vistas (casou ou nao)
    wsTappedUrls: [],     // URLs onde instalamos tap
    framesSeen: 0,
    framesText: 0,
    framesBinary: 0,
    mqttPublish: 0,
    mqttOther: 0,
    inflateSuccess: 0,
    inflateSkip: 0,
    thriftOk: 0,
    thriftFail: 0,
    jsonOk: 0,
    extractedDm: 0,
    lastTopics: [],       // ultimos 10 topics vistos
    samplePublishHex: "", // hex dos primeiros 64 bytes do 1o PUBLISH
  };
  window.__IG_DM_TAP_STATS__ = STATS;

  // Gate de telemetria verbose:
  //   - window.__IG_DM_TAP_DEBUG__ = true  (setado pelo host Puppeteer/tampermonkey)
  //   - OU query string ?dm-tap-debug=1
  // Default: OFF (evita flood de Socket.IO/console). Stats continuam.
  function isDebugOn() {
    try {
      if (window.__IG_DM_TAP_DEBUG__ === true) return true;
      if (typeof location !== "undefined" &&
          /[?&]dm-tap-debug=1\b/.test(String(location.search || ""))) {
        return true;
      }
    } catch (_) {}
    return false;
  }

  function dbg(kind, data) {
    if (!isDebugOn()) return;
    try {
      if (typeof window.__igDmTapDebug === "function") {
        window.__igDmTapDebug({ kind: kind, data: data, ts: new Date().toISOString() });
      }
    } catch (_) {}
  }

  // LRU de messageIds ja emitidos (dedup ENTRE payloads; IG reenvia o mesmo
  // delta quando o cliente abre a thread de novo).
  var SEEN_MSG_IDS = [];
  var SEEN_MSG_IDS_SET = Object.create(null);
  var SEEN_MAX = 200;
  function alreadySeen(id) {
    if (!id) return false;
    if (SEEN_MSG_IDS_SET[id]) return true;
    SEEN_MSG_IDS_SET[id] = 1;
    SEEN_MSG_IDS.push(id);
    if (SEEN_MSG_IDS.length > SEEN_MAX) {
      var evicted = SEEN_MSG_IDS.shift();
      delete SEEN_MSG_IDS_SET[evicted];
    }
    return false;
  }

  function installTap(ws, url) {
    STATS.wsTappedUrls.push(url);
    dbg("ws-tap-installed", { url: url });
    // capture phase: roda ANTES do handler do IG
    ws.addEventListener("message", function (evt) {
      STATS.framesSeen++;
      handleFrame(evt, url).catch(function (err) {
        try { console.warn(LOG_PREFIX, "handle-fail", err && err.message); } catch (_) {}
      });
    }, true);
  }

  async function handleFrame(evt, url) {
    var data = evt && evt.data;
    if (!data) return;
    var u8;
    if (data instanceof ArrayBuffer) {
      u8 = new Uint8Array(data);
      STATS.framesBinary++;
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      u8 = new Uint8Array(await data.arrayBuffer());
      STATS.framesBinary++;
    } else if (typeof data === "string") {
      STATS.framesText++;
      dbg("frame-text", { url: url, preview: data.slice(0, 120) });
      return;
    } else if (data && data.buffer instanceof ArrayBuffer) {
      u8 = new Uint8Array(data.buffer, data.byteOffset || 0, data.byteLength);
      STATS.framesBinary++;
    } else {
      return;
    }
    if (u8.byteLength < 2) return;

    // Um WS frame PODE conter >1 pacote MQTT concatenado. Loop defensivo.
    var offset = 0;
    var safety = 0;
    while (offset < u8.byteLength && safety < 16) {
      safety++;
      var pkt = parseMqttPublish(u8, offset);
      if (!pkt) return;
      offset = pkt.nextOffset;
      if (pkt.type !== 3) {
        STATS.mqttOther++;
        continue;
      }
      STATS.mqttPublish++;
      if (!STATS.samplePublishHex) {
        STATS.samplePublishHex = bytesToHex(pkt.payload.subarray(0, 64));
      }
      if (STATS.lastTopics.length >= 10) STATS.lastTopics.shift();
      STATS.lastTopics.push(pkt.topic);
      dbg("mqtt-publish", {
        topic: pkt.topic,
        payloadBytes: pkt.payload.byteLength,
        headHex: bytesToHex(pkt.payload.subarray(0, 16)),
      });
      await processPublish(pkt, url);
    }
  }

  // ---------------------------------------------------------------------------
  // MQTT parser (apenas o necessario para localizar PUBLISH)
  // ---------------------------------------------------------------------------
  // Formato:
  //   byte0 = (type<<4) | flags   // PUBLISH = 3 -> 0x30..0x3F
  //   remaining length = varint (1..4 bytes, 7 bits cada + MSB continuation)
  //   topic  = u16 len + bytes UTF-8
  //   [packetId u16] se QoS > 0
  //   payload = restante
  function parseMqttPublish(u8, startOffset) {
    var i = startOffset;
    if (i >= u8.byteLength) return null;
    var b0 = u8[i++]; 
    var type = (b0 >> 4) & 0x0F;
    var qos = (b0 >> 1) & 0x03;

    // remaining length (MQTT variable-byte integer)
    var multiplier = 1;
    var remaining = 0;
    var shiftCount = 0;
    while (true) {
      if (i >= u8.byteLength) return null;
      var d = u8[i++];
      remaining += (d & 0x7F) * multiplier;
      if ((d & 0x80) === 0) break;
      multiplier *= 128;
      shiftCount++;
      if (shiftCount > 3) return null;
    }
    var fixedEnd = i;
    var pktEnd = fixedEnd + remaining;
    if (pktEnd > u8.byteLength) return null;

    if (type !== 3) {
      // Nao e PUBLISH; pula este pacote mas devolve info para avancar o cursor
      return { type: type, topic: "", payload: new Uint8Array(0), nextOffset: pktEnd };
    }

    // Topic (u16 BE + bytes UTF-8)
    if (i + 2 > pktEnd) return null;
    var topicLen = (u8[i] << 8) | u8[i + 1];
    i += 2;
    if (i + topicLen > pktEnd) return null;
    var topicBytes = u8.subarray(i, i + topicLen);
    i += topicLen;
    var topic = "";
    try { topic = new TextDecoder("utf-8", { fatal: false }).decode(topicBytes); } catch (_) { topic = ""; }

    if (qos > 0) {
      if (i + 2 > pktEnd) return null;
      i += 2; // packet id
    }

    var payload = u8.subarray(i, pktEnd);
    return { type: 3, topic: topic, payload: payload, nextOffset: pktEnd };
  }

  // ---------------------------------------------------------------------------
  // Descompressao (zlib/deflate/gzip) via DecompressionStream (Chromium)
  // ---------------------------------------------------------------------------
  async function maybeInflate(u8) {
    if (!u8 || u8.byteLength < 2) return u8;
    if (typeof DecompressionStream === "undefined") return u8;

    var b0 = u8[0], b1 = u8[1];
    var looksZlib = (b0 === 0x78) && (b1 === 0x9C || b1 === 0xDA || b1 === 0x01 || b1 === 0x5E);
    var looksGzip = (b0 === 0x1F && b1 === 0x8B);

    var tries = [];
    if (looksZlib) tries.push("deflate");
    if (looksGzip) tries.push("gzip");
    // Fallback cego: muitos payloads IG sao deflate-raw (sem header zlib)
    tries.push("deflate-raw");
    if (!looksZlib) tries.push("deflate");

    for (var k = 0; k < tries.length; k++) {
      try {
        var out = await inflateOnce(u8, tries[k]);
        if (out && out.byteLength > 0) return out;
      } catch (_) { /* tenta proximo */ }
    }
    return u8;
  }

  async function inflateOnce(u8, format) {
    var ds = new DecompressionStream(format);
    var writer = ds.writable.getWriter();
    writer.write(u8);
    writer.close();
    var chunks = [];
    var total = 0;
    var reader = ds.readable.getReader();
    while (true) {
      var r = await reader.read();
      if (r.done) break;
      chunks.push(r.value);
      total += r.value.byteLength;
    }
    var result = new Uint8Array(total);
    var off = 0;
    for (var i = 0; i < chunks.length; i++) {
      result.set(chunks[i], off);
      off += chunks[i].byteLength;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Thrift Compact Protocol - parser estrutural (sem schema)
  // ---------------------------------------------------------------------------
  // Referencia: https://github.com/apache/thrift/blob/master/doc/specs/thrift-compact-protocol.md
  function Reader(u8) {
    this.buf = u8;
    this.off = 0;
  }
  Reader.prototype.eof = function () { return this.off >= this.buf.byteLength; };
  Reader.prototype.u8 = function () {
    if (this.off >= this.buf.byteLength) throw new Error("EOF u8");
    return this.buf[this.off++];
  };
  Reader.prototype.i16 = function () {
    // compact protocol: zigzag varint
    var n = this.varint();
    return zz32(Number(BigInt.asIntN(32, n)));
  };
  Reader.prototype.varint = function () {
    var shift = 0n;
    var result = 0n;
    for (var i = 0; i < 10; i++) {
      if (this.off >= this.buf.byteLength) throw new Error("EOF varint");
      var b = this.buf[this.off++];
      result |= (BigInt(b & 0x7F) << shift);
      if ((b & 0x80) === 0) return result;
      shift += 7n;
    }
    throw new Error("varint too long");
  };
  Reader.prototype.bytes = function (len) {
    if (this.off + len > this.buf.byteLength) throw new Error("EOF bytes");
    var s = this.buf.subarray(this.off, this.off + len);
    this.off += len;
    return s;
  };

  function zz32(n) { return (n >>> 1) ^ -(n & 1); }
  function zz64big(n) {
    var mask = (n & 1n) ? -1n : 0n;
    return (n >> 1n) ^ mask;
  }

  var TC = {
    STOP: 0, TRUE: 1, FALSE: 2, BYTE: 3, I16: 4, I32: 5, I64: 6,
    DOUBLE: 7, BINARY: 8, LIST: 9, SET: 10, MAP: 11, STRUCT: 12,
  };
  var TC_NAMES = {
    0: "STOP", 1: "BOOL", 2: "BOOL", 3: "BYTE", 4: "I16", 5: "I32", 6: "I64",
    7: "DOUBLE", 8: "BINARY", 9: "LIST", 10: "SET", 11: "MAP", 12: "STRUCT",
  };

  function readValue(reader, type, depth) {
    if (depth > 32) throw new Error("depth");
    switch (type) {
      case TC.TRUE:   return true;
      case TC.FALSE:  return false;
      case TC.BYTE:   return reader.u8();
      case TC.I16: {
        var v = reader.varint();
        return Number(zz64big(v));
      }
      case TC.I32: {
        var v32 = reader.varint();
        return Number(zz64big(v32));
      }
      case TC.I64: {
        var v64 = reader.varint();
        return zz64big(v64); // BigInt
      }
      case TC.DOUBLE: {
        // 8 bytes little-endian (compact protocol)
        var dv = new DataView(reader.buf.buffer, reader.buf.byteOffset + reader.off, 8);
        var d = dv.getFloat64(0, true);
        reader.off += 8;
        return d;
      }
      case TC.BINARY: {
        var len = Number(reader.varint());
        if (len < 0 || len > reader.buf.byteLength - reader.off) throw new Error("binary len");
        var bytes = reader.bytes(len);
        try {
          var s = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          return { __str: s, __bytes: bytes.byteLength };
        } catch (_) {
          // nao e UTF-8; retem bytes como hex
          return { __bin: bytesToHex(bytes), __bytes: bytes.byteLength };
        }
      }
      case TC.LIST:
      case TC.SET: {
        var sizeByte = reader.u8();
        var size = (sizeByte >> 4) & 0x0F;
        var elemType = sizeByte & 0x0F;
        if (size === 15) size = Number(reader.varint());
        var arr = [];
        for (var i = 0; i < size; i++) arr.push(readValue(reader, elemType, depth + 1));
        return arr;
      }
      case TC.MAP: {
        var msize = Number(reader.varint());
        if (msize === 0) return [];
        var kvByte = reader.u8();
        var kType = (kvByte >> 4) & 0x0F;
        var vType = kvByte & 0x0F;
        var entries = [];
        for (var j = 0; j < msize; j++) {
          var key = readValue(reader, kType, depth + 1);
          var val = readValue(reader, vType, depth + 1);
          entries.push({ k: key, v: val });
        }
        return entries;
      }
      case TC.STRUCT: {
        return readStruct(reader, depth + 1);
      }
      default:
        throw new Error("unknown type " + type);
    }
  }

  function readStruct(reader, depth) {
    var fields = [];
    var lastId = 0;
    while (!reader.eof()) {
      var hdr = reader.u8();
      if (hdr === 0) break;
      var delta = (hdr >> 4) & 0x0F;
      var type = hdr & 0x0F;
      var fid;
      if (delta === 0) {
        var raw = reader.varint();
        fid = zz32(Number(BigInt.asIntN(32, raw)));
      } else {
        fid = lastId + delta;
      }
      lastId = fid;
      var value = readValue(reader, type, depth);
      fields.push({ id: fid, type: type, typeName: TC_NAMES[type] || String(type), value: value });
    }
    return { __struct: fields };
  }

  function tryParseThrift(u8) {
    try {
      var r = new Reader(u8);
      var root = readStruct(r, 0);
      return root;
    } catch (_) {
      return null;
    }
  }

  function bytesToHex(u8) {
    var s = "";
    var max = Math.min(u8.byteLength, 64);
    for (var i = 0; i < max; i++) {
      var h = u8[i].toString(16);
      if (h.length < 2) h = "0" + h;
      s += h;
    }
    if (u8.byteLength > max) s += "...";
    return s;
  }

  // ---------------------------------------------------------------------------
  // Heuristica: extrai { senderId, text, threadId } da arvore Thrift
  // ---------------------------------------------------------------------------
  function extractDm(tree) {
    var i64s = [];      // { value: BigInt, fieldId: number, parentPath: string }
    var strings = [];   // { value: string, fieldId: number, parentPath: string, bytes: number }

    function walk(node, path, parentFieldId) {
      if (node === null || node === undefined) return;
      if (typeof node === "bigint") {
        var n = node < 0n ? -node : node;
        var asNum = Number(n);
        if (asNum >= MIN_PK && asNum <= MAX_PK) {
          i64s.push({ value: node, fieldId: parentFieldId, path: path });
        }
        return;
      }
      if (typeof node === "number") {
        if (node >= MIN_PK && node <= MAX_PK) {
          i64s.push({ value: BigInt(Math.trunc(node)), fieldId: parentFieldId, path: path });
        }
        return;
      }
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
          walk(node[i], path + "[" + i + "]", parentFieldId);
        }
        return;
      }
      if (typeof node === "object") {
        if (node.__str !== undefined) {
          var s = node.__str;
          if (typeof s === "string" && s.length >= MIN_TEXT_LEN && !NOISE_RE.test(s)) {
            strings.push({ value: s, fieldId: parentFieldId, path: path, bytes: node.__bytes });
          }
          return;
        }
        if (node.__bin !== undefined) return;
        if (node.__struct && Array.isArray(node.__struct)) {
          for (var f = 0; f < node.__struct.length; f++) {
            var fld = node.__struct[f];
            walk(fld.value, path + "." + fld.id + "(" + fld.typeName + ")", fld.id);
          }
          return;
        }
        if (node.k !== undefined && node.v !== undefined) {
          walk(node.k, path + ".k", parentFieldId);
          walk(node.v, path + ".v", parentFieldId);
          return;
        }
      }
    }
    walk(tree, "$", -1);

    // senderId: prefere fields 1/2/3/4 (senderFbid/actorId comuns), senao qualquer PK
    var sender = null;
    var preferred = i64s.filter(function (x) { return x.fieldId >= 1 && x.fieldId <= 4; });
    if (preferred.length > 0) sender = preferred[0];
    else if (i64s.length > 0) sender = i64s[0];

    // threadId: i64 distinto do sender (se houver), senao null
    var threadId = null;
    if (sender) {
      for (var k = 0; k < i64s.length; k++) {
        if (i64s[k].value !== sender.value) { threadId = i64s[k]; break; }
      }
    } else if (i64s.length > 0) {
      threadId = i64s[0];
    }

    // text: maior string imprimivel nao-ruido que nao seja UUID / item_id puro
    var best = null;
    for (var s = 0; s < strings.length; s++) {
      var item = strings[s];
      if (isLikelyUuid(item.value)) continue;
      if (isLikelyIdOnly(item.value)) continue;
      if (!best || item.value.length > best.value.length) best = item;
    }

    return {
      senderId: sender ? sender.value.toString() : null,
      threadId: threadId ? threadId.value.toString() : null,
      text: best ? best.value : null,
      _i64count: i64s.length,
      _strcount: strings.length,
    };
  }

  function isLikelyUuid(s) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  }
  function isLikelyIdOnly(s) {
    return /^[0-9]{10,}$/.test(s) || /^mid\.[0-9A-Za-z:_-]+$/.test(s) || /^aggregated_/.test(s);
  }

  // ---------------------------------------------------------------------------
  // Pipeline PUBLISH -> inflate -> thrift -> heuristica -> emit
  // ---------------------------------------------------------------------------
  async function processPublish(pkt, url) {
    try {
      var inflated = await maybeInflate(pkt.payload);
      if (inflated !== pkt.payload && inflated.byteLength !== pkt.payload.byteLength) {
        STATS.inflateSuccess++;
      } else {
        STATS.inflateSkip++;
      }
      var tree = tryParseThrift(inflated);
      if (tree && tree.__struct && tree.__struct.length > 0) {
        STATS.thriftOk++;
      } else {
        STATS.thriftFail++;
        // Pode ser JSON puro em alguns topicos recentes do IG
        var asText = safeUtf8(inflated);
        if (asText && /[{[]/.test(asText.slice(0, 4))) {
          try {
            var obj = JSON.parse(asText);
            STATS.jsonOk++;
            var heurs = extractFromJson(obj) || [];
            // Preview amplo em topicos de DM; curto no resto para nao floodar
            var isDmTopic = /message_sync|message_queue|iris|direct/i.test(pkt.topic);
            var previewLen = isDmTopic ? 2000 : 260;
            dbg("json-payload", {
              topic: pkt.topic,
              hits: heurs.length,
              hasText: heurs.some(function (h) { return Boolean(h && h.text); }),
              keys: Array.isArray(obj) ? ["<array>", obj.length] : Object.keys(obj).slice(0, 10),
              preview: asText.slice(0, previewLen),
            });
            for (var hi = 0; hi < heurs.length; hi++) {
              var heur = heurs[hi];
              if (!heur) continue;
              if (!heur.text && !heur.senderId && !heur.messageId && !heur.voiceMediaUrl && !heur.imageMediaUrl) {
                continue;
              }
              if (heur.messageId && alreadySeen(heur.messageId)) {
                dbg("skip-dup", { topic: pkt.topic, messageId: heur.messageId });
                continue;
              }
              STATS.extractedDm++;
              emit({
                url: url,
                topic: pkt.topic,
                senderId: heur.senderId,
                senderName: heur.senderName,
                senderUsername: heur.senderUsername,
                threadId: heur.threadId,
                text: heur.text,
                messageId: heur.messageId,
                seqId: heur.seqId,
                typename: heur.typename,
                voiceMediaUrl: heur.voiceMediaUrl,
                imageMediaUrl: heur.imageMediaUrl,
                raw: obj,
                source: "json",
              });
            }
            if (heurs.length > 0) return;
          } catch (_) {}
        } else {
          dbg("payload-unparseable", {
            topic: pkt.topic,
            bytes: inflated.byteLength,
            head: bytesToHex(inflated.subarray(0, 32)),
          });
        }
        return;
      }

      var extracted = extractDm(tree);
      dbg("thrift-extract", {
        topic: pkt.topic,
        senderId: extracted ? extracted.senderId : null,
        threadId: extracted ? extracted.threadId : null,
        hasText: Boolean(extracted && extracted.text),
        textPreview: extracted && extracted.text ? String(extracted.text).slice(0, 120) : null,
        i64s: extracted ? extracted._i64count : 0,
        strs: extracted ? extracted._strcount : 0,
      });
      if (!extracted || !extracted.text) {
        return;
      }
      var thriftMid = extracted.messageId || null;
      if (thriftMid && alreadySeen(thriftMid)) {
        dbg("skip-dup", { topic: pkt.topic, messageId: thriftMid });
        return;
      }
      STATS.extractedDm++;
      emit({
        url: url,
        topic: pkt.topic,
        senderId: extracted.senderId,
        threadId: extracted.threadId,
        text: extracted.text,
        messageId: thriftMid,
        raw: tree,
        source: "thrift",
      });
    } catch (err) {
      dbg("parse-error", {
        topic: pkt && pkt.topic,
        message: err && err.message ? err.message : String(err),
        head: pkt && pkt.payload ? bytesToHex(pkt.payload.subarray(0, 32)) : "",
      });
    }
  }

  function safeUtf8(u8) {
    try { return new TextDecoder("utf-8", { fatal: false }).decode(u8); } catch (_) { return ""; }
  }

  function extractFromJson(obj) {
    // Retorna lista de mensagens encontradas (ig_message_sync pode trazer varias num array)
    var results = [];

    function looksLikeMessageNode(n) {
      if (!n || typeof n !== "object") return false;
      var t = n.__typename;
      if (typeof t === "string" && /NewMessage|Message$|DeltaNewMessage|UQPPNewMessage/i.test(t)) return true;
      // heuristica: tem sender + id de mensagem
      if ((n.sender_fbid || n.sender_id || n.senderId) &&
          (n.message_id || n.mid || n.offline_threading_id)) return true;
      return false;
    }

    function pickSender(n) {
      return (
        n.sender_fbid ||
        n.sender_id ||
        n.senderId ||
        n.user_id ||
        n.actor_id ||
        (n.sender && (n.sender.id || n.sender.fbid)) ||
        null
      );
    }
    function pickThread(n) {
      return (
        n.thread_fbid ||
        n.thread_id ||
        n.threadId ||
        n.thread_key ||
        n.threadKey ||
        (n.thread && (n.thread.id || n.thread.thread_key)) ||
        null
      );
    }
    function pickText(n) {
      // campos mais comuns em DMs Instagram/Messenger
      var c = n.text_body || n.text || n.igd_snippet || n.snippet || n.message_text || n.body || null;
      if (c && typeof c === "string") return c;
      // Instagram serializa texto em { content: { text_body: "..." } }
      if (n.content && typeof n.content === "object") {
        if (typeof n.content.text_body === "string") return n.content.text_body;
        if (typeof n.content.text === "string") return n.content.text;
        if (typeof n.content.body === "string") return n.content.body;
      }
      return null;
    }

    function pickVoiceMediaUrl(n) {
      function isAudioUrl(value) {
        if (!value || typeof value !== "string") return false;
        var v = value.toLowerCase();
        return (
          /^https?:\/\//.test(v) &&
          (v.includes(".m4a") || v.includes(".aac") || v.includes(".mp3") || v.includes("audio"))
        );
      }
      function walkVoice(node) {
        if (!node || typeof node !== "object") return null;
        if (Array.isArray(node)) {
          for (var i = 0; i < node.length; i++) {
            var fromArray = walkVoice(node[i]);
            if (fromArray) return fromArray;
          }
          return null;
        }
        for (var k in node) {
          if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
          var v = node[k];
          var lk = String(k).toLowerCase();
          if (typeof v === "string") {
            if (isAudioUrl(v) && (lk.includes("audio") || lk.includes("voice") || lk.includes("url"))) {
              return v;
            }
          } else if (v && typeof v === "object") {
            var nested = walkVoice(v);
            if (nested) return nested;
          }
        }
        return null;
      }
      return walkVoice(n);
    }

    function pickImageMediaUrl(n) {
      function isAudioUrl(value) {
        if (!value || typeof value !== "string") return false;
        var v = value.toLowerCase();
        return (
          /^https?:\/\//.test(v) &&
          (v.includes(".m4a") || v.includes(".aac") || v.includes(".mp3") || v.includes("/audio") || v.includes("audio%"))
        );
      }
      function isImageUrl(value) {
        if (!value || typeof value !== "string") return false;
        if (!/^https?:\/\//i.test(value) || isAudioUrl(value)) return false;
        var v = value.toLowerCase();
        if (
          v.includes(".jpg") || v.includes(".jpeg") || v.includes(".png") || v.includes(".webp") || v.includes(".heic")
        ) {
          return true;
        }
        if (v.includes("image") && (v.includes("fbcdn") || v.includes("cdninstagram") || v.includes("instagram"))) {
          return true;
        }
        if (v.includes("scontent-") && (v.includes("jpg") || v.includes("oe=") || v.includes("ig_cache_key"))) {
          return true;
        }
        if (
          (v.includes("fbcdn") || v.includes("cdninstagram")) &&
          (v.includes("m1080x1080") || v.includes("m640x") || v.includes("e35") || v.includes("e15"))
        ) {
          return true;
        }
        return false;
      }
      function walkImg(node) {
        if (!node || typeof node !== "object") return null;
        if (Array.isArray(node)) {
          for (var j = 0; j < node.length; j++) {
            var fromA = walkImg(node[j]);
            if (fromA) return fromA;
          }
          return null;
        }
        for (var k in node) {
          if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
          var v = node[k];
          var lk = String(k).toLowerCase();
          if (typeof v === "string" && isImageUrl(v)) {
            if (
              lk.includes("url") ||
              lk.includes("uri") ||
              lk.includes("image") ||
              lk.includes("media") ||
              lk.includes("display") ||
              lk.includes("preview") ||
              lk.includes("src") ||
              lk.includes("thumbnail")
            ) {
              return v;
            }
          } else if (v && typeof v === "object") {
            var nestedI = walkImg(v);
            if (nestedI) return nestedI;
          }
        }
        return null;
      }
      return walkImg(n);
    }

    function pickSenderDetails(n) {
      // Instagram aninha em .sender / .sender.user_dict
      if (n.sender && typeof n.sender === "object") {
        var s = n.sender;
        var ud = s.user_dict && typeof s.user_dict === "object" ? s.user_dict : {};
        return {
          name: s.name || ud.full_name || null,
          username: ud.username || null,
          igId: s.igid || ud.id || null,
        };
      }
      return null;
    }

    var seenIds = Object.create(null);
    (function walk(n) {
      if (!n || typeof n !== "object") return;
      if (Array.isArray(n)) {
        for (var i = 0; i < n.length; i++) walk(n[i]);
        return;
      }
      if (looksLikeMessageNode(n)) {
        var sender = pickSender(n);
        var thread = pickThread(n);
        var text = pickText(n);
        var details = pickSenderDetails(n);
        // se este node "message" contem outro node "message" aninhado, tenta este tambem
        if (n.message && typeof n.message === "object") {
          var inner = n.message;
          if (!sender) sender = pickSender(inner) || sender;
          if (!thread) thread = pickThread(inner) || thread;
          if (!text) text = pickText(inner) || text;
          if (!details) details = pickSenderDetails(inner);
        }
        var mid = n.message_id || n.mid || (n.message && (n.message.message_id || n.message.mid)) || null;
        var seq = n.uq_seq_id || n.seq_id || (n.message && (n.message.uq_seq_id || n.message.seq_id)) || null;
        var voiceMediaUrl = pickVoiceMediaUrl(n) || (n.message ? pickVoiceMediaUrl(n.message) : null);
        var imageMediaUrl = pickImageMediaUrl(n) || (n.message ? pickImageMediaUrl(n.message) : null);
        if (imageMediaUrl && voiceMediaUrl) {
          imageMediaUrl = null;
        }
        // deduplica por messageId para evitar hits duplicados (outer + inner .message)
        var dedupKey = mid || seq || null;
        if (dedupKey && seenIds[dedupKey]) {
          // ja registramos este; se o atual tem campos novos, mescla
          var prev = seenIds[dedupKey];
          if (!prev.text && text) prev.text = String(text);
          if (!prev.senderId && sender) prev.senderId = String(sender);
          if (!prev.threadId && thread) prev.threadId = String(thread);
          if (!prev.senderName && details) {
            prev.senderName = details.name;
            prev.senderUsername = details.username;
          }
          if (!prev.voiceMediaUrl && voiceMediaUrl) prev.voiceMediaUrl = String(voiceMediaUrl);
          if (!prev.imageMediaUrl && imageMediaUrl) prev.imageMediaUrl = String(imageMediaUrl);
        } else {
          var entry = {
            senderId: sender ? String(sender) : null,
            threadId: thread ? String(thread) : null,
            text: text ? String(text) : null,
            typename: n.__typename || (n.message && n.message.__typename) || null,
            messageId: mid || null,
            seqId: seq ? String(seq) : null,
            senderName: details ? details.name : null,
            senderUsername: details ? details.username : null,
            voiceMediaUrl: voiceMediaUrl ? String(voiceMediaUrl) : null,
            imageMediaUrl: imageMediaUrl ? String(imageMediaUrl) : null,
          };
          results.push(entry);
          if (dedupKey) seenIds[dedupKey] = entry;
        }
      }
      for (var key in n) {
        if (!Object.prototype.hasOwnProperty.call(n, key)) continue;
        var v = n[key];
        if (v && typeof v === "object") walk(v);
      }
    })(obj);

    if (results.length > 0) return results;

    // fallback: busca plana pelos campos canonicos
    var flat = { senderId: null, threadId: null, text: null };
    (function walk2(n) {
      if (!n || typeof n !== "object") return;
      for (var key in n) {
        if (!Object.prototype.hasOwnProperty.call(n, key)) continue;
        var v = n[key];
        var lk = String(key).toLowerCase();
        if (typeof v === "string") {
          if ((lk === "text_body" || lk === "text" || lk === "message_text" || lk === "body" || lk === "snippet" || lk === "igd_snippet") && !flat.text) flat.text = v;
          if ((lk === "sender_id" || lk === "sender_fbid" || lk === "user_id" || lk === "actor_id") && !flat.senderId) flat.senderId = v;
          if ((lk === "thread_id" || lk === "thread_fbid" || lk === "threadkey" || lk === "thread_key") && !flat.threadId) flat.threadId = v;
        } else if (typeof v === "number" || typeof v === "bigint") {
          if ((lk === "sender_id" || lk === "sender_fbid" || lk === "user_id" || lk === "actor_id") && !flat.senderId) flat.senderId = String(v);
          if ((lk === "thread_id" || lk === "thread_fbid") && !flat.threadId) flat.threadId = String(v);
        } else if (v && typeof v === "object") {
          walk2(v);
        }
      }
    })(obj);
    return flat.text || flat.senderId ? [flat] : [];
  }

  // ---------------------------------------------------------------------------
  // Emit: console + CustomEvent + bridge Puppeteer
  // ---------------------------------------------------------------------------
  // Normaliza o shape do evento independente da origem (json/thrift).
  // Qualquer campo ausente vira null; strings sao coagidas; BigInts viram string.
  function normalizeDmEvent(raw) {
    function s(v) {
      if (v == null) return null;
      if (typeof v === "bigint") return v.toString();
      return String(v);
    }
    return {
      url: raw.url ? String(raw.url) : "",
      topic: raw.topic ? String(raw.topic) : "",
      senderId: s(raw.senderId),
      senderName: raw.senderName ? String(raw.senderName) : null,
      senderUsername: raw.senderUsername ? String(raw.senderUsername) : null,
      threadId: s(raw.threadId),
      text: raw.text ? String(raw.text) : "",
      messageId: s(raw.messageId),
      seqId: s(raw.seqId),
      typename: raw.typename ? String(raw.typename) : null,
      voiceMediaUrl: raw.voiceMediaUrl ? String(raw.voiceMediaUrl) : null,
      imageMediaUrl: raw.imageMediaUrl ? String(raw.imageMediaUrl) : null,
      timestamp: raw.timestamp || new Date().toISOString(),
      source: raw.source === "thrift" ? "thrift" : "json",
    };
  }

  function emit(raw) {
    var evt = normalizeDmEvent(raw);

    try {
      var who = evt.senderName || evt.senderUsername || evt.senderId || "?";
      console.log(
        LOG_PREFIX + " Remetente: " + who +
        (evt.senderId && who !== evt.senderId ? " (" + evt.senderId + ")" : "") +
        " | Mensagem: '" + evt.text + "'" +
        (evt.threadId ? " (thread " + evt.threadId + ")" : "")
      );
    } catch (_) {}

    // bridge para Puppeteer (exposeFunction) - manda a forma normalizada
    try {
      if (typeof window.__igDmTapEmit === "function") {
        window.__igDmTapEmit(evt);
      }
    } catch (_) {}

    // custom event na pagina - mantem o raw original (com tree/obj) para quem quiser
    try {
      window.dispatchEvent(new CustomEvent("__ig_dm_tap", { detail: raw }));
    } catch (_) {}
  }
})();

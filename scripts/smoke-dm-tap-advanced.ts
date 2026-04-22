/**
 * Smoke avancado: exercita caminhos criticos que o smoke basico nao cobre:
 *   T1) PUBLISH com QoS=1 (packetId 2 bytes) + Thrift plano
 *   T2) PUBLISH com payload Thrift comprimido via zlib/deflate (DecompressionStream real)
 *   T3) Dois pacotes MQTT concatenados no mesmo frame WebSocket
 *   T4) URL que NAO casa com URL_RE nao deve emitir nada
 *   T5) Blob como event.data (IG as vezes usa Blob)
 *
 * Rodar: npx ts-node --transpile-only scripts/smoke-dm-tap-advanced.ts
 */
import { DM_TAP_SOURCE } from "../src/browser/dm-tap.source";
import { deflateSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Thrift + MQTT encoders (identicos ao smoke basico, duplicados para isolamento)
// ---------------------------------------------------------------------------
const zigzag = (n: bigint): bigint => (n << 1n) ^ (n >> 63n);
const varintBig = (n: bigint): number[] => {
  const out: number[] = [];
  let v = n;
  while (true) {
    const low = Number(v & 0x7Fn);
    v >>= 7n;
    if (v === 0n) { out.push(low); return out; }
    out.push(low | 0x80);
  }
};
const varintNum = (n: number): number[] => varintBig(BigInt(n));

function encodeThriftSenderText(senderId: bigint, text: string): Uint8Array {
  const textBytes = Buffer.from(text, "utf-8");
  const bytes: number[] = [];
  bytes.push(0x16);                                   // field 1, I64
  bytes.push(...varintBig(zigzag(senderId)));
  bytes.push(0x18);                                   // field 2, BINARY
  bytes.push(...varintNum(textBytes.byteLength));
  bytes.push(...textBytes);
  bytes.push(0x00);                                   // STOP
  return new Uint8Array(bytes);
}

function encodeMqttPublish(
  topic: string,
  payload: Uint8Array,
  opts: { qos?: 0 | 1 | 2; packetId?: number } = {},
): Uint8Array {
  const qos = opts.qos ?? 0;
  const topicBytes = Buffer.from(topic, "utf-8");
  const variable: number[] = [];
  variable.push((topicBytes.byteLength >> 8) & 0xFF, topicBytes.byteLength & 0xFF);
  variable.push(...topicBytes);
  if (qos > 0) {
    const pid = opts.packetId ?? 1;
    variable.push((pid >> 8) & 0xFF, pid & 0xFF);
  }
  const body = [...variable, ...payload];
  const remaining: number[] = [];
  let rl = body.length;
  do {
    let b = rl & 0x7F;
    rl >>= 7;
    if (rl > 0) b |= 0x80;
    remaining.push(b);
  } while (rl > 0);
  const b0 = 0x30 | ((qos & 0x3) << 1);
  return new Uint8Array([b0, ...remaining, ...body]);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

// ---------------------------------------------------------------------------
// DecompressionStream polyfill minimo usando node:zlib (para o IIFE poder
// descomprimir payloads zlib no ambiente Node do teste).
// ---------------------------------------------------------------------------
class FakeDecompressionStream {
  format: string;
  private _chunks: Uint8Array[] = [];
  public readable: any;
  public writable: any;
  constructor(format: string) {
    this.format = format;
    const self = this;
    this.writable = {
      getWriter(): any {
        return {
          write(u8: Uint8Array): void { self._chunks.push(u8); },
          close(): void { self._finish(); },
        };
      },
    };
    this.readable = {
      getReader(): any {
        return {
          async read(): Promise<{ done: boolean; value?: Uint8Array }> {
            await self._donePromise;
            if (self._output.length === 0) return { done: true };
            const v = self._output.shift();
            return { done: false, value: v };
          },
        };
      },
    };
  }
  private _output: Uint8Array[] = [];
  private _resolveDone: () => void = () => {};
  private _donePromise: Promise<void> = new Promise<void>((r) => { this._resolveDone = r; });
  private _finish(): void {
    const zlib = require("node:zlib") as typeof import("node:zlib");
    const input = Buffer.concat(this._chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)));
    try {
      let out: Buffer;
      if (this.format === "deflate") out = zlib.inflateSync(input);
      else if (this.format === "deflate-raw") out = zlib.inflateRawSync(input);
      else if (this.format === "gzip") out = zlib.gunzipSync(input);
      else throw new Error("unsupported format " + this.format);
      this._output.push(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
    } catch (err) {
      // deixa _output vazio -> read() retorna done imediatamente
    }
    this._resolveDone();
  }
}

// ---------------------------------------------------------------------------
// Harness: instala o IIFE num novo "window" stub por teste e retorna os
// eventos emitidos via __igDmTapEmit.
// ---------------------------------------------------------------------------
async function runCase(
  name: string,
  wsUrl: string,
  frames: Array<Uint8Array | Blob>,
  opts: { withInflate?: boolean } = {},
): Promise<any[]> {
  const g = globalThis as any;

  // Limpa instalacao previa
  delete g.window;
  delete g.DecompressionStream;

  type Listener = (evt: { data: any }) => void;
  const listeners: Listener[] = [];

  class FakeWS {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    url: string;
    constructor(url: string) { this.url = url; }
    addEventListener(type: string, fn: Listener, _cap?: boolean): void {
      if (type === "message") listeners.push(fn);
    }
  }

  const emitted: any[] = [];
  const fakeWindow: any = {
    __igDmTapEmit: (e: any) => emitted.push(e),
    WebSocket: FakeWS,
    dispatchEvent: () => true,
  };
  g.window = fakeWindow;
  g.DecompressionStream = opts.withInflate ? FakeDecompressionStream : undefined;

  new Function(DM_TAP_SOURCE)();

  const Patched = fakeWindow.WebSocket;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _ws = new Patched(wsUrl);

  for (const frame of frames) {
    if (frame instanceof Uint8Array) {
      const ab = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
      for (const fn of listeners) fn({ data: ab });
    } else {
      for (const fn of listeners) fn({ data: frame });
    }
  }
  // espera tasks async (inflate, etc)
  await new Promise((r) => setTimeout(r, 300));

  console.log("[case]", name, "=> emitted", emitted.length);
  return emitted;
}

function assertEq<T>(label: string, actual: T, expected: T): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.error("  FAIL", label, "expected", e, "got", a);
    process.exitCode = 1;
  } else {
    console.log("  OK  ", label, "=", a);
  }
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // ---- T1 QoS=1 ----
  {
    const thrift = encodeThriftSenderText(999999999999n, "qos1 ok");
    const frame = encodeMqttPublish("/ig_realtime_sub", thrift, { qos: 1, packetId: 42 });
    const emitted = await runCase("T1 QoS=1", "wss://edge-chat.instagram.com/chat", [frame]);
    assertEq("count", emitted.length, 1);
    if (emitted[0]) {
      assertEq("senderId", emitted[0].senderId, "999999999999");
      assertEq("text", emitted[0].text, "qos1 ok");
      assertEq("topic", emitted[0].topic, "/ig_realtime_sub");
      assertEq("source", emitted[0].source, "thrift");
    }
  }

  // ---- T2 Thrift comprimido com zlib ----
  {
    const thrift = encodeThriftSenderText(777777777777n, "zlib comprimido funciona");
    const compressed = new Uint8Array(deflateSync(Buffer.from(thrift)));
    const frame = encodeMqttPublish("/ig_message_sync", compressed);
    const emitted = await runCase(
      "T2 zlib",
      "wss://edge-chat.instagram.com/chat",
      [frame],
      { withInflate: true },
    );
    assertEq("count", emitted.length, 1);
    if (emitted[0]) {
      assertEq("senderId", emitted[0].senderId, "777777777777");
      assertEq("text", emitted[0].text, "zlib comprimido funciona");
    }
  }

  // ---- T3 Dois PUBLISH concatenados ----
  {
    const a = encodeMqttPublish("/t_a", encodeThriftSenderText(111111111111n, "primeira"));
    const b = encodeMqttPublish("/t_b", encodeThriftSenderText(222222222222n, "segunda"));
    const merged = concat(a, b);
    const emitted = await runCase("T3 multi-pkt", "wss://edge-chat.instagram.com/chat", [merged]);
    assertEq("count", emitted.length, 2);
    if (emitted.length === 2) {
      assertEq("#0 sender", emitted[0].senderId, "111111111111");
      assertEq("#0 text", emitted[0].text, "primeira");
      assertEq("#1 sender", emitted[1].senderId, "222222222222");
      assertEq("#1 text", emitted[1].text, "segunda");
    }
  }

  // ---- T4 URL irrelevante: NAO deve instalar tap ----
  {
    const thrift = encodeThriftSenderText(333333333333n, "nao deve vazar");
    const frame = encodeMqttPublish("/whatever", thrift);
    const emitted = await runCase("T4 URL irrelevante", "wss://example.com/other", [frame]);
    assertEq("count", emitted.length, 0);
  }

  // ---- T5 Blob como event.data ----
  {
    const thrift = encodeThriftSenderText(555555555555n, "via blob");
    const frame = encodeMqttPublish("/ig_realtime_sub", thrift);
    // Node 22+ tem Blob global
    const blob = new Blob([frame]);
    const emitted = await runCase("T5 Blob", "wss://edge-chat.instagram.com/chat", [blob as any]);
    assertEq("count", emitted.length, 1);
    if (emitted[0]) {
      assertEq("senderId", emitted[0].senderId, "555555555555");
      assertEq("text", emitted[0].text, "via blob");
    }
  }

  if (process.exitCode) {
    console.error("\nSMOKE-ADVANCED FAIL");
  } else {
    console.log("\nSMOKE-ADVANCED OK");
  }
}

main().catch((err) => {
  console.error("SMOKE ERROR", err);
  process.exit(1);
});

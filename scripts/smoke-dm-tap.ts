/**
 * Smoke test offline do parser DM tap.
 * Constroi manualmente um frame MQTT PUBLISH contendo um payload Thrift Compact com:
 *   - field 1 (i64) = 123456789012 (senderId)
 *   - field 2 (binary/string) = "ola mundo do grampo"
 * Injeta window/TextDecoder/TextEncoder e roda o IIFE. Espera:
 *   console.log("[Grampo DM] Remetente: 123456789012 | Mensagem: 'ola mundo do grampo' ...")
 *   bridge __igDmTapEmit chamada com o evento.
 *
 * Rodar: npx ts-node scripts/smoke-dm-tap.ts
 */
import { DM_TAP_SOURCE } from "../src/browser/dm-tap.source";

function encodeThriftStruct(): Uint8Array {
  // Compact protocol:
  //  field1: delta=1, type=6 (I64) -> header byte = 0x16
  //     valor varint ZigZag de 123456789012n
  //  field2: delta=1, type=8 (BINARY) -> header byte = 0x18
  //     varint len + bytes UTF-8
  //  STOP = 0x00
  const senderId = 123456789012n;
  const text = "ola mundo do grampo";
  const textBytes = Buffer.from(text, "utf-8");

  const zigzag = (n: bigint): bigint => (n << 1n) ^ (n >> 63n);
  const varintBig = (n: bigint): number[] => {
    const out: number[] = [];
    let v = n;
    while (true) {
      const low = Number(v & 0x7Fn);
      v >>= 7n;
      if (v === 0n) {
        out.push(low);
        return out;
      }
      out.push(low | 0x80);
    }
  };
  const varintNum = (n: number): number[] => varintBig(BigInt(n));

  const bytes: number[] = [];
  // field 1: I64
  bytes.push(0x16);
  bytes.push(...varintBig(zigzag(senderId)));
  // field 2: BINARY
  bytes.push(0x18);
  bytes.push(...varintNum(textBytes.byteLength));
  bytes.push(...textBytes);
  // STOP
  bytes.push(0x00);
  return new Uint8Array(bytes);
}

function encodeMqttPublish(topic: string, payload: Uint8Array): Uint8Array {
  const topicBytes = Buffer.from(topic, "utf-8");
  const variable: number[] = [];
  variable.push((topicBytes.byteLength >> 8) & 0xFF, topicBytes.byteLength & 0xFF);
  variable.push(...topicBytes);
  // QoS 0 -> sem packetId
  const body = [...variable, ...payload];
  // Fixed header: type=3 (PUBLISH), qos=0, dup=0, retain=0 -> 0x30
  // Remaining length varint
  const remaining: number[] = [];
  let rl = body.length;
  do {
    let b = rl & 0x7F;
    rl >>= 7;
    if (rl > 0) b |= 0x80;
    remaining.push(b);
  } while (rl > 0);
  return new Uint8Array([0x30, ...remaining, ...body]);
}

async function run(): Promise<void> {
  const thriftPayload = encodeThriftStruct();
  // Pacote sem compressao (inflate vai falhar e devolver o buffer original)
  const mqttPacket = encodeMqttPublish("/ig_realtime_sub", thriftPayload);

  type MsgListener = (evt: { data: ArrayBuffer }) => void;
  const listeners: MsgListener[] = [];

  class FakeWS {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    url: string;
    constructor(url: string) { this.url = url; }
    addEventListener(type: string, fn: MsgListener, _useCapture?: boolean): void {
      if (type === "message") listeners.push(fn);
    }
  }

  const emitted: any[] = [];
  const fakeWindow: any = {
    __igDmTapEmit: (evt: any) => { emitted.push(evt); },
    WebSocket: FakeWS,
    dispatchEvent: () => true,
  };

  // Executa o IIFE com window injetado
  const g = globalThis as any;
  g.window = fakeWindow;
  g.DecompressionStream = undefined; // forca caminho "sem compressao"
  new Function(DM_TAP_SOURCE)();

  // O IIFE trocou window.WebSocket pelo PatchedWS. Simula uma conexao que casa a URL.
  const Patched = fakeWindow.WebSocket as any;
  const ws = new Patched("wss://edge-chat.instagram.com/chat?foo=bar");

  // Dispara o handler de captura com o frame binario
  const ab = mqttPacket.buffer.slice(
    mqttPacket.byteOffset,
    mqttPacket.byteOffset + mqttPacket.byteLength,
  );
  for (const fn of listeners) {
    fn({ data: ab });
  }
  // dar tempo para handler async terminar
  await new Promise((r) => setTimeout(r, 200));

  console.log("---");
  console.log("ws instance:", !!ws);
  console.log("emitted events:", emitted.length);
  console.log(JSON.stringify(emitted, null, 2));

  const ok =
    emitted.length === 1 &&
    emitted[0].senderId === "123456789012" &&
    emitted[0].text === "ola mundo do grampo" &&
    emitted[0].topic === "/ig_realtime_sub";

  if (!ok) {
    console.error("SMOKE FAIL");
    process.exit(1);
  }
  console.log("SMOKE OK");
}

run().catch((err) => {
  console.error("SMOKE ERROR", err);
  process.exit(1);
});

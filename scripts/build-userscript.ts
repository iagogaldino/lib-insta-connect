import fs from "node:fs";
import path from "node:path";
import { DM_TAP_SOURCE } from "../src/browser/dm-tap.source";

const HEADER = [
  "// ==UserScript==",
  "// @name         IG DM Tap PoC",
  "// @namespace    https://github.com/lib-insta-connect",
  "// @version      0.1.0",
  "// @description  Intercepta DMs do Instagram Web via monkey-patch do WebSocket + parser MQTT/Thrift.",
  "// @author       lib-insta-connect",
  "// @match        https://www.instagram.com/*",
  "// @match        https://*.instagram.com/*",
  "// @run-at       document-start",
  "// @grant        none",
  "// ==/UserScript==",
  "",
  "// AUTOGERADO a partir de src/browser/dm-tap.source.ts",
  "// Para editar, modifique a fonte e rode: npm run build:userscript",
  "",
].join("\n");

function main(): void {
  const outPath = path.resolve(__dirname, "..", "src", "browser", "dm-tap.user.js");
  const body = String(DM_TAP_SOURCE).trim() + "\n";
  const content = HEADER + body;
  fs.writeFileSync(outPath, content, "utf-8");
  console.log(`[build-userscript] wrote ${outPath} (${content.length} bytes)`);
}

main();

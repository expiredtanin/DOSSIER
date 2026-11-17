// [215] Zlib für EXR (ZIP) und PNG im Browser/Webview (Tauri, Electron): `pako`, synchron wie `node:zlib` der CLI.
// Gleiche Form wie `Codec` in `cyclesRender.ts`.

import { deflate, inflate } from "pako";
import type { Codec } from "./cyclesRender";

export const pakoCodec: Codec = {
  inflate: (d) => inflate(d),
  deflate: (d) => deflate(d, { level: 6 }),
};

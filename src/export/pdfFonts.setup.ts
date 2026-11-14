// Vitest-Setup: PDF-Schriften aus `public/fonts` lesen (in der App holt `fetch` sie, [208]).
import { existsSync, readFileSync } from "node:fs";
import { setPdfFontLoader } from "./pdfFonts";

setPdfFontLoader(async (url) => (existsSync(`public${url}`) ? new Uint8Array(readFileSync(`public${url}`)) : null));

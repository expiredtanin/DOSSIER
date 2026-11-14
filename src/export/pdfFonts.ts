// Schriften im PDF ([208], Abgabe-Review 14.11.): Inter und die im Projekt gewählten Familien aus `public/fonts`
// (SIL OFL, `TEXT_FONTS`) werden eingebettet — dieselben wie Bildschirm und SVG, nicht mehr die Standard-14
// von jsPDF (Helvetica/Times/Courier, nicht eingebettet, nur WinAnsi). jsPDF bettet nur TTF ein: die WOFF2-Dateien
// (untransformiert, `core/woff2.rs`) wandelt der Kern in SFNT um. Eingebettet wird je Dokument nur, was
// tatsächlich vorkommt (Familie × Schnitt); die gebündelten Dateien sind bereits Latin-Teilmengen (< 100 KB je
// Schnitt), jsPDF komprimiert sie im Strom. Kein Netzabruf: `fetch` auf App-eigene Dateien, in Node (CLI, Tests)
// über `setPdfFontLoader`.

import type { jsPDF } from "jspdf";
import { core } from "../engine/coreWasm";
import { TEXT_FONTS } from "../text/fontList";

/** Bytes einer gebündelten Schriftdatei (`/fonts/<slug>/<slug>-400-normal.woff2`); `null` = nicht verfügbar. */
export type PdfFontLoader = (url: string) => Promise<Uint8Array | null>;

const fetchLoader: PdfFontLoader = async (url) => {
  try {
    const r = await globalThis.fetch(url); // App-eigene Datei, kein Netzabruf (daher nicht `netFetch`)
    return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
  } catch {
    return null;
  }
};

let loader: PdfFontLoader = fetchLoader;
const fileCache = new Map<string, Promise<string | null>>();

/** Lader austauschen (CLI/Tests lesen aus `public/fonts`); ohne Argument zurück auf `fetch`. */
export function setPdfFontLoader(f?: PdfFontLoader): void {
  loader = f ?? fetchLoader;
  fileCache.clear();
}

export const PDF_DEFAULT_FONT = "Inter";
/** Familie für CSS-Allgemeinnamen im SVG (`serif`, `monospace`). */
const GENERIC: Record<string, string> = { serif: "Source Serif 4", monospace: "IBM Plex Mono" };

const STYLES = [
  { style: "normal", weight: 400, slant: "normal" },
  { style: "bold", weight: 700, slant: "normal" },
  { style: "italic", weight: 400, slant: "italic" },
  { style: "bolditalic", weight: 700, slant: "italic" },
] as const;

const slugOf = (family: string) => family.toLowerCase().replace(/\s+/g, "-");

/** Gebündelte Familie zu einem Namen (Gross-/Kleinschreibung egal, Anführungszeichen entfernt). */
export function bundledFamily(name: string): string | undefined {
  const n = name.trim().replace(/^["']|["']$/g, "").toLowerCase();
  return TEXT_FONTS.find((f) => f.toLowerCase() === n) ?? GENERIC[n];
}

/** Erste gebündelte Familie einer CSS-`font-family`-Liste, sonst Inter (Standard von Bildschirm und SVG). */
export function resolvePdfFamily(cssList: string | null | undefined): string {
  for (const part of (cssList ?? "").split(",")) {
    const f = bundledFamily(part);
    if (f) return f;
  }
  return PDF_DEFAULT_FONT;
}

/** TTF als Base64 (so erwartet es `addFileToVFS`); `null` bei fehlender Datei oder Umwandlungsfehler. */
function loadTtfBase64(url: string): Promise<string | null> {
  let p = fileCache.get(url);
  if (!p) {
    p = (async () => {
      const woff = await loader(url);
      if (!woff || woff.length === 0) return null;
      const sfnt = core().woff2_to_sfnt(woff);
      if (sfnt.length === 0) return null;
      let bin = "";
      for (let i = 0; i < sfnt.length; i += 0x8000) bin += String.fromCharCode(...sfnt.subarray(i, i + 0x8000));
      return btoa(bin);
    })();
    fileCache.set(url, p);
  }
  return p;
}

const registered = new WeakMap<jsPDF, Map<string, Promise<boolean>>>();
const ready = new WeakMap<jsPDF, Set<string>>();

/**
 * Familie im Dokument registrieren (je Dokument einmal): alle vier Schnitte, fehlende (Kursiv bei Manrope,
 * Outfit, Space Grotesk) ersatzweise mit dem Normalschnitt gleicher Stärke. `false` = Familie nicht ladbar
 * (dann bleibt der Aufrufer bei Helvetica).
 */
function ensurePdfFont(doc: jsPDF, family: string): Promise<boolean> {
  let m = registered.get(doc);
  if (!m) registered.set(doc, (m = new Map()));
  let p = m.get(family);
  if (!p) {
    p = (async () => {
      const slug = slugOf(family);
      const url = (weight: number, slant: string) => `/fonts/${slug}/${slug}-${weight}-${slant}.woff2`;
      let any = false;
      for (const s of STYLES) {
        const data = (await loadTtfBase64(url(s.weight, s.slant))) ?? (await loadTtfBase64(url(s.weight, "normal")));
        if (!data) continue;
        const file = `${slug}-${s.weight}-${s.slant}.ttf`;
        doc.addFileToVFS(file, data);
        doc.addFont(file, family, s.style);
        any = true;
      }
      return any;
    })();
    m.set(family, p);
  }
  return p;
}

/** Familien im Dokument registrieren und als verwendbar vormerken. */
export async function ensurePdfFonts(doc: jsPDF, families: Iterable<string>): Promise<void> {
  let ok = ready.get(doc);
  if (!ok) ready.set(doc, (ok = new Set()));
  for (const f of new Set(families)) if (await ensurePdfFont(doc, f)) ok.add(f);
}

/** Schrift für `doc.text`: die eingebettete Familie, sonst (Lader fehlt) die jsPDF-Helvetica. */
export function setPdfFont(doc: jsPDF, family: string, bold = false, italic = false): void {
  const style = bold && italic ? "bolditalic" : bold ? "bold" : italic ? "italic" : "normal";
  doc.setFont(ready.get(doc)?.has(family) ? family : "helvetica", style);
}

/** Hat das Dokument die Schrift eingebettet (sonst Helvetica, die nur WinAnsi kann)? */
export function hasPdfFont(doc: jsPDF, family: string = PDF_DEFAULT_FONT): boolean {
  return ready.get(doc)?.has(family) ?? false;
}

/**
 * Vor `doc.svg(...)`: setzt an jedem Text die aufgelöste gebündelte Familie (`font-family`-Liste → erste bekannte,
 * sonst Inter) und registriert diese im Dokument. svg2pdf wählt die Schrift sonst aus der Liste der
 * jsPDF-Schriften (Helvetica/Arial → Standard-Helvetica, nicht eingebettet).
 */
export async function prepareSvgFonts(doc: jsPDF, root: Element): Promise<void> {
  const used = new Set<string>([PDF_DEFAULT_FONT]);
  const nodes: Element[] = [root, ...Array.from(root.querySelectorAll("[font-family]"))];
  for (const el of nodes) {
    const css = el.getAttribute("font-family");
    if (css === null) continue;
    const f = resolvePdfFamily(css);
    el.setAttribute("font-family", f);
    used.add(f);
  }
  await ensurePdfFonts(doc, used);
  const ok = ready.get(doc);
  // Nicht ladbare Familien (kein Lader): zurück auf die Standardschrift, svg2pdf sucht sonst Unbekanntes.
  for (const el of nodes) {
    const f = el.getAttribute("font-family");
    if (f !== null && !ok?.has(f)) el.setAttribute("font-family", "Helvetica");
  }
  // Text ohne eigenes `font-family` (Wurzel hat keines): Inter als Vorgabe setzen.
  if (!root.hasAttribute("font-family")) root.setAttribute("font-family", ok?.has(PDF_DEFAULT_FONT) ? PDF_DEFAULT_FONT : "Helvetica");
}

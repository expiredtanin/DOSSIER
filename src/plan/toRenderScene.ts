// Render-Szene eines {@link Plan} für render2d (Browser über WASM/WebGPU, natives Fenster über
// `push_native_scene`) und für den Druck-/SVG-Export. Die Geometrie (Füllungen, Umrisse,
// Polylinien, Bögen, Linien samt Maler-Reihenfolge `z`, Verkettung, Kantennaht, Schraffur-Läufe,
// Zickzack/Motiv) rechnet der Kern direkt aus dem Plan-Puffer ([K3d], `src-tauri/core/src/
// plan_scene.rs`, über die Abschnitte aus `planParts.ts`) — ohne Umweg über `Primitive[]`. Hier
// bleibt das Text-Layout (Rich-Text-Zeilen + Live-Zusatzzeilen, die Glyphen rastert render2d)
// und das Durchreichen eingebetteter Bilder.
//
// Das Szenen-Objekt matcht 1:1 die serde-Structs render2d::types::Scene
// { fills:[{pts,color}], outlines:[{pts,color,widthMm,dash}],
//   polylines:[{pts,color,widthMm,dash}], arcs:[{center,from,to,r,color,widthMm,dash}],
//   lines:[{a,b,color,widthMm,dash}], texts:[{pos,content,sizeMm,color,align}] }
// mit Point = [x,y] (Meter) und Rgba = [r,g,b,a] (0..1). Bögen bleiben unvortesselliert
// (render2d zeichnet sie per SDF-Shader), Strichmuster (Papier-mm) werden durchgereicht.

import type { Plan } from "./generatePlan";
import { inGreyedRange } from "./generatePlan";
import { docToLines, wrapDocToLines } from "../text/renderHtml";
import { docFromText } from "../text/richText";
import { core } from "../engine/coreWasm";
import { greyedFlat, planParts, withPlanParts } from "./planParts";
import { planTextEntries } from "./planLazy";

export type RPoint = [number, number];
export type RRgba = [number, number, number, number];

export interface RFill {
  pts: RPoint[];
  color: RRgba;
  /**
   * Maler-Reihenfolge (kleiner = früher/unten). Der SVG-Pfad zeichnet die
   * Primitive strikt in Array-Reihenfolge (Füllung/Schraffur/Umriss
   * interleaved) — eine spätere Wand-Poché deckt z. B. den früheren
   * Raum-Umriss ab. Der native Renderer (`compile_scene`) stellt diese
   * Reihenfolge über die getrennten Szenen-Arrays hinweg wieder her.
   */
  z: number;
}
export interface ROutline {
  pts: RPoint[];
  color: RRgba;
  widthMm: number;
  dash?: number[] | null;
  /** Maler-Reihenfolge, siehe {@link RFill.z}. */
  z: number;
}
export interface RPolyline {
  pts: RPoint[];
  color: RRgba;
  widthMm: number;
  dash?: number[] | null;
  /** Maler-Reihenfolge, siehe {@link RFill.z}. */
  z: number;
  /**
   * true: `widthMm` trägt BILDSCHIRM-Einheiten (viewBox-px, zoom-skalierend)
   * statt Papier-mm. Aktuell von keinem Primitiv mehr gesetzt — auch die
   * Schraffur läuft inzwischen als gewöhnlicher Papier-mm-Stift (0.02 mm,
   * gleiche Tinte wie die Wand-Schichtfugen). Feld bleibt für etwaige
   * zukünftige Bildschirm-gekoppelte Linien erhalten.
   */
  widthScreen?: boolean;
}
export interface RArc {
  center: RPoint;
  from: RPoint;
  to: RPoint;
  r: number;
  color: RRgba;
  widthMm: number;
  dash?: number[] | null;
}
export interface RLine {
  a: RPoint;
  b: RPoint;
  color: RRgba;
  widthMm: number;
  dash?: number[] | null;
  /** Maler-Reihenfolge, siehe {@link RFill.z}. */
  z: number;
}
export type RTextAlign = "left" | "center" | "right";
/** EINE Textzeile; serde-kompatibel zu render2d::types::Text. */
export interface RText {
  /** Anker in Modell-Metern: X gemäß align, Y = Baseline der Zeile. */
  pos: RPoint;
  content: string;
  /** Schriftgröße in echten Papier-mm (skaliert mit Zoom wie Strichbreiten). */
  sizeMm: number;
  color: RRgba;
  align: RTextAlign;
}
/** Achsenparalleler Rahmen der Plan-Geometrie in Modell-Metern (siehe Plan.bounds). */
export interface RBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
/**
 * EIN eingebettetes Rasterbild (aus Drawing2D `{shape:"image"}`), achsparallel.
 * Wie `bounds` additiv/rückwirkungsfrei fürs GPU-Backend (s. dort) — der native
 * Renderer kennt keine Textur/kein Bild-Primitiv (GPU-Pfad wird bei Bildern im
 * Plan ohnehin deaktiviert, s. PlanView.tsx `useGpuRenderer`/`hasBgImages`);
 * `sceneToPrintSvg.ts` liest dieses Feld für den PDF-Export.
 */
export interface RImage {
  min: RPoint;
  max: RPoint;
  src: string;
  opacity: number;
}

export interface RScene {
  fills: RFill[];
  outlines: ROutline[];
  polylines: RPolyline[];
  arcs: RArc[];
  lines: RLine[];
  texts: RText[];
  images: RImage[];
  /**
   * Plan-Bounds (Modell-Meter) — additiv aus `Plan.bounds` übernommen, damit
   * Verbraucher (z. B. der Vektor-PDF-Serializer `sceneToPrintSvg.ts`) den
   * Plan-Inhalt zentrieren können, OHNE zusätzlich den `Plan` selbst zu
   * benötigen. Unbekannt für den Rust-Renderer (serde ignoriert überzählige
   * Felder ohne `deny_unknown_fields`), also rückwirkungsfrei fürs GPU-Backend.
   */
  bounds: RBounds;
}

/**
 * Fester Grauton gedimmter (greyed) Texte — gleicher Ton wie GREYED_COLOR in PlanView.tsx und
 * `GREY_RGB` im Kern (#8c8c8c ≈ 0.549).
 */
const GREY_RGB = 0.549;

/** Textfarbe gedimmt: auf den festen Grauton umfärben (Deckkraft bleibt). */
function greyedColor(col: RRgba, greyed: boolean | undefined): RRgba {
  return greyed ? [GREY_RGB, GREY_RGB, GREY_RGB, col[3]] : col;
}

/** 1 Punkt (pt) in Papier-Millimetern. */
const PT_TO_MM = 25.4 / 72;
/**
 * Default-Referenzmaßstab (1:100) für Aufrufer ohne Massstabskontext (WASM-
 * Viewport, `nativeSync.ts`) — identisch zu PlanView (`nRef`) im Display-
 * Modus: dort belegt 1 pt Schrift (1/72)·0.0254·100 Modell-Meter. Der native
 * Renderer rechnet im Anzeigemodus mit `paper_scale_n = 100`, damit ist
 * `sizeMm = pt · PT_TO_MM` exakt die Browser-Darstellung. Für Aufrufer MIT
 * Massstabskontext (z. B. PDF-Export) übersteuert `paperScaleN` diesen Default.
 */
const STAMP_DEFAULT_N = 100;

/** Wenige benannte Farben, die in Klassen/Defaults vorkommen können. */
const NAMED: Record<string, string> = {
  black: "#000000",
  white: "#ffffff",
  red: "#ff0000",
  none: "none",
  transparent: "none",
};

/** Hex/Named-Farbe → [r,g,b,a] in 0..1, oder null bei "none"/leer (Kern: `plan_scene::to_rgba`). */
function toRgba(input: string | undefined, alpha = 1): RRgba | null {
  if (!input) return null;
  let h = input.trim().toLowerCase();
  if (h === "none" || h === "transparent") return null;
  if (h[0] !== "#") {
    const mapped = NAMED[h];
    if (!mapped) return [0, 0, 0, alpha];
    if (mapped === "none") return null;
    h = mapped;
  }
  h = h.slice(1);
  // Kurzformen auf Langform expandieren (#rgb → #rrggbb, #rgba → #rrggbbaa).
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6 && h.length !== 8) return [0, 0, 0, alpha];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  // 8-stelliges Hex trägt den Alpha-Kanal selbst; sonst der Parameter.
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : alpha;
  if (![r, g, b, a].every((v) => Number.isFinite(v))) return [0, 0, 0, alpha];
  return [r, g, b, a];
}

/**
 * Textzeilen und eingebettete Bilder eines Plans in Zeichenreihenfolge. Layout wie im SVG-Pfad
 * (PlanView, case "text"): Rich-Text-Zeilen + Live-Zusatzzeilen, Block vertikal um den Anker
 * zentriert, Zeilenvorschub 1.3·Basisgröße; Einzeltexte (`drawingText`) top-down ab `at` mit
 * `heightM` als Basisgrösse. `paperScaleN` (1:N) rechnet Papier-mm in Modell-Meter um.
 */
export function planSceneTexts(plan: Plan, paperScaleN: number = STAMP_DEFAULT_N): { texts: RText[]; images: RImage[] } {
  const mmToM = paperScaleN / 1000; // Papier-mm → Modell-Meter beim gewählten Massstab.
  const texts: RText[] = [];
  const images: RImage[] = [];
  const ranges = plan.greyedRanges;
  // Nur die Text-/Bild-Einträge ([K3d], aus den Typ-Kennungen des Plan-Puffers).
  for (const { i, p } of planTextEntries(plan)) {
    if (p.kind === "text") {
      const greyed = p.greyed || inGreyedRange(ranges, i);
      const defCol = greyedColor(toRgba(p.color, 1) ?? [0.1, 0.1, 0.1, 1], greyed);
      // unitPerPt = PT_TO_MM → tspan.fontSize ist direkt die Papier-mm-Größe.
      const docLines = docToLines(p.doc, {
        x: 0,
        y: 0,
        lineHeight: 0,
        unitPerPt: PT_TO_MM,
        basePt: p.basePt,
        color: p.color,
      });
      const baseMm = p.basePt * PT_TO_MM;
      const flat: { content: string; sizeMm: number; color: RRgba; align: RTextAlign }[] = [];
      for (const line of docLines) {
        flat.push({
          // Runs einer Zeile werden zusammengelegt (ein Buffer je Zeile);
          // Größe/Farbe des größten bzw. ersten Runs gelten für die Zeile.
          content: line.tspans.map((t) => t.text).join(""),
          sizeMm: line.tspans.length ? Math.max(...line.tspans.map((t) => t.fontSize)) : baseMm,
          color: greyedColor(toRgba(line.tspans[0]?.fill ?? p.color, 1) ?? defCol, greyed),
          align: line.align,
        });
      }
      for (const line of p.extraLines) {
        flat.push({ content: line.text, sizeMm: baseMm * 0.8, color: defCol, align: line.align });
      }
      if (flat.length > 0) {
        const baseH = baseMm * mmToM; // Basisgröße in Modell-Metern, beim gewählten Massstab
        const lineGap = baseH * 1.3;
        const totalH = baseH + (flat.length - 1) * lineGap;
        flat.forEach((line, k) => {
          if (!line.content.trim()) return; // Leerzeile: nur Vorschub
          texts.push({
            // Baseline der Zeile k (Modell-Y nach oben, deshalb minus):
            // Browser: startY = c.y − H/2 + 0.8·fs (Bildschirm-Y nach unten).
            pos: [p.at.x, p.at.y + totalH / 2 - baseH * 0.8 - k * lineGap],
            content: line.content,
            sizeMm: line.sizeMm,
            color: line.color,
            align: line.align,
          });
        });
      }
    } else if (p.kind === "drawingText") {
      // Modellverankerter Einzeltext (Text-Werkzeug/DXF-Import): top-down ab `at`, `heightM`
      // (Modell-Meter) als Basisgrösse — massstabsfrei an der Modellgeometrie verankert.
      const greyed = p.greyed || inGreyedRange(ranges, i);
      const doc = p.doc ?? docFromText(p.text, p.marks ?? {});
      const defCol = greyedColor(toRgba(p.color, 1) ?? [0.1, 0.1, 0.1, 1], greyed);
      const unitPerPt = PT_TO_MM * mmToM; // pt (Run-Override) -> Papier-mm -> Modell-Meter.
      const basePt = unitPerPt > 0 ? p.heightM / unitPerPt : 0;
      const lineHeight = p.heightM * 1.25;
      const wrapWidthUnits = p.wrapWidth && p.wrapWidth > 0 ? p.wrapWidth : undefined;
      const docLines = wrapDocToLines(doc, {
        x: 0,
        y: 0,
        lineHeight,
        unitPerPt,
        basePt,
        color: p.color,
        ...(wrapWidthUnits ? { wrapWidthUnits } : {}),
      });
      let dy = 0;
      docLines.forEach((line, k) => {
        if (k > 0) dy += line.lineHeight;
        const content = line.tspans.map((t) => t.text).join("");
        if (!content.trim()) return;
        const sizeM = line.tspans.length ? Math.max(...line.tspans.map((t) => t.fontSize)) : p.heightM;
        texts.push({
          pos: [p.at.x, p.at.y - dy],
          content,
          sizeMm: unitPerPt > 0 ? sizeM / mmToM : sizeM,
          color: greyedColor(toRgba(line.tspans[0]?.fill ?? p.color, 1) ?? defCol, greyed),
          align: line.align,
        });
      });
    } else if (p.kind === "drawingImage") {
      // Eingebettetes Rasterbild — keine Rust-Textur (s. `RImage`); `sceneToPrintSvg.ts` liest es.
      images.push({ min: [p.min.x, p.min.y], max: [p.max.x, p.max.y], src: p.src, opacity: p.opacity });
    }
  }
  return { texts, images };
}

const ALIGN: Record<RTextAlign, number> = { left: 0, center: 1, right: 2 };
const textEncoder = new TextEncoder();

/** Leere render2d-Szene (nur Kopf), falls der Kern nichts liefern kann. */
function emptySceneBin(): Uint8Array {
  const b = new Uint8Array(48);
  b.set([0x44, 0x52, 0x32, 0x53], 0); // "DR2S"
  new DataView(b.buffer).setUint32(4, 1, true);
  return b;
}

/**
 * render2d-Szene (Binärformat v1, `render2d/src/scene_bin.rs`) für `set_scene_bin` bzw.
 * `push_native_scene`. Geometrie aus dem Kern, Texte aus {@link planSceneTexts};
 * `plan.greyedRanges` gelten wie materialisiertes `greyed`.
 */
export function planSceneBin(plan: Plan, paperScaleN: number = STAMP_DEFAULT_N): Uint8Array {
  const { texts } = planSceneTexts(plan, paperScaleN);
  const nums = new Float64Array(texts.length * 9);
  const strs = texts.map((t) => textEncoder.encode(t.content));
  let nBytes = 0;
  for (const s of strs) nBytes += s.length;
  const bytes = new Uint8Array(nBytes);
  let o = 0;
  texts.forEach((t, i) => {
    nums.set([t.pos[0], t.pos[1], t.sizeMm, t.color[0], t.color[1], t.color[2], t.color[3], ALIGN[t.align] ?? 0, strs[i].length], i * 9);
    bytes.set(strs[i], o);
    o += strs[i].length;
  });
  const greyed = greyedFlat(plan);
  const out = withPlanParts(planParts(plan), (segs) => core().plan_scene_bin(segs, greyed, nums, bytes));
  return out.length ? out : emptySceneBin();
}

type SceneGeometry = Pick<RScene, "fills" | "outlines" | "polylines" | "arcs" | "lines">;

/** Verlustfreie Kern-Szene (Format s. `plan_scene.rs`) → Szenen-Objekte (Feldreihenfolge wie früher). */
function decodeSceneF64(f: Float64Array): SceneGeometry {
  const out: SceneGeometry = { fills: [], outlines: [], polylines: [], arcs: [], lines: [] };
  if (f.length < 5) return out;
  let k = 5;
  const pts = (n: number): RPoint[] => {
    const r: RPoint[] = new Array(n);
    for (let i = 0; i < n; i++, k += 2) r[i] = [f[k], f[k + 1]];
    return r;
  };
  const color = (): RRgba => {
    const c: RRgba = [f[k], f[k + 1], f[k + 2], f[k + 3]];
    k += 4;
    return c;
  };
  /** −2 fehlt (undefined) · −1 null · n Werte. */
  const dash = (): number[] | null | undefined => {
    const n = f[k++];
    if (n === -2) return undefined;
    if (n === -1) return null;
    const d = Array.from(f.subarray(k, k + n));
    k += n;
    return d;
  };
  for (let i = 0; i < f[0]; i++) {
    const n = f[k];
    const z = f[k + 1];
    k += 2;
    const c = color();
    out.fills.push({ pts: pts(n), color: c, z });
  }
  for (let j = 0; j < 2; j++) {
    const list = j === 0 ? out.outlines : out.polylines;
    for (let i = 0; i < f[1 + j]; i++) {
      const n = f[k];
      const z = f[k + 1];
      const widthMm = f[k + 2];
      k += 3;
      const d = dash();
      const c = color();
      const p = pts(n);
      list.push(d === undefined ? { pts: p, color: c, widthMm, z } : { pts: p, color: c, widthMm, dash: d, z });
    }
  }
  for (let i = 0; i < f[3]; i++) {
    const r = f[k];
    const widthMm = f[k + 1];
    k += 2;
    const d = dash() ?? null;
    const c = color();
    const [center, from, to] = pts(3);
    out.arcs.push({ center, from, to, r, color: c, widthMm, dash: d });
  }
  for (let i = 0; i < f[4]; i++) {
    const z = f[k];
    const widthMm = f[k + 1];
    k += 2;
    const d = dash() ?? null;
    const c = color();
    const [a, b] = pts(2);
    out.lines.push({ a, b, color: c, widthMm, dash: d, z });
  }
  return out;
}

/**
 * Plan → Render-Szene als Objekte (Druck-/SVG-Export, `dossier-cli plan --format json`).
 * `paperScaleN` ist der Massstab-Nenner N (1:N) für die Zeilenlage der Texte (s.
 * {@link planSceneTexts}).
 */
export function planToRenderScene(plan: Plan, paperScaleN: number = STAMP_DEFAULT_N): RScene {
  const greyed = greyedFlat(plan);
  const geo = decodeSceneF64(withPlanParts(planParts(plan), (segs) => core().plan_scene_f64(segs, greyed)));
  const { texts, images } = planSceneTexts(plan, paperScaleN);
  return { ...geo, texts, images, bounds: { ...plan.bounds } };
}

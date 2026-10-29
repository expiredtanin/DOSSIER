// Render-Szene eines {@link Plan} für render2d (Browser über WASM/WebGPU, natives Fenster über
// `push_native_scene`) und für den Druck-/SVG-Export. Die Geometrie (Füllungen, Umrisse,
// Polylinien, Bögen, Linien samt Maler-Reihenfolge `z`, Verkettung, Kantennaht, Schraffur-Läufe,
// Zickzack/Motiv) rechnet der Kern direkt aus dem Plan-Puffer ([K3d], `src-tauri/core/src/
// plan_scene.rs`, über die Abschnitte aus `planParts.ts`) — ohne Umweg über `Primitive[]`, ebenso
// das Text-Layout (Rich-Text-Zeilen + Live-Zusatzzeilen beim Massstab, `plan_text.rs`; die Glyphen
// rastert render2d). Hier bleibt das Durchreichen eingebetteter Bilder.
//
// Das Szenen-Objekt matcht 1:1 die serde-Structs render2d::types::Scene
// { fills:[{pts,color}], outlines:[{pts,color,widthMm,dash}],
//   polylines:[{pts,color,widthMm,dash}], arcs:[{center,from,to,r,color,widthMm,dash}],
//   lines:[{a,b,color,widthMm,dash}], texts:[{pos,content,sizeMm,color,align}] }
// mit Point = [x,y] (Meter) und Rgba = [r,g,b,a] (0..1). Bögen bleiben unvortesselliert
// (render2d zeichnet sie per SDF-Shader), Strichmuster (Papier-mm) werden durchgereicht.

import type { Plan } from "./generatePlan";
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
 * Default-Referenzmaßstab (1:100) für Aufrufer ohne Massstabskontext (WASM-Viewport, `nativeSync.ts`)
 * — identisch zu PlanView (`nRef`) im Display-Modus; der native Renderer rechnet im Anzeigemodus
 * mit `paper_scale_n = 100`. Für Aufrufer MIT Massstabskontext (z. B. PDF-Export) übersteuert
 * `paperScaleN` diesen Default.
 */
const STAMP_DEFAULT_N = 100;

const ALIGNS: readonly RTextAlign[] = ["left", "center", "right"];

/**
 * Textzeilen eines Plans in Zeichenreihenfolge, gesetzt im Kern (`plan_text::scene_texts`): Raumstempel
 * = Rich-Text-Zeilen + Live-Zusatzzeilen, Block vertikal um den Anker zentriert, Vorschub 1.3·Basisgrösse;
 * Einzeltexte (`drawingText`) top-down ab `at` mit `heightM` als Basisgrösse, umbrochen auf die Spalte.
 * `paperScaleN` (1:N) rechnet Papier-mm in Modell-Meter um.
 */
function sceneTexts(plan: Plan, paperScaleN: number): RText[] {
  const greyed = greyedFlat(plan);
  const f = withPlanParts(planParts(plan), (segs) => core().plan_scene_texts(segs, greyed, paperScaleN));
  const n = f[0] ?? 0;
  const out: RText[] = new Array(n);
  let u = 1 + n * 9;
  for (let k = 0; k < n; k++) {
    const o = 1 + k * 9;
    const len = f[o + 8];
    let content = "";
    for (let j = 0; j < len; j += 8192) content += String.fromCharCode.apply(null, Array.from(f.subarray(u + j, u + Math.min(len, j + 8192))));
    u += len;
    out[k] = { pos: [f[o], f[o + 1]], content, sizeMm: f[o + 2], color: [f[o + 3], f[o + 4], f[o + 5], f[o + 6]], align: ALIGNS[f[o + 7]] ?? "left" };
  }
  return out;
}

/** Eingebettete Bilder des Plans (nur Text-/Bild-Einträge, kein Layout). */
function sceneImages(plan: Plan): RImage[] {
  const images: RImage[] = [];
  for (const { p } of planTextEntries(plan)) {
    if (p.kind === "drawingImage") images.push({ min: [p.min.x, p.min.y], max: [p.max.x, p.max.y], src: p.src, opacity: p.opacity });
  }
  return images;
}

/** Leere render2d-Szene (nur Kopf), falls der Kern nichts liefern kann. */
function emptySceneBin(): Uint8Array {
  const b = new Uint8Array(48);
  b.set([0x44, 0x52, 0x32, 0x53], 0); // "DR2S"
  new DataView(b.buffer).setUint32(4, 1, true);
  return b;
}

/**
 * render2d-Szene (Binärformat v1, `render2d/src/scene_bin.rs`) für `set_scene_bin` bzw.
 * `push_native_scene`. Geometrie und Texte (beim Massstab 1:`paperScaleN`) aus dem Kern;
 * `plan.greyedRanges` gelten wie materialisiertes `greyed`.
 */
export function planSceneBin(plan: Plan, paperScaleN: number = STAMP_DEFAULT_N): Uint8Array {
  const greyed = greyedFlat(plan);
  const out = withPlanParts(planParts(plan), (segs) => core().plan_scene_bin(segs, greyed, paperScaleN));
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
 * `paperScaleN` ist der Massstab-Nenner N (1:N) für die Zeilenlage der Texte.
 */
export function planToRenderScene(plan: Plan, paperScaleN: number = STAMP_DEFAULT_N): RScene {
  const greyed = greyedFlat(plan);
  const geo = decodeSceneF64(withPlanParts(planParts(plan), (segs) => core().plan_scene_f64(segs, greyed)));
  return { ...geo, texts: sceneTexts(plan, paperScaleN), images: sceneImages(plan), bounds: { ...plan.bounds } };
}

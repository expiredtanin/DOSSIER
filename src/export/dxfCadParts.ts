// Bausteine des Fachplaner-Exports ([C2], 28.10.): reine Hilfsfunktionen für `exportDxf.ts` —
// Schriftname aus CSS-Familie, Linientyp-Namen aus Strichmustern, Umrechnung von Plan-Primitiven in ein
// lokales Koordinatensystem (für Blöcke) und Papierformate. Keine Abhängigkeit vom Writer.

import type { Primitive } from "../plan/generatePlan";
import type { LineStyle, Vec2 } from "../model/types";

/** Erste Schriftfamilie aus einem CSS-`font-family`-Wert ohne Anführungszeichen; generische Familien/CSS-Variablen → null. */
export function fontNameOf(css: string | undefined | null): string | null {
  if (!css) return null;
  // `var(--font-ui, sans-serif)` enthält selbst ein Komma: vor dem Teilen entfernen.
  for (const raw of css.replace(/var\([^)]*\)/g, "").split(",")) {
    const name = raw.trim().replace(/^["']|["']$/g, "").trim();
    if (!name) continue;
    if (/^(sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|inherit|initial)$/i.test(name)) continue;
    return name;
  }
  return null;
}

/** Strichmuster (Papier-mm, an/aus/…) → DXF-Linientyp-Elemente in Modell-Metern (Strich +, Lücke −, Punkt 0). */
export function dashToLtypeMeters(dashMm: number[], scaleDenominator: number): number[] | null {
  let pat = dashMm.map((d) => (Number.isFinite(d) ? Math.max(0, d) : 0));
  if (pat.length === 0 || pat.every((d) => d === 0)) return null;
  if (pat.length % 2 === 1) pat = pat.concat(pat);
  const k = scaleDenominator / 1000;
  const out: number[] = [];
  for (let i = 0; i < pat.length; i++) {
    const len = pat[i] * k;
    out.push(i % 2 === 0 ? len : -Math.max(len, 1e-6));
  }
  // Eine Lücke von 0 ergäbe ein Muster ohne Unterbrechung; mindestens 1 µm.
  return out;
}

/** Zahl für Namen: höchstens 2 Nachkommastellen, ohne Nullen am Ende. */
function n2(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * Name des Linientyps zu einem Strichmuster: der Name des Projekt-Linienstils mit demselben Muster, sonst
 * `DOSSIER_STRICH_<an>_<aus>…` (Papier-mm).
 */
export function ltypeNameFor(dashMm: number[], styles: readonly LineStyle[]): string {
  const same = (a: number[], b: number[]) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  const hit = styles.find((s) => s.dash && s.dash.length > 0 && (s.kind ?? "dash") === "dash" && same(s.dash, dashMm));
  if (hit && hit.name.trim()) return hit.name.trim();
  return `DOSSIER_STRICH_${dashMm.map(n2).join("_")}`;
}

// ── Lokales Koordinatensystem (Blöcke) ────────────────────────────────────────

/** Abbildung Modell → blocklokal: Verschiebung `-origin`, Drehung `-rot`, Skalierung `1/scale`. */
export interface LocalFrame {
  origin: Vec2;
  /** Drehung des Blocks im Modell (Radiant). */
  rot: number;
  scale: number;
}

function toLocal(f: LocalFrame, p: Vec2): Vec2 {
  const c = Math.cos(f.rot);
  const s = Math.sin(f.rot);
  const dx = p.x - f.origin.x;
  const dy = p.y - f.origin.y;
  return { x: (dx * c + dy * s) / f.scale, y: (-dx * s + dy * c) / f.scale };
}

/** Primitive im lokalen System des Blocks (nur Geometrie-Arten, die in Blöcken vorkommen); andere → null. */
export function primitiveToLocal(p: Primitive, f: LocalFrame): Primitive | null {
  const rotDeg = (f.rot * 180) / Math.PI;
  switch (p.kind) {
    case "line":
      return { ...p, a: toLocal(f, p.a), b: toLocal(f, p.b), motif: undefined, zigzag: p.zigzag && { amplitude: p.zigzag.amplitude / f.scale, wavelength: p.zigzag.wavelength / f.scale } };
    case "arc":
      return { ...p, center: toLocal(f, p.center), from: toLocal(f, p.from), to: toLocal(f, p.to), r: p.r / f.scale };
    case "polygon":
      return { ...p, pts: p.pts.map((q) => toLocal(f, q)), hatch: { ...p.hatch, angle: p.hatch.angle - rotDeg } };
    case "drawingCircle":
      return { ...p, center: toLocal(f, p.center), r: p.r / f.scale };
    case "drawingArc":
      return { ...p, center: toLocal(f, p.center), r: p.r / f.scale, a0: p.a0 - f.rot, a1: p.a1 - f.rot };
    case "drawingText":
      return { ...p, at: toLocal(f, p.at), heightM: p.heightM / f.scale, angle: p.angle - f.rot, wrapWidth: p.wrapWidth && p.wrapWidth / f.scale };
    default:
      return null;
  }
}

/** Schlüssel gleicher lokaler Geometrie: Zahlen auf 1 mm gerundet (Blöcke teilen sich nur identische Inhalte). */
export function roundKey(nums: readonly number[]): string {
  let out = "";
  for (const v of nums) out += `${Math.round(v * 1000)},`;
  return out;
}

// ── Papierbereich ────────────────────────────────────────────────────────────

/** Papierformate (mm, quer) in aufsteigender Grösse. */
const PAPER_SIZES: [string, number, number][] = [
  ["A4", 297, 210],
  ["A3", 420, 297],
  ["A2", 594, 420],
  ["A1", 841, 594],
  ["A0", 1189, 841],
];

/**
 * Papier und Ansichtsfenster für einen Ausschnitt der Grösse `w` × `h` Meter im Massstab 1:`scale`:
 * kleinstes A-Format (quer, sonst hoch), das den Ausschnitt mit `margin` mm Rand aufnimmt; ist keines
 * gross genug, ein Sonderformat in Vielfachen von 10 mm. Das Fenster füllt das Papier abzüglich Rand.
 */
export function paperFor(
  w: number,
  h: number,
  scale: number,
  margin = 10,
): { paperW: number; paperH: number; vpW: number; vpH: number; name: string } {
  const needW = (w * 1000) / scale + 2 * margin;
  const needH = (h * 1000) / scale + 2 * margin;
  for (const [name, pw, ph] of PAPER_SIZES) {
    if (needW <= pw && needH <= ph) return { paperW: pw, paperH: ph, vpW: pw - 2 * margin, vpH: ph - 2 * margin, name };
    if (needW <= ph && needH <= pw) return { paperW: ph, paperH: pw, vpW: ph - 2 * margin, vpH: pw - 2 * margin, name };
  }
  const pw = Math.ceil(needW / 10) * 10;
  const ph = Math.ceil(needH / 10) * 10;
  return { paperW: pw, paperH: ph, vpW: pw - 2 * margin, vpH: ph - 2 * margin, name: "Sonder" };
}

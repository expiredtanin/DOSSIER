// Echtes Font-Metrik-Measuring (Canvas) für die Content-Schrift (`--font-ui`)
// — löst den Rest-Versatz zwischen den Inline-Text-Editoren (PlanView/
// LayoutSheet) und dem statischen SVG-Text, der bei einer reinen
// "heightM ≈ Ascent"-Näherung übrig bleibt (Ascent/Zeilenabstand variieren
// stark je Font/Browser, typischerweise 70–90 % der Schriftgrösse — zu
// ungenau für Pixel-Deckung). Ergebnis ist GRÖSSEN-INVARIANT (ein
// Metrik-Verhältnis), daher einmalig gemessen und gecacht.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

/** Verhältnis-Ergebnis, unabhängig von der tatsächlichen Schriftgrösse. */
export interface FontMetricRatios {
  /** Baseline → Oberkante der Zeilen-Box (Ascent + halber "Durchschuss"
   *  bei `lineHeightMultiplier`), als Vielfaches der Schriftgrösse. Das ist
   *  der Wert, den die Inline-Editoren als "Abstand Baseline → Box-Oberkante"
   *  brauchen (ersetzt die grobe `heightM`-als-Ascent-Näherung). */
  baselineFromTop: number;
}

/** Zeilenabstand-Vielfaches für gezeichneten Text, EINE Quelle für alle
 *  Verbraucher (primitives.tsx "drawingText" fontSize*1.25, PlanView.tsx
 *  Inline-Editor-Anker UND dessen CSS `line-height` in styles.css
 *  `.planview-inline-text .rt-surface` — alle MÜSSEN denselben Wert verwenden, sonst driften
 *  Editor-Position und späteres Rendering wieder auseinander). */
export const TEXT_LINE_HEIGHT_MULT = 1.25;

const cache = new Map<string, FontMetricRatios>();

/** Fallback ohne Canvas (praktisch nie — die App läuft nur im Browser). */
const FALLBACK: FontMetricRatios = { baselineFromTop: 0.9 };

/**
 * Misst `baselineFromTop` für die aktuelle `--font-ui`-Schrift bei einem
 * gegebenen `lineHeightMultiplier` (muss zum CSS `line-height` der
 * Editor-Fläche passen, s. `.planview-inline-text .rt-surface`). Gecacht je
 * `lineHeightMultiplier` (Font-Family ändert sich zur Laufzeit nicht).
 */
export function contentFontBaselineFromTop(lineHeightMultiplier: number): number {
  const key = String(lineHeightMultiplier);
  const cached = cache.get(key);
  if (cached) return cached.baselineFromTop;

  let result = FALLBACK;
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    const fam =
      getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim() ||
      "Helvetica, Arial, sans-serif";
    if (ctx) {
      const size = 200; // gross gewählt für Mess-Präzision, Ergebnis ist ein Verhältnis
      ctx.font = `${size}px ${fam}`;
      // "Hxg": Grossbuchstabe (Ascent) + x-Höhe + Unterlänge (Descent) — deckt
      // die für Ascent/Descent relevanten Glyphen-Extreme ab.
      const m = ctx.measureText("Hxg");
      const ascent = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent ?? size * 0.8;
      const descent = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent ?? size * 0.2;
      const ascentRatio = ascent / size;
      const descentRatio = descent / size;
      // CSS-Halbdurchschuss: zusätzlicher Platz ÜBER dem Ascent, wenn
      // `line-height` grösser ist als die natürliche Font-Zeilenhöhe (kann bei
      // sehr knappem line-height auch negativ werden — dann ragt der Ascent
      // über die Zeilen-Box hinaus, die Formel bleibt trotzdem gültig).
      const halfLeadingRatio = (lineHeightMultiplier - (ascentRatio + descentRatio)) / 2;
      result = { baselineFromTop: ascentRatio + halfLeadingRatio };
    }
  } catch {
    result = FALLBACK;
  }
  cache.set(key, result);
  return result.baselineFromTop;
}

/** Nur für Tests: setzt den Cache zurück (Canvas-Messung ist umgebungsabhängig). */
export function resetFontMetricsCacheForTest(): void {
  cache.clear();
}

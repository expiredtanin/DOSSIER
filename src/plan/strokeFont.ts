// Kompakte Einstrich-Vektorschrift für den nativen 2D-Viewport (render2d hat
// keinen Textrenderer). Jedes Glyph ist eine Liste von Strichen (Polylinien) in
// einem Raster: x in [0..5], y in [0..7], BASISLINIE y=0, Versalhöhe y=7, y nach
// OBEN (passt zu render2d, dessen to_screen y spiegelt). Kleinbuchstaben werden
// (erste Fassung) als Versalien gezeichnet. Ausgabe der Layout-Funktion sind
// Modell-Meter-Polylinien, die 1:1 in die render2d-Szene fließen.

export type StrokePoint = [number, number];
export type Glyph = { w: number; strokes: StrokePoint[][] };

// Rasterhöhe (Versalhöhe) in Font-Einheiten.
const CAP = 7;
// Standard-Vorschub (Glyphbreite inkl. Seitenabstand) in Font-Einheiten.
const ADV = 6;

// Hilfen zum knappen Definieren.
const g = (w: number, ...strokes: StrokePoint[][]): Glyph => ({ w, strokes });

// Einstrich-Glyphen (bewusst geradlinig/einfach, gut lesbar).
const FONT: Record<string, Glyph> = {
  " ": g(ADV),
  A: g(ADV, [[0, 0], [2.5, 7], [5, 0]], [[1, 3], [4, 3]]),
  B: g(ADV, [[0, 0], [0, 7], [3.5, 7], [4.5, 5.5], [3.5, 4], [0, 4]], [[3.5, 4], [4.7, 2], [3.5, 0], [0, 0]]),
  C: g(ADV, [[5, 6], [3, 7], [1, 6], [0, 3.5], [1, 1], [3, 0], [5, 1]]),
  D: g(ADV, [[0, 0], [0, 7], [3, 7], [5, 4.5], [5, 2.5], [3, 0], [0, 0]]),
  E: g(ADV, [[5, 7], [0, 7], [0, 0], [5, 0]], [[0, 3.5], [3.5, 3.5]]),
  F: g(ADV, [[5, 7], [0, 7], [0, 0]], [[0, 3.5], [3.5, 3.5]]),
  G: g(ADV, [[5, 6], [3, 7], [1, 6], [0, 3.5], [1, 1], [3, 0], [5, 1], [5, 3], [3, 3]]),
  H: g(ADV, [[0, 0], [0, 7]], [[5, 0], [5, 7]], [[0, 3.5], [5, 3.5]]),
  I: g(3, [[1.5, 0], [1.5, 7]]),
  J: g(ADV, [[4, 7], [4, 1.5], [3, 0], [1, 0], [0, 1.5]]),
  K: g(ADV, [[0, 0], [0, 7]], [[5, 7], [0, 3.5], [5, 0]]),
  L: g(ADV, [[0, 7], [0, 0], [5, 0]]),
  M: g(7, [[0, 0], [0, 7], [3.5, 3], [7, 7], [7, 0]]),
  N: g(ADV, [[0, 0], [0, 7], [5, 0], [5, 7]]),
  O: g(ADV, [[1, 6], [0, 3.5], [1, 1], [3, 0], [4.5, 1.5], [5, 3.5], [4, 6], [3, 7], [1, 6]]),
  P: g(ADV, [[0, 0], [0, 7], [3.5, 7], [5, 5.5], [3.5, 4], [0, 4]]),
  Q: g(ADV, [[1, 6], [0, 3.5], [1, 1], [3, 0], [5, 2], [5, 4], [3, 7], [1, 6]], [[3, 2], [5, 0]]),
  R: g(ADV, [[0, 0], [0, 7], [3.5, 7], [5, 5.5], [3.5, 4], [0, 4]], [[3, 4], [5, 0]]),
  S: g(ADV, [[5, 6], [3, 7], [1, 6.5], [1, 4.5], [4, 3], [4.5, 1.5], [3, 0], [0.5, 0.8]]),
  T: g(ADV, [[0, 7], [5, 7]], [[2.5, 7], [2.5, 0]]),
  U: g(ADV, [[0, 7], [0, 1.5], [1.5, 0], [3.5, 0], [5, 1.5], [5, 7]]),
  V: g(ADV, [[0, 7], [2.5, 0], [5, 7]]),
  W: g(8, [[0, 7], [1.5, 0], [4, 4], [6.5, 0], [8, 7]]),
  X: g(ADV, [[0, 0], [5, 7]], [[0, 7], [5, 0]]),
  Y: g(ADV, [[0, 7], [2.5, 3.5], [5, 7]], [[2.5, 3.5], [2.5, 0]]),
  Z: g(ADV, [[0, 7], [5, 7], [0, 0], [5, 0]]),
  "0": g(ADV, [[1, 6], [0, 3.5], [1, 1], [3, 0], [4.5, 1.5], [5, 3.5], [4, 6], [3, 7], [1, 6]], [[1, 1], [4, 6]]),
  "1": g(4, [[1, 5.5], [2.5, 7], [2.5, 0]], [[1, 0], [4, 0]]),
  "2": g(ADV, [[0, 5.5], [1, 7], [3.5, 7], [5, 5.5], [4, 3.5], [0, 0], [5, 0]]),
  "3": g(ADV, [[0, 6.5], [2, 7], [4.5, 5.5], [3, 4], [4.5, 2], [3, 0], [1, 0.3]]),
  "4": g(ADV, [[3.5, 0], [3.5, 7], [0, 2.5], [5, 2.5]]),
  "5": g(ADV, [[5, 7], [1, 7], [0.8, 4], [3, 4.5], [4.5, 3], [3.5, 0.3], [1, 0], [0, 1]]),
  "6": g(ADV, [[4.5, 6], [3, 7], [1, 6], [0, 3], [0.5, 1], [2.5, 0], [4.5, 1], [4.8, 2.8], [3, 4], [1, 3.5], [0.2, 2.5]]),
  "7": g(ADV, [[0, 7], [5, 7], [2, 0]]),
  "8": g(ADV, [[2.5, 4], [1, 5.5], [2.5, 7], [4, 5.5], [2.5, 4], [1, 2], [2.5, 0], [4, 2], [2.5, 4]]),
  "9": g(ADV, [[4.8, 4.5], [4, 6.5], [2, 7], [0.5, 5.5], [1, 3.5], [3.5, 3], [5, 4]]),
  ".": g(3, [[1, 0], [1.5, 0.4]]),
  ",": g(3, [[1.5, 0.6], [0.8, -0.8]]),
  ":": g(3, [[1.4, 0], [1.6, 0.4]], [[1.4, 3.5], [1.6, 3.9]]),
  "·": g(3, [[1, 3.4], [1.6, 3.8]]),
  "-": g(ADV, [[1, 3.5], [4, 3.5]]),
  "/": g(ADV, [[0, 0], [5, 7]]),
  "(": g(3, [[2.5, 7], [1, 5], [1, 2], [2.5, 0]]),
  ")": g(3, [[0.5, 7], [2, 5], [2, 2], [0.5, 0]]),
  "%": g(7, [[0, 0], [7, 7]], [[1, 6], [2, 7], [1, 5.5], [0, 6.5], [1, 6]], [[5, 1.5], [6, 2.5], [5, 0.5], [4, 1.5], [5, 1.5]]),
  "²": g(4, [[0, 5.5], [1, 7], [2.8, 6], [1.5, 4.8], [0, 4], [3, 4]]),
  "°": g(4, [[1.5, 5.5], [0.7, 6.2], [1.5, 7], [2.3, 6.2], [1.5, 5.5]]),
};

/**
 * Zeichnet eine Zeile Text (Großschreibung) in Font-Einheiten ab (0,0) startend,
 * baseline y=0, x nach rechts. Liefert Polylinien in Font-Einheiten + Gesamtbreite.
 */
export function layoutLine(text: string): { strokes: StrokePoint[][]; width: number } {
  const strokes: StrokePoint[][] = [];
  let cx = 0;
  for (const raw of text) {
    const ch = FONT[raw] ? raw : raw.toUpperCase();
    const gl = FONT[ch] ?? FONT[" "];
    for (const s of gl.strokes) {
      strokes.push(s.map(([x, y]) => [x + cx, y] as StrokePoint));
    }
    cx += (gl.w + 1);
  }
  // letzte Zusatzbreite (Seitenabstand) wieder abziehen.
  const width = Math.max(0, cx - 1);
  return { strokes, width };
}

export { CAP, ADV };

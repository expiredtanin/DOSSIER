// Modulares Linien-Segment-System — die Brücke zwischen dem Segment-Editor
// (ResourceManager) und der Datenbasis `LineStyle.dash` (alternierend AN/AUS in
// mm, loopend). Eine musterbasierte Linie ist eine geordnete, loopende Folge aus
// drei Segment-Arten:
//   • "dash" — ein sichtbarer Strich (Länge in mm > 0),
//   • "dot"  — ein Punkt (AN-Segment der Länge 0; wird mit runder Strichkappe zum
//              Dot, siehe dashHasDot + `stroke-linecap: round` in den Renderern),
//   • "gap"  — eine Lücke (AUS-Länge in mm).
// Die letzte Lücke der Folge ist die „Schluss-Lücke" (Ende des Loops bis zum
// Start des nächsten). Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

/** Eine Segment-Art des Linien-Musters. */
export type LineSegmentType = "dash" | "dot" | "gap";

/** Ein Segment der Muster-Folge (Länge in mm; bei „dot" ignoriert/0). */
export interface LineSegment {
  type: LineSegmentType;
  /** Länge in mm (Papier). Bei „dot" stets 0. */
  length: number;
}

/**
 * Bildet eine geordnete Segment-Folge auf ein `dash`-Array ab
 * (`[on, off, on, off, …]` in mm; ein `on`-Wert von 0 ⇒ Punkt). Da SVG-Dash
 * strikt AN/AUS alterniert, werden 0-Längen eingefügt bzw. gleichartige
 * Nachbarn zusammengefasst, um die Alternation zu wahren:
 *   • zwei AN-Segmente in Folge (z. B. Strich·Punkt) ⇒ 0-Lücke dazwischen,
 *   • zwei Lücken in Folge ⇒ zur vorigen Lücke addiert.
 * Das Muster endet stets auf einer AUS-Länge (gerade Array-Länge), damit es
 * sauber loopt. Leere Folge ⇒ `null` (Volllinie).
 */
export function segmentsToDash(segments: LineSegment[]): number[] | null {
  const dash: number[] = [];
  for (const seg of segments) {
    const on = seg.type !== "gap";
    const value = seg.type === "dot" ? 0 : Math.max(0, seg.length);
    const nextSlotIsOn = dash.length % 2 === 0;
    if (on) {
      if (!nextSlotIsOn) dash.push(0); // 0-Lücke, um die AN/AUS-Alternation zu wahren
      dash.push(value);
    } else {
      if (nextSlotIsOn) {
        if (dash.length > 0) {
          // zwei Lücken in Folge → in die vorherige Lücke einrechnen
          dash[dash.length - 1] += value;
          continue;
        }
        dash.push(0); // führende Lücke: 0-Strich davor
      }
      dash.push(value);
    }
  }
  // Muster muss mit einer AUS-Länge enden (gerade Länge), damit es sauber loopt.
  if (dash.length % 2 === 1) dash.push(0);
  return dash.length ? dash : null;
}

/**
 * Kehrt `segmentsToDash` um: ein `dash`-Array (`[on, off, …]`) wird zur
 * Segment-Folge. Gerade Indizes sind AN (0 ⇒ Punkt, sonst Strich), ungerade
 * Indizes sind Lücken. `null`/leer ⇒ leere Folge (Volllinie).
 */
export function dashToSegments(dash: number[] | null | undefined): LineSegment[] {
  if (!dash) return [];
  return dash.map((v, i) =>
    i % 2 === 0
      ? { type: v === 0 ? "dot" : "dash", length: v }
      : { type: "gap", length: v },
  );
}

/**
 * Enthält das Strichmuster einen Punkt (ein AN-Segment der Länge 0)? Solche
 * Linien müssen mit runder Strichkappe (`stroke-linecap: round`) gezeichnet
 * werden, damit die 0-Längen-Segmente als Dots sichtbar werden.
 */
export function dashHasDot(dash: number[] | null | undefined): boolean {
  return !!dash && dash.some((v) => v === 0);
}

/** Schnell-Presets für die drei Grundtypen (+ Strich-Punkt), Längen in mm. */
export const LINE_PRESETS = {
  /** Volllinie — durchgezogen. */
  solid: null as number[] | null,
  /** Strichlinie. */
  dash: [3, 2] as number[] | null,
  /** Punktlinie (Dots). */
  dot: [0, 2] as number[] | null,
  /** Strich-Punkt-Linie. */
  dashDot: [4, 2, 0, 2] as number[] | null,
} as const;

export type LinePresetKey = keyof typeof LINE_PRESETS | "custom";

/** Erkennt, welchem Preset ein `dash`-Array entspricht (sonst „custom"). */
export function presetOfDash(dash: number[] | null | undefined): LinePresetKey {
  const eq = (a: number[] | null, b: number[] | null): boolean => {
    if (a === null || b === null) return a === b;
    return a.length === b.length && a.every((v, i) => v === b[i]);
  };
  const d = dash ?? null;
  if (eq(d, LINE_PRESETS.solid)) return "solid";
  if (eq(d, LINE_PRESETS.dash)) return "dash";
  if (eq(d, LINE_PRESETS.dot)) return "dot";
  if (eq(d, LINE_PRESETS.dashDot)) return "dashDot";
  return "custom";
}

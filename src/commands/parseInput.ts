// Koordinaten- & Numerik-Parser (docs/design/rhino-command-system.md §2.7).
//
// Parst rohen Command-Line-Text TOLERANT (Komma/Space/Semikolon als Trenner) zu
// einer Discriminated Union; die Engine löst die punktbezogenen Varianten mit
// `lastPoint` + Cursor-Richtung zu einem konkreten Modellpunkt auf.
//
// Unterstützte Formen:
//   `5,3`        → absolut X,Y
//   `5,3,2`      → absolut X,Y (Z ignoriert, 2D)
//   `r5,3`       → relativ zum letzten Punkt
//   `5<45`       → polar: Distanz 5 unter 45° vom letzten Punkt
//   `<45`        → nur Winkel-Constraint; Distanz folgt Maus/Zahl
//   `5`          → nackte Zahl = Distanz-Lock entlang Cursor-/Constraint-Richtung
//   sonst        → Roh-Text (Befehlsname / Optionsbuchstabe) — von der Engine geroutet
//
// Reine Funktionen, kein Zustand. Winkel in Grad, gegen die +X-Achse, CCW positiv
// (passend zur Y-flip-freien Modellkonvention: +Y ist „oben").

import type { Vec2 } from "../model/types";
import { lengthFromDisplay, pointFromDisplay, yFromDisplay, type DisplayUnits } from "../tools/displayUnits";

/** Geparste, noch nicht aufgelöste Eingabe. */
export type ParsedInput =
  | { kind: "absolute"; point: Vec2 } // 5,3
  | { kind: "relative"; delta: Vec2 } // r5,3
  | { kind: "polar"; dist: number; angleDeg: number } // 5<45
  | { kind: "angle"; angleDeg: number } // <45
  | { kind: "distance"; value: number } // 5  (nackte Zahl)
  | { kind: "text"; text: string }; // Befehlsname / Option / unparsbar

const DEG = Math.PI / 180;

/** Tolerant: Zahl aus einem Token (erlaubt führendes +, Dezimalpunkt/-komma). */
function parseNumber(raw: string): number | null {
  const s = raw.trim().replace(",", "."); // Hilfsfall: einzelnes Dezimalkomma
  if (s === "" || s === "+" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Zerlegt eine Koordinatenliste (X,Y[,Z]) tolerant in Zahlen. Trenner: Komma,
 * Semikolon oder Whitespace. Liefert null, wenn nicht ≥2 valide Zahlen vorliegen.
 * (Wir nutzen die echten Trenner, daher kollidiert das NICHT mit dem
 * Dezimalkomma-Hilfsfall der nackten Zahl.)
 */
function parseCoordList(raw: string): number[] | null {
  const parts = raw
    .trim()
    .split(/[\s,;]+/)
    .filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = Number(p.trim());
    if (!Number.isFinite(n)) return null;
    nums.push(n);
  }
  return nums;
}

/**
 * Parst rohen Command-Line-Text zu einer {@link ParsedInput}. Befehlsnamen/
 * Optionsbuchstaben fallen als `{kind:"text"}` durch (die Engine routet sie).
 */
export function parseInput(raw: string): ParsedInput {
  const s = raw.trim();
  if (s === "") return { kind: "text", text: "" };

  // ── polar / Winkel: enthält '<' ───────────────────────────────────────────
  if (s.includes("<")) {
    const i = s.indexOf("<");
    const left = s.slice(0, i).trim();
    const right = s.slice(i + 1).trim();
    const angle = parseNumber(right);
    if (angle == null) return { kind: "text", text: s };
    if (left === "") return { kind: "angle", angleDeg: angle };
    const dist = parseNumber(left);
    if (dist == null) return { kind: "text", text: s };
    return { kind: "polar", dist, angleDeg: angle };
  }

  // ── relativ: führendes r / @ ──────────────────────────────────────────────
  if (/^[r@]/i.test(s)) {
    const rest = s.slice(1);
    const nums = parseCoordList(rest);
    if (nums && nums.length >= 2) {
      return { kind: "relative", delta: { x: nums[0], y: nums[1] } };
    }
    // `r5` → relative Distanz entlang Cursor-Richtung.
    const one = parseNumber(rest);
    if (one != null) return { kind: "distance", value: one };
    return { kind: "text", text: s };
  }

  // ── absolute Koordinate: ≥2 zahlen mit echtem Trenner ─────────────────────
  const coords = parseCoordList(s);
  if (coords && coords.length >= 2) {
    return { kind: "absolute", point: { x: coords[0], y: coords[1] } };
  }

  // ── nackte Zahl = Distanz-Lock ────────────────────────────────────────────
  const one = parseNumber(s);
  if (one != null) return { kind: "distance", value: one };

  // ── sonst: Text (Befehl/Option) ───────────────────────────────────────────
  return { kind: "text", text: s };
}

/** Tab-Felder ohne Länge (keine Einheiten-Umrechnung getippter Werte). */
export const NON_LENGTH_FIELDS: ReadonlySet<string> = new Set(["angle", "count", "steps", "segments", "sides", "bends"]);

/**
 * Getippte Eingabe in Anzeige-Einheiten → Modell ([93], Layout-Blatt: Papier-mm, y nach unten).
 * `distance`: eine nackte Zahl ist eine Länge (Längen-Feld, Distanz-Lock), ein Δy (Feld „height“: auf
 * dem Papier nach unten) oder bleibt, wie sie ist (Winkel, Anzahl, Faktor).
 */
export function toModelInput(p: ParsedInput, u: DisplayUnits, distance: "length" | "dy" | "none"): ParsedInput {
  if (u.perMeter === 1 && !u.flipY) return p;
  switch (p.kind) {
    case "absolute":
      return { kind: "absolute", point: pointFromDisplay(u, p.point) };
    case "relative":
      return { kind: "relative", delta: { x: lengthFromDisplay(u, p.delta.x), y: yFromDisplay(u, p.delta.y) } };
    case "polar":
      return { kind: "polar", dist: lengthFromDisplay(u, p.dist), angleDeg: p.angleDeg };
    case "distance":
      if (distance === "none") return p;
      return { kind: "distance", value: distance === "dy" ? yFromDisplay(u, p.value) : lengthFromDisplay(u, p.value) };
    default:
      return p;
  }
}

/** Punkt aus polarer Form (Distanz/Winkel) relativ zu einem Basispunkt. */
export function polarPoint(base: Vec2, dist: number, angleDeg: number): Vec2 {
  const a = angleDeg * DEG;
  return { x: base.x + Math.cos(a) * dist, y: base.y + Math.sin(a) * dist };
}

/**
 * Löst eine {@link ParsedInput} zu einem konkreten Modellpunkt auf — falls sie
 * sich als Punkt auflösen lässt. `lastPoint` ist der letzte gesetzte Punkt im
 * Befehl (für relativ/polar/Distanz), `cursorDir` die aktuelle (gesnappte)
 * Cursor-Richtung als Roh-Cursorpunkt (für nackte Zahl / reinen Winkel-Lock).
 *
 * Liefert null, wenn die Eingabe keinen Punkt ergibt (z. B. reiner Text oder
 * Distanz ohne Bezug).
 */
export function resolvePoint(
  parsed: ParsedInput,
  lastPoint: Vec2 | null,
  cursor: Vec2 | null,
): Vec2 | null {
  switch (parsed.kind) {
    case "absolute":
      return parsed.point;
    case "relative":
      if (!lastPoint) return parsed.delta; // ohne Bezug = vom Ursprung
      return { x: lastPoint.x + parsed.delta.x, y: lastPoint.y + parsed.delta.y };
    case "polar": {
      const base = lastPoint ?? { x: 0, y: 0 };
      return polarPoint(base, parsed.dist, parsed.angleDeg);
    }
    case "angle": {
      // Reiner Winkel-Lock: ohne Distanz braucht es den Cursor, um die Länge
      // entlang der gelockten Richtung zu projizieren.
      if (!lastPoint || !cursor) return null;
      const a = parsed.angleDeg * DEG;
      const dir = { x: Math.cos(a), y: Math.sin(a) };
      const dx = cursor.x - lastPoint.x;
      const dy = cursor.y - lastPoint.y;
      const proj = dx * dir.x + dy * dir.y; // skalare Projektion
      const len = Math.max(0, proj);
      return { x: lastPoint.x + dir.x * len, y: lastPoint.y + dir.y * len };
    }
    case "distance": {
      // Distanz-Lock: Richtung per Cursor, Länge per Zahl.
      if (!lastPoint || !cursor) return null;
      const dx = cursor.x - lastPoint.x;
      const dy = cursor.y - lastPoint.y;
      const l = Math.hypot(dx, dy);
      if (l < 1e-9) return { x: lastPoint.x + parsed.value, y: lastPoint.y };
      return {
        x: lastPoint.x + (dx / l) * parsed.value,
        y: lastPoint.y + (dy / l) * parsed.value,
      };
    }
    default:
      return null;
  }
}

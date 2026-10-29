// Kleiner Kreis im Plan-SVG als Vieleck (`<polygon points>`) statt `<circle cx cy r>`.
//
// Grund (Kataster-Fund 29.10.): `cx`/`cy`/`r` sind in SVG 2 CSS-Eigenschaften; Chromium und WebKit
// klemmen CSS-Längen auf ±33 554 429 (LayoutUnit-Bereich). Die viewBox-Einheiten des Plans sind
// Meter · 90 (`toScreen`), Landeskoordinaten LV95 (≈ 2.6e6 m) liegen also bei ≈ 2.3e8 — ein
// `<circle>` dort landet weit ausserhalb des Bildes: Editier-Griffe und Fang-Marken eines
// importierten Katasters waren unsichtbar („keine Eckpunkte"). Die Punkte eines `<polygon>` sind
// keine CSS-Längen und werden nicht geklemmt (ab ~370 km vom Modell-Ursprung betroffen, auch LV03).
//
// Rest: Der Browser rechnet SVG-Koordinaten in f32 (bei 2.3e8 auf ±8 viewBox-Einheiten genau); bei
// starkem Zoom liegt ein Griff dann einige Pixel neben der Ecke (Treffer rechnet PlanView in f64).

import type { CSSProperties } from "react";

/** Eckenzahl des Vielecks (bei Griff-Grösse ~5 px nicht von einem Kreis zu unterscheiden). */
const SIDES = 24;

/** `points`-Attribut eines Kreis-Vielecks; leer bei unsinniger Eingabe. */
export function circlePoints(cx: number, cy: number, r: number): string {
  if (!(Number.isFinite(cx) && Number.isFinite(cy) && Number.isFinite(r) && r > 0)) return "";
  const out: string[] = new Array(SIDES);
  for (let i = 0; i < SIDES; i++) {
    const a = (2 * Math.PI * i) / SIDES;
    out[i] = `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
  }
  return out.join(" ");
}

/** Ersatz für `<circle>` im Plan-SVG (gleiche Klassen/Stile), s. Dateikopf. */
export function VbCircle(props: {
  cx: number;
  cy: number;
  r: number;
  className?: string;
  style?: CSSProperties;
  vectorEffect?: "non-scaling-stroke";
  pointerEvents?: "none";
}) {
  const { cx, cy, r, ...rest } = props;
  return <polygon points={circlePoints(cx, cy, r)} {...rest} />;
}

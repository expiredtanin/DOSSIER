// Sichtbares Hintergrund-Raster (Nutzer-Wunsch: „Kein sichtbares 2D-
// Zeichenraster" — `SnapSettings.gridSize` steuerte bisher NUR den Fang,
// nichts wurde gezeichnet). Zoom-adaptive Linienzahl über `rulerStep`
// (dieselbe Logik wie die Lineal-Hauptstriche, s. `PlanRulers.tsx`) — hält
// die Anzahl der `<line>`-Elemente über den gesamten Zoom-Bereich
// (`ZOOM_MIN`/`ZOOM_MAX` in PlanView.tsx) auf ≤ ~Bildschirmbreite/64px
// begrenzt, unabhängig davon, wie weit heraus- oder hereingezoomt ist.

import type { Vec2 } from "../../../model/types";
import { PX_PER_M } from "../../../core";
import { rulerStep } from "./PlanRulers";

export function PlanGrid({
  vb,
  origin = { x: 0, y: 0 },
  pxPerMeter,
}: {
  /** Sichtbarer Ausschnitt in (absoluten) viewBox-Einheiten. */
  vb: { x0: number; y0: number; w: number; h: number };
  /** Lokaler Ursprung des Overlays (s. `overlayOrigin.ts`), wird vor dem Zeichnen abgezogen. */
  origin?: Vec2;
  pxPerMeter: number;
}) {
  const step = rulerStep(pxPerMeter);

  // Sichtbarer Modellbereich (Plan-Y nach oben: vbY = −y·PX_PER_M) —
  // identische Umrechnung wie PlanRulers.
  const mx0 = vb.x0 / PX_PER_M;
  const mx1 = (vb.x0 + vb.w) / PX_PER_M;
  const myTop = -vb.y0 / PX_PER_M;
  const myBottom = -(vb.y0 + vb.h) / PX_PER_M;

  // Ganzzahliger Index statt aufsummiertem `v += step` (driftet bei Landeskoordinaten).
  const xs: number[] = [];
  for (let k = Math.ceil(mx0 / step); k * step <= mx1 + 1e-9; k++) xs.push(k * step);
  const ys: number[] = [];
  for (let k = Math.ceil(myBottom / step); k * step <= myTop + 1e-9; k++) ys.push(k * step);

  // Lokal zeichnen (minus Ursprung), s. `overlayOrigin.ts`.
  const x0 = vb.x0 - origin.x;
  const y0 = vb.y0 - origin.y;
  return (
    <g className="plan-grid" pointerEvents="none">
      {xs.map((v, i) => (
        <line key={`gx${i}`} x1={v * PX_PER_M - origin.x} y1={y0} x2={v * PX_PER_M - origin.x} y2={y0 + vb.h} />
      ))}
      {ys.map((v, i) => (
        <line key={`gy${i}`} x1={x0} y1={-v * PX_PER_M - origin.y} x2={x0 + vb.w} y2={-v * PX_PER_M - origin.y} />
      ))}
    </g>
  );
}

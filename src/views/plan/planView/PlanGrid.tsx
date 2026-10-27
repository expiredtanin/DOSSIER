// Sichtbares Hintergrund-Raster (Nutzer-Wunsch: „Kein sichtbares 2D-
// Zeichenraster" — `SnapSettings.gridSize` steuerte bisher NUR den Fang,
// nichts wurde gezeichnet). Zoom-adaptive Linienzahl über `rulerStep`
// (dieselbe Logik wie die Lineal-Hauptstriche, s. `PlanRulers.tsx`) — hält
// die Anzahl der `<line>`-Elemente über den gesamten Zoom-Bereich
// (`ZOOM_MIN`/`ZOOM_MAX` in PlanView.tsx) auf ≤ ~Bildschirmbreite/64px
// begrenzt, unabhängig davon, wie weit heraus- oder hereingezoomt ist.

import { PX_PER_M } from "../../../core";
import { rulerStep } from "./PlanRulers";

export function PlanGrid({
  vb,
  pxPerMeter,
}: {
  /** Sichtbarer Ausschnitt in viewBox-Einheiten. */
  vb: { x0: number; y0: number; w: number; h: number };
  pxPerMeter: number;
}) {
  const step = rulerStep(pxPerMeter);

  // Sichtbarer Modellbereich (Plan-Y nach oben: vbY = −y·PX_PER_M) —
  // identische Umrechnung wie PlanRulers.
  const mx0 = vb.x0 / PX_PER_M;
  const mx1 = (vb.x0 + vb.w) / PX_PER_M;
  const myTop = -vb.y0 / PX_PER_M;
  const myBottom = -(vb.y0 + vb.h) / PX_PER_M;

  const xs: number[] = [];
  for (let v = Math.ceil(mx0 / step) * step; v <= mx1 + 1e-9; v += step) xs.push(v);
  const ys: number[] = [];
  for (let v = Math.ceil(myBottom / step) * step; v <= myTop + 1e-9; v += step) ys.push(v);

  return (
    <g className="plan-grid" pointerEvents="none">
      {xs.map((v, i) => (
        <line key={`gx${i}`} x1={v * PX_PER_M} y1={vb.y0} x2={v * PX_PER_M} y2={vb.y0 + vb.h} />
      ))}
      {ys.map((v, i) => (
        <line key={`gy${i}`} x1={vb.x0} y1={-v * PX_PER_M} x2={vb.x0 + vb.w} y2={-v * PX_PER_M} />
      ))}
    </g>
  );
}

// Lineale oben + links (Vectorworks-Stil) am Rand der Plan-Ansicht.

import type { Vec2 } from "../../../model/types";
import { PX_PER_M } from "../../../core";
import { MODEL_UNITS, rulerLabel, type DisplayUnits } from "../../../tools/displayUnits";

/**
 * Schrittweite (Meter) fürs Lineal: 1/2/5·10^n, sodass Major-Ticks ≥ ~64 px
 * auseinander liegen. Exportiert — `PlanGrid.tsx` nutzt dieselbe Funktion für
 * den Zeilenabstand des sichtbaren Hintergrund-Rasters (identisches
 * "welcher Abstand ist bei diesem Zoom sinnvoll"-Problem).
 */
export function rulerStep(pxPerMeter: number): number {
  const minPx = 64;
  let step = Math.pow(10, Math.ceil(Math.log10(minPx / pxPerMeter)));
  for (const f of [0.2, 0.5, 1]) {
    if (step * f * pxPerMeter >= minPx) return step * f;
  }
  return step;
}

/**
 * Lineale oben + links (Vectorworks-Stil): helle Leisten mit Major-Ticks +
 * Meter-Beschriftung („5.000m"), Minor-Ticks und einem Cursor-Marker je Achse.
 * Alles screen-fix (Grössen über vbPerPx), pointerEvents none — die Leisten
 * liegen optisch über dem Plan, schlucken aber keine Klicks.
 */
export function PlanRulers({
  vb,
  origin = { x: 0, y: 0 },
  vbPerPx,
  pxPerMeter,
  cursor,
  units = MODEL_UNITS,
}: {
  /** Sichtbarer Ausschnitt in (absoluten) viewBox-Einheiten. */
  vb: { x0: number; y0: number; w: number; h: number };
  /**
   * Lokaler Ursprung (viewBox-Einheiten, s. `overlayOrigin.ts`): gezeichnet wird relativ dazu,
   * damit bei Landeskoordinaten keine Werte über f32/CSS-Längen-Grenzen ins DOM gehen.
   */
  origin?: Vec2;
  vbPerPx: number;
  pxPerMeter: number;
  cursor: Vec2 | null;
  /** Beschriftung: Meter (Modell) oder Papier-mm mit y nach unten (Layout-Blatt, [93]). */
  units?: DisplayUnits;
}) {
  const TH = 20 * vbPerPx; // Leisten-Dicke (screen-px → viewBox)
  const step = rulerStep(pxPerMeter);
  const minor = step / 5;
  const font = 9 * vbPerPx;
  // Negative Null vermeiden („−0.000m" bei Startwerten knapp unter 0).
  const label = (axis: "x" | "y", v: number): string => rulerLabel(units, axis, v);

  // Sichtbarer Modellbereich (Plan-Y nach oben: vbY = −y·PX_PER_M).
  const mx0 = vb.x0 / PX_PER_M;
  const mx1 = (vb.x0 + vb.w) / PX_PER_M;
  const myTop = -vb.y0 / PX_PER_M;
  const myBottom = -(vb.y0 + vb.h) / PX_PER_M;

  // Ticks über den ganzzahligen Index k (Wert k · minor, Hauptstrich bei k mod 5 = 0): ein
  // aufsummiertes `v += minor` driftet bei Landeskoordinaten (≈ 2.6e6 m) und verliert Hauptstriche.
  // Positionen lokal (minus Ursprung), Beschriftung absolut.
  const xTicks: { vbX: number; model: number; major: boolean }[] = [];
  for (let k = Math.floor(mx0 / minor); k * minor <= mx1 + 1e-9; k++) {
    const v = k * minor;
    xTicks.push({ vbX: v * PX_PER_M - origin.x, model: v, major: k % 5 === 0 });
  }
  const yTicks: { vbY: number; model: number; major: boolean }[] = [];
  for (let k = Math.floor(myBottom / minor); k * minor <= myTop + 1e-9; k++) {
    const v = k * minor;
    yTicks.push({ vbY: -v * PX_PER_M - origin.y, model: v, major: k % 5 === 0 });
  }

  const x0 = vb.x0 - origin.x;
  const y0 = vb.y0 - origin.y;
  return (
    <g className="plan-ruler" pointerEvents="none">
      {/* Leisten + Trennlinien. */}
      <rect className="plan-ruler-strip" x={x0} y={y0} width={vb.w} height={TH} />
      <rect className="plan-ruler-strip" x={x0} y={y0} width={TH} height={vb.h} />
      <line className="plan-ruler-border" x1={x0} y1={y0 + TH} x2={x0 + vb.w} y2={y0 + TH} />
      <line className="plan-ruler-border" x1={x0 + TH} y1={y0} x2={x0 + TH} y2={y0 + vb.h} />
      {/* Oben: Ticks + Beschriftung. */}
      {xTicks.map((t, i) =>
        t.vbX < x0 + TH ? null : (
          <g key={`x${i}`}>
            <line
              className="plan-ruler-tick"
              x1={t.vbX}
              y1={y0 + (t.major ? TH * 0.45 : TH * 0.72)}
              x2={t.vbX}
              y2={y0 + TH}
            />
            {t.major && (
              <text className="plan-ruler-text" x={t.vbX + 3 * vbPerPx} y={y0 + TH * 0.42} fontSize={font}>
                {label("x", t.model)}
              </text>
            )}
          </g>
        ),
      )}
      {/* Links: Ticks + gedrehte Beschriftung. */}
      {yTicks.map((t, i) =>
        t.vbY < y0 + TH ? null : (
          <g key={`y${i}`}>
            <line
              className="plan-ruler-tick"
              x1={x0 + (t.major ? TH * 0.45 : TH * 0.72)}
              y1={t.vbY}
              x2={x0 + TH}
              y2={t.vbY}
            />
            {t.major && (
              <text
                className="plan-ruler-text"
                x={x0 + TH * 0.42}
                y={t.vbY - 3 * vbPerPx}
                fontSize={font}
                transform={`rotate(-90 ${x0 + TH * 0.42} ${t.vbY - 3 * vbPerPx})`}
              >
                {label("y", t.model)}
              </text>
            )}
          </g>
        ),
      )}
      {/* Cursor-Marker (VW-gelb) je Achse. */}
      {cursor && (
        <>
          <rect
            className="plan-ruler-cursor"
            x={cursor.x * PX_PER_M - origin.x - 1 * vbPerPx}
            y={y0}
            width={2 * vbPerPx}
            height={TH}
          />
          <rect
            className="plan-ruler-cursor"
            x={x0}
            y={-cursor.y * PX_PER_M - origin.y - 1 * vbPerPx}
            width={TH}
            height={2 * vbPerPx}
          />
        </>
      )}
      {/* Ecke oben links. */}
      <rect className="plan-ruler-corner" x={x0} y={y0} width={TH} height={TH} />
    </g>
  );
}

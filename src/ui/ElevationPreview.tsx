// Frontal-Ansicht (Elevation, SVG) eines Fensters/einer Tür: Rahmen, Flügel/
// Pfosten (mit Öffnungslinien je Flügel), Verglasungshinweis und Rollladen-
// kasten. Rein aus den Modellwerten gezeichnet — kein Renderer-Roundtrip,
// deterministisch. Ursprünglich Teil von {@link OpeningEditorDialog} (dort
// mit einer echten Öffnungs-Instanz gefüttert); hierher extrahiert, damit
// auch die Typ-Bibliothek (ResourceManager, ohne konkrete Instanz — s.
// `WindowStylesTab`/`DoorStylesTab`) dieselbe Vorschau zeigen kann. Braucht
// dafür nur `opening.width`/`opening.height`, der Rest kommt aus `wt`/`dt`.
//
// Bezeichner englisch, Kommentare/UI-Text deutsch (CONVENTIONS.md).

import { useMemo } from "react";
import { t } from "../i18n";
import type { DoorType, Opening, WindowType } from "../model/types";
import { sashesOfWindowType, glazingPanesOf } from "../model/types";

export function ElevationPreview({
  opening,
  wt,
  dt,
}: {
  opening: Opening;
  wt?: WindowType;
  dt?: DoorType;
}) {
  const geom = useMemo(() => {
    const w = Math.max(0.1, opening.width);
    const h = Math.max(0.1, opening.height);
    const pad = 24;
    const boxH = (!dt && wt?.shading?.create ? wt.shading.box.height : 0) || 0;
    // Zeichenfläche auf ~260×300 skalieren, Seitenverhältnis erhalten.
    const availW = 220;
    const availH = 260;
    const totalH = h + boxH;
    const scale = Math.min(availW / w, availH / totalH);
    const px = (m: number) => m * scale;
    return { w, h, boxH, pad, scale, px, totalH };
  }, [opening.width, opening.height, wt, dt]);

  const { w, h, boxH, pad, px } = geom;
  const svgW = px(w) + pad * 2;
  const svgH = px(h + boxH) + pad * 2;
  const frameW = px((!dt ? wt?.frameWidth : dt?.frameWidth) ?? 0.06);
  const originY = pad + px(boxH);

  // Flügel-/Pfostenaufteilung: gleichmässig (autoWidth) bzw. feste Breiten.
  const sashes = !dt && wt ? sashesOfWindowType(wt) : [];
  const fixedTotal = sashes.reduce(
    (a, s) => a + (s.kind === "pfosten" ? s.postWidth ?? 0.06 : s.autoWidth ? 0 : s.width ?? 0),
    0,
  );
  const autoCount = sashes.filter((s) => s.kind === "fluegel" && (s.autoWidth ?? true)).length;
  const autoW = autoCount > 0 ? Math.max(0.05, (w - fixedTotal) / autoCount) : 0;
  const panes = !dt && wt ? glazingPanesOf(wt) : 1;

  // Segmentbreiten (Meter) je Sash.
  const segW = sashes.map((s) =>
    s.kind === "pfosten"
      ? s.postWidth ?? 0.06
      : s.autoWidth ?? true
      ? autoW
      : s.width ?? autoW,
  );

  const strokeMain = "var(--ink)";
  const strokeMuted = "var(--muted)";
  const glass = "rgba(120,180,220,0.18)";

  let cursor = 0;
  const segEls: JSX.Element[] = [];
  sashes.forEach((s, i) => {
    const x0 = pad + px(cursor);
    const wSeg = px(segW[i]);
    cursor += segW[i];
    if (s.kind === "pfosten") {
      segEls.push(
        <rect
          key={`p${i}`}
          x={x0}
          y={originY}
          width={wSeg}
          height={px(h)}
          fill={strokeMuted}
          opacity={0.5}
        />,
      );
      return;
    }
    // Flügelrahmen + Glas + Öffnungslinien.
    const gx = x0 + frameW * 0.4;
    const gy = originY + frameW * 0.4;
    const gw = Math.max(1, wSeg - frameW * 0.8);
    const gh = Math.max(1, px(h) - frameW * 0.8);
    segEls.push(
      <g key={`f${i}`}>
        <rect x={x0} y={originY} width={wSeg} height={px(h)} fill="none" stroke={strokeMain} />
        <rect x={gx} y={gy} width={gw} height={gh} fill={glass} stroke={strokeMuted} />
        {/* Verglasung: zusätzliche parallele Glaslinien = Scheibenzahl − 1. */}
        {Array.from({ length: Math.max(0, panes - 1) }, (_, k) => (
          <line
            key={k}
            x1={gx + (gw * (k + 1)) / panes}
            y1={gy}
            x2={gx + (gw * (k + 1)) / panes}
            y2={gy + gh}
            stroke={strokeMuted}
            strokeWidth={0.5}
          />
        ))}
        {/* Öffnungslinien (Dreieck) je nach Anschlag; nicht bei fest. */}
        {s.opening !== "fest" &&
          (s.hingeSide === "right" ? (
            <polyline
              points={`${gx + gw},${gy} ${gx},${gy + gh / 2} ${gx + gw},${gy + gh}`}
              fill="none"
              stroke={strokeMuted}
              strokeWidth={0.75}
            />
          ) : (
            <polyline
              points={`${gx},${gy} ${gx + gw},${gy + gh / 2} ${gx},${gy + gh}`}
              fill="none"
              stroke={strokeMuted}
              strokeWidth={0.75}
            />
          ))}
      </g>,
    );
  });

  return (
    <svg
      className="oed-elev"
      viewBox={`0 0 ${svgW} ${svgH}`}
      width="100%"
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={t("oed.preview")}
    >
      {/* Rollladenkasten über der Öffnung (nur Fenster mit shading.create). */}
      {boxH > 0 && (
        <rect
          x={pad}
          y={pad}
          width={px(w)}
          height={px(boxH)}
          fill="none"
          stroke={strokeMuted}
          strokeDasharray="4 3"
        />
      )}
      {/* Blendrahmen (Aussenkontur). */}
      <rect
        x={pad}
        y={originY}
        width={px(w)}
        height={px(h)}
        fill="none"
        stroke={strokeMain}
        strokeWidth={1.5}
      />
      {/* Für Türen: einfaches Türblatt statt Flügelraster. */}
      {dt ? (
        <>
          <rect
            x={pad + frameW}
            y={originY + frameW}
            width={Math.max(1, px(w) - frameW * 2)}
            height={Math.max(1, px(h) - frameW)}
            fill={dt.leafStyle === "glas" ? glass : "none"}
            stroke={strokeMuted}
          />
          {dt.leafCount === 2 && (
            <line
              x1={pad + px(w) / 2}
              y1={originY + frameW}
              x2={pad + px(w) / 2}
              y2={originY + px(h)}
              stroke={strokeMuted}
            />
          )}
        </>
      ) : (
        <>
          {segEls}
          {/* Oberlicht-Kämpfer (waagrechte Linie transomHeight unter der OK). */}
          {!dt && wt && (wt.transomHeight ?? 0) > 0 && (
            <line
              x1={pad}
              y1={originY + px(wt.transomHeight ?? 0)}
              x2={pad + px(w)}
              y2={originY + px(wt.transomHeight ?? 0)}
              stroke={strokeMain}
            />
          )}
          {/* Kämpfer-/Sprossen-Zeilen (mullionRows − 1 waagrechte Teiler im
              Hauptfeld unterhalb eines etwaigen Oberlichts). */}
          {!dt &&
            wt &&
            (() => {
              const rows = Math.max(1, Math.round(wt.mullionRows ?? 1));
              if (rows <= 1) return null;
              const top = originY + px(wt.transomHeight ?? 0);
              const fieldH = px(h) - px(wt.transomHeight ?? 0);
              return Array.from({ length: rows - 1 }, (_, k) => (
                <line
                  key={k}
                  x1={pad}
                  y1={top + (fieldH * (k + 1)) / rows}
                  x2={pad + px(w)}
                  y2={top + (fieldH * (k + 1)) / rows}
                  stroke={strokeMuted}
                  strokeWidth={0.75}
                />
              ));
            })()}
          {/* Sprossen-Spalten (mullionCols − 1 vertikale Teiler im
              Hauptfeld unterhalb eines etwaigen Oberlichts). */}
          {!dt &&
            wt &&
            (() => {
              const cols = Math.max(1, Math.round(wt.mullionCols ?? 1));
              if (cols <= 1) return null;
              const top = originY + px(wt.transomHeight ?? 0);
              const fieldH = px(h) - px(wt.transomHeight ?? 0);
              const fieldW = px(w);
              return Array.from({ length: cols - 1 }, (_, k) => (
                <line
                  key={k}
                  x1={pad + (fieldW * (k + 1)) / cols}
                  y1={top}
                  x2={pad + (fieldW * (k + 1)) / cols}
                  y2={top + fieldH}
                  stroke={strokeMuted}
                  strokeWidth={0.75}
                />
              ));
            })()}
        </>
      )}
    </svg>
  );
}

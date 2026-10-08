// Werkzeug-/Snap-Overlays der Plan-Ansicht: Vorschau-Formen, Cursor-HUD,
// Winkel-Führungslinie, Snap-Marker. Reine Darstellung, bekommt `toScreen` +
// Massstab-Parameter als Props gereicht.

import type { Vec2 } from "../../model/types";
import type { SnapResult, ToolDraft } from "../../tools/types";
import { hudSegments, type HudFieldsState } from "../../tools/hudFormat";

/**
 * Zeichnet die Werkzeug-Vorschau: Vorschau-Formen (gestrichelte Akzentlinien /
 * halbtransparente Flächen), gesetzte Stützpunkte (kleine Quadrate), den
 * aktiven Snap-Marker, das Cursor-HUD (Länge/Winkel, VW-Stil) sowie — bei
 * weichem Winkel-Snap (`snap.kind === "angle"`) — Winkel-Badge + verlängerte
 * Führungslinie. `vbPerPx` rechnet eine gewünschte Bildschirm-Pixelgröße in
 * viewBox-Einheiten um (bildschirmkonstante Marker/Schrift). Die Winkel-Info
 * reitet auf `draft.snap` mit (refA/point/angleDeg) — kein eigenes Feld nötig,
 * `computeSnap` liefert sie bereits vollständig.
 */
export function DraftOverlay({
  draft,
  toScreen,
  vbPerPx,
  snapColor,
  hudFields = null,
}: {
  draft: ToolDraft;
  toScreen: (v: Vec2) => Vec2;
  vbPerPx: number;
  snapColor: string;
  hudFields?: HudFieldsState | null;
}) {
  const vertSize = 4.5 * vbPerPx; // halbe Kantenlänge eines Stützpunkt-Quadrats (klein + einheitlich)
  const markSize = 4.75 * vbPerPx; // halbe Kantenlänge des Snap-Markers (klein + fein)
  return (
    <g className="tool-overlay" pointerEvents="none">
      {/* Vorschau-Formen. */}
      {draft.preview.map((s, i) =>
        s.kind === "line" ? (
          <line
            key={`p${i}`}
            className="tool-preview-line"
            x1={toScreen(s.a).x}
            y1={toScreen(s.a).y}
            x2={toScreen(s.b).x}
            y2={toScreen(s.b).y}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          <polygon
            key={`p${i}`}
            className="tool-preview-fill"
            points={s.pts.map(toScreen).map((p) => `${p.x},${p.y}`).join(" ")}
            vectorEffect="non-scaling-stroke"
          />
        ),
      )}
      {/* Gesetzte Stützpunkte. */}
      {draft.vertices.map((v, i) => {
        const s = toScreen(v);
        return (
          <circle
            key={`v${i}`}
            className="tool-vertex"
            cx={s.x}
            cy={s.y}
            r={vertSize}
            vectorEffect="non-scaling-stroke"
          />
        );
      })}
      {/* Weicher Winkel-Snap: verlängerte gestrichelte Führungslinie + Badge
          UNTER dem Snap-Marker (der bleibt obenauf). */}
      {draft.snap?.kind === "angle" && draft.snap.refA && draft.snap.angleDeg != null && (
        <AngleGuide
          from={draft.snap.refA}
          point={draft.snap.point}
          angleDeg={draft.snap.angleDeg}
          toScreen={toScreen}
          vbPerPx={vbPerPx}
        />
      )}
      {/* Snap-Marker + optionale Ortho-Hilfslinie. */}
      {draft.snap && (
        <SnapMarker snap={draft.snap} toScreen={toScreen} size={markSize} color={snapColor} />
      )}
      {/* Maß-/Winkel-HUD am Cursor (VW-Stil `L: … W: …`, oder einfacher Text). */}
      {draft.hud && <DraftHud hud={draft.hud} toScreen={toScreen} vbPerPx={vbPerPx} hudFields={hudFields} />}
    </g>
  );
}

/**
 * Cursor-HUD im Vectorworks-Stil: weisser Kasten, blauer Rahmen, blauer
 * Monospace-Text. Zeigt `L:`/`W:` (Länge 3 Nachkommastellen + „m", Winkel 3
 * Nachkommastellen + „°"), wenn beide vorhanden sind — sonst den freien
 * `text` (Radius/Fläche/… bei Befehlen ohne Länge-Winkel-Paar). Leicht
 * versetzt rechts-unten vom Cursorpunkt, bildschirmkonstante Größe.
 */
function DraftHud({
  hud,
  toScreen,
  vbPerPx,
  hudFields = null,
}: {
  hud: NonNullable<ToolDraft["hud"]>;
  toScreen: (v: Vec2) => Vec2;
  vbPerPx: number;
  hudFields?: HudFieldsState | null;
}) {
  // Segmente: gemeinsame Formatierung mit dem 3D-Pendant (Wasm3DViewport.tsx),
  // s. `tools/hudFormat.ts`.
  const segs = hudSegments(hud, hudFields);
  if (segs.length === 0) return null;

  const p = toScreen(hud.at);
  const fontSize = 12 * vbPerPx;
  const padX = 6 * vbPerPx;
  const padY = 4 * vbPerPx;
  const gap = 10 * vbPerPx;
  const charW = fontSize * 0.62; // Monospace-Schätzung für die Kastenbreite
  const widths = segs.map((s) => s.text.length * charW);
  const w = widths.reduce((a, b) => a + b, 0) + gap * (segs.length - 1) + padX * 2;
  const h = fontSize + padY * 2;
  const x = p.x + 14 * vbPerPx;
  const y = p.y + 14 * vbPerPx;
  let cx = x + padX;
  return (
    <g className="plan-hud" pointerEvents="none">
      <rect className="plan-hud-box" x={x} y={y} width={w} height={h} rx={6 * vbPerPx} />
      {segs.map((s, i) => {
        const sx = cx;
        cx += widths[i] + gap;
        return (
          <g key={i}>
            {s.active && (
              <rect
                className="plan-hud-active"
                x={sx - 2 * vbPerPx}
                y={y + 1.5 * vbPerPx}
                width={widths[i] + 4 * vbPerPx}
                height={h - 3 * vbPerPx}
                rx={5 * vbPerPx}
              />
            )}
            <text
              className={
                "plan-hud-text" + (s.active ? " active" : "") + (s.locked ? " locked" : "")
              }
              x={sx}
              y={y + h / 2}
              fontSize={fontSize}
              dominantBaseline="middle"
            >
              {s.text}
            </text>
          </g>
        );
      })}
    </g>
  );
}

/**
 * Weicher Winkel-Snap (§snapCommonAngle): gestrichelte Führungslinie vom
 * letzten Punkt über den Cursor hinaus verlängert (dezent, wie in VW) + ein
 * gelbliches Winkel-Badge nahe der Liniemitte.
 */
function AngleGuide({
  from,
  point,
  angleDeg,
  toScreen,
  vbPerPx,
}: {
  from: Vec2;
  point: Vec2;
  angleDeg: number;
  toScreen: (v: Vec2) => Vec2;
  vbPerPx: number;
}) {
  const a = toScreen(from);
  const b = toScreen(point);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  const dir = len > 1e-6 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
  // Führungslinie WEIT über den Cursor hinaus (VW-Verhalten: die Referenz läuft
  // quer über den sichtbaren Ausschnitt; der SVG-Clip schneidet den Rest ab).
  const extend = 4000 * vbPerPx;
  const end = { x: b.x + dir.x * extend, y: b.y + dir.y * extend };
  // Winkelbogen (VW): gestrichelter Bogen von der HORIZONTALEN Referenz (0°) zur
  // Strahlrichtung, Radius knapp innerhalb des Cursors. Screen-y läuft nach
  // unten → der Screen-Winkel ist der negierte Modellwinkel; für den Bogenpfad
  // rechnen wir direkt mit Screen-Vektoren.
  const screenAng = Math.atan2(dy, dx); // (−π, π], y-down
  const r = Math.min(len * 0.85, 160 * vbPerPx);
  const arcStart = { x: a.x + r, y: a.y };
  const arcEnd = { x: a.x + r * Math.cos(screenAng), y: a.y + r * Math.sin(screenAng) };
  const sweep = screenAng > 0 ? 1 : 0; // y-down: positiver Screen-Winkel = im Uhrzeigersinn
  const arcPath = `M ${arcStart.x} ${arcStart.y} A ${r} ${r} 0 0 ${sweep} ${arcEnd.x} ${arcEnd.y}`;
  // Horizontale Referenz-Strichellinie (0°-Basis des Bogens), etwas über den
  // Bogen hinaus.
  const refEnd = { x: a.x + r + 60 * vbPerPx, y: a.y };
  // Badge aussen am Bogen bei halbem Winkel (VW-Position).
  const halfAng = screenAng / 2;
  const badgeR = r + 22 * vbPerPx;
  const badgeAt = { x: a.x + badgeR * Math.cos(halfAng), y: a.y + badgeR * Math.sin(halfAng) };
  const fontSize = 11 * vbPerPx;
  const padX = 5 * vbPerPx;
  const padY = 3 * vbPerPx;
  const text = `${angleDeg.toFixed(3)}°`;
  const w = text.length * fontSize * 0.62 + padX * 2;
  const h = fontSize + padY * 2;
  return (
    <g className="plan-angle-guide" pointerEvents="none">
      <line
        className="plan-angle-guide-line"
        x1={a.x}
        y1={a.y}
        x2={end.x}
        y2={end.y}
        vectorEffect="non-scaling-stroke"
      />
      <line
        className="plan-angle-ref-line"
        x1={a.x}
        y1={a.y}
        x2={refEnd.x}
        y2={refEnd.y}
        vectorEffect="non-scaling-stroke"
      />
      {len > 24 * vbPerPx && Math.abs(screenAng) > 0.02 && (
        <path className="plan-angle-arc" d={arcPath} vectorEffect="non-scaling-stroke" />
      )}
      <rect
        className="plan-angle-badge-box"
        x={badgeAt.x - w / 2}
        y={badgeAt.y - h / 2}
        width={w}
        height={h}
        rx={6 * vbPerPx}
      />
      <text
        className="plan-angle-badge-text"
        x={badgeAt.x}
        y={badgeAt.y}
        fontSize={fontSize}
        textAnchor="middle"
        dominantBaseline="middle"
      >
        {text}
      </text>
    </g>
  );
}

/** Marker-Glyph je Snap-Art + (bei ortho) eine gestrichelte Hilfslinie. */
function SnapMarker({
  snap,
  toScreen,
  size,
  color,
}: {
  snap: SnapResult;
  toScreen: (v: Vec2) => Vec2;
  size: number;
  /** Farbe des Snap-Glyphs (einstellbar, Default = Akzent „Sora"). */
  color: string;
}) {
  const s = toScreen(snap.point);
  const r = size;
  // Inline `style` überschreibt gezielt die CSS-Klassenfarbe (eine am Element
  // selbst deklarierte Klassenregel gewinnt sonst gegen eine geerbte Farbe von
  // einer umschließenden Gruppe — daher pro Glyph statt einmal an der Gruppe).
  const glyphStyle = { stroke: color };
  const helperStyle = { stroke: color };
  const fillStyle = { stroke: color, fill: color };
  return (
    <g className="snap-marker">
      {(snap.kind === "ortho" || snap.kind === "extension") && snap.refA && (
        <line
          className="snap-helper-line"
          x1={toScreen(snap.refA).x}
          y1={toScreen(snap.refA).y}
          x2={s.x}
          y2={s.y}
          style={helperStyle}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {snap.kind === "grid" && (
        <circle
          className="snap-glyph snap-fill"
          cx={s.x}
          cy={s.y}
          r={r * 0.5}
          style={fillStyle}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {snap.kind === "midpoint" && (
        <line
          className="snap-glyph"
          x1={s.x - r}
          y1={s.y}
          x2={s.x + r}
          y2={s.y}
          style={glyphStyle}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* Teilpunkt (nur fangbar nach Verweilen, s. computeSnap-Dwell) — kleine
          gefüllte Raute, bewusst anders als Mittelpunkt (Linie) und Raster
          (Kreis), damit „warum snappt es hier" nachvollziehbar bleibt. */}
      {snap.kind === "divide" && (
        <polygon
          className="snap-glyph snap-fill"
          points={`${s.x},${s.y - r} ${s.x + r},${s.y} ${s.x},${s.y + r} ${s.x - r},${s.y}`}
          style={fillStyle}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {snap.kind === "intersection" && (
        <>
          <line className="snap-glyph" x1={s.x - r} y1={s.y - r} x2={s.x + r} y2={s.y + r} style={glyphStyle} vectorEffect="non-scaling-stroke" />
          <line className="snap-glyph" x1={s.x - r} y1={s.y + r} x2={s.x + r} y2={s.y - r} style={glyphStyle} vectorEffect="non-scaling-stroke" />
        </>
      )}
      {(snap.kind === "center" || snap.kind === "quadrant") && (
        <circle className="snap-glyph" cx={s.x} cy={s.y} r={r} style={glyphStyle} vectorEffect="non-scaling-stroke" />
      )}
      {snap.kind === "onEdge" && (
        <polygon
          className="snap-glyph"
          points={`${s.x},${s.y - r} ${s.x + r},${s.y} ${s.x},${s.y + r} ${s.x - r},${s.y}`}
          style={glyphStyle}
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* Senkrecht: ein rechter Winkel (⌐), wie das klassische CAD-Perpendicular-
          Glyph — unterscheidet sich bewusst von „onEdge" (Raute), da die
          Konstruktion vom letzten Punkt aus geschieht, nicht vom Cursor. */}
      {snap.kind === "perpendicular" && (
        <polyline
          className="snap-glyph"
          points={`${s.x - r},${s.y} ${s.x - r},${s.y + r} ${s.x},${s.y + r}`}
          style={glyphStyle}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {/* Tangente: kleiner Kreis (wie „center") plus eine kurze Berührlinie. */}
      {snap.kind === "tangent" && (
        <>
          <circle className="snap-glyph" cx={s.x} cy={s.y} r={r * 0.7} style={glyphStyle} vectorEffect="non-scaling-stroke" />
          <line
            className="snap-glyph"
            x1={s.x - r}
            y1={s.y + r}
            x2={s.x + r}
            y2={s.y - r}
            style={glyphStyle}
            vectorEffect="non-scaling-stroke"
          />
        </>
      )}
      {/* Parallel: zwei kurze parallele Striche (∥). */}
      {snap.kind === "parallel" && (
        <>
          <line className="snap-glyph" x1={s.x - r} y1={s.y - r} x2={s.x - r * 0.3} y2={s.y + r} style={glyphStyle} vectorEffect="non-scaling-stroke" />
          <line className="snap-glyph" x1={s.x + r * 0.3} y1={s.y - r} x2={s.x + r} y2={s.y + r} style={glyphStyle} vectorEffect="non-scaling-stroke" />
        </>
      )}
      {(snap.kind === "endpoint" || snap.kind === "ortho" || snap.kind === "extension") && (
        <circle
          className="snap-glyph"
          cx={s.x}
          cy={s.y}
          r={r}
          style={glyphStyle}
          vectorEffect="non-scaling-stroke"
        />
      )}
    </g>
  );
}

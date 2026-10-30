// Live-SVG-Vorschau (Swatch) für Schraffuren und Linienstile.
//
// Vektor-Schraffuren zeichnet die Vorschau mit DEMSELBEN Kern-Generator wie Plan, Schnitt und Druck
// (`buildHatchRuns`, [109]) — die Box wird als Fläche in Modell-Metern (`SWATCH_PX_PER_M`) übergeben,
// Schicht-Muster (Dämmschlange, Zickzack …) spannen also über das Band wie im Plan. Bild/Verlauf als
// SVG-Füllung. Die Farbe kommt bewusst NICHT vom (deprecated) HatchStyle.color, sondern über
// `currentColor` aus dem umgebenden CSS (var(--ink)) — die echte Vordergrundfarbe stammt im Plan vom
// Bauteil/Attribut. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useId } from "react";
import type { HatchStyle, LineStyle } from "../model/types";
import { buildHatchRuns, dashHasDot } from "../core";

/** Vorschau-Massstab: px je Modell-Meter (128 px ≈ 0.43 m, etwa 1:10 am Bildschirm). */
const SWATCH_PX_PER_M = 300;

/**
 * Musterlinien einer Vektor-Schraffur für eine Box `w`×`h` (px) aus dem Kern-Generator. `wallAngleDeg`
 * dreht wandbezogene Muster wie im Plan (Wand senkrecht = 90).
 */
function vectorRuns(hatch: HatchStyle, w: number, h: number, wallAngleDeg: number | undefined): string[] {
  const k = SWATCH_PX_PER_M;
  const poly = [
    { x: 0, y: 0 },
    { x: w / k, y: 0 },
    { x: w / k, y: h / k },
    { x: 0, y: h / k },
  ];
  const angle = hatch.relativeToWall && wallAngleDeg != null ? hatch.angle - wallAngleDeg : hatch.angle;
  const runs = buildHatchRuns(poly, {
    pattern: hatch.pattern,
    scale: hatch.scale,
    angle,
    color: "#000",
    lineWeight: hatch.lineWeight ?? 0.13,
    dash: null,
    kind: hatch.kind,
    lines: hatch.lines,
    seed: hatch.seed,
    density: hatch.density,
    lengthMin: hatch.lengthMin,
    lengthMax: hatch.lengthMax,
    motif: hatch.motif,
  });
  return runs.map((r) => r.map((p, i) => `${i ? "L" : "M"}${(p.x * k).toFixed(1)} ${(h - p.y * k).toFixed(1)}`).join(""));
}

/**
 * Reine Muster-Füllung EINER Schraffur als SVG-Knoten für eine Box `w`×`h`
 * (ohne Rahmen/Clip — die übernimmt der Aufrufer). Ausgelagert aus
 * {@link HatchSwatch}, damit auch der geschichtete {@link WallTypeSwatch} pro
 * Band DASSELBE Muster zeichnet. `uid` macht interne <pattern>-IDs eindeutig
 * (mehrere Bänder je SVG).
 */
function hatchInner(hatch: HatchStyle, w: number, h: number, uid: string, wallAngleDeg?: number): React.ReactNode {
  const patId = `hsp_${uid}`;

  let inner: React.ReactNode = null;

  if (hatch.kind === "image") {
    // Bild-Kachel: Basiskachel skaliert mit scaleX/scaleY, gedreht via
    // patternTransform. Fehlt die Quelle, zeigen wir einen dezenten Rahmen.
    const src = hatch.image?.src;
    const base = Math.max(6, Math.min(w, h) * 0.6);
    const tileW = Math.max(2, base * (hatch.image?.scaleX ?? 1));
    const tileH = Math.max(2, base * (hatch.image?.scaleY ?? 1));
    const rot = hatch.image?.rotation ?? 0;
    if (src) {
      inner = (
        <>
          <defs>
            <pattern
              id={patId}
              patternUnits="userSpaceOnUse"
              width={tileW}
              height={tileH}
              patternTransform={`rotate(${rot})`}
            >
              <image
                href={src}
                x={0}
                y={0}
                width={tileW}
                height={tileH}
                preserveAspectRatio="none"
              />
            </pattern>
          </defs>
          <rect x={0} y={0} width={w} height={h} fill={`url(#${patId})`} />
        </>
      );
    } else {
      inner = (
        <text
          x={w / 2}
          y={h / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={9}
          fill="currentColor"
          opacity={0.5}
        >
          ?
        </text>
      );
    }
  } else if (hatch.kind === "gradient" && hatch.gradient) {
    // Farbverlauf: linear entlang `angle` bzw. radial vom Zentrum aus —
    // dieselbe objectBoundingBox-Technik wie der echte Plan-Renderer
    // (`plan/planView/primitives.tsx`). Hier mit den ECHTEN Verlauffarben
    // (nicht `currentColor`), da `HatchStyle.gradient.color1/2` die einzige
    // Farbquelle dieses Modus sind (kein Bauteil-Vordergrund beteiligt).
    const g = hatch.gradient;
    if (g.type === "radial") {
      inner = (
        <>
          <defs>
            <radialGradient id={patId}>
              <stop offset="0%" stopColor={g.color1} />
              <stop offset="100%" stopColor={g.color2} />
            </radialGradient>
          </defs>
          <rect x={0} y={0} width={w} height={h} fill={`url(#${patId})`} />
        </>
      );
    } else {
      const rad = (g.angle * Math.PI) / 180;
      const dx = Math.cos(rad) / 2;
      const dy = Math.sin(rad) / 2;
      inner = (
        <>
          <defs>
            <linearGradient id={patId} x1={0.5 - dx} y1={0.5 - dy} x2={0.5 + dx} y2={0.5 + dy}>
              <stop offset="0%" stopColor={g.color1} />
              <stop offset="100%" stopColor={g.color2} />
            </linearGradient>
          </defs>
          <rect x={0} y={0} width={w} height={h} fill={`url(#${patId})`} />
        </>
      );
    }
  } else if (hatch.pattern === "solid") {
    inner = <rect x={0} y={0} width={w} height={h} fill="currentColor" />;
  } else if (hatch.pattern === "none") {
    inner = null;
  } else {
    // Vektor (parallel, Kreuz, Schicht-Muster, Motiv, gestreut): Kern-Generator.
    inner = vectorRuns(hatch, w, h, wallAngleDeg).map((d, i) => (
      <path key={i} d={d} fill="none" stroke="currentColor" strokeWidth={0.8} strokeLinejoin="round" />
    ));
  }

  return inner;
}

/**
 * Live-SVG-Swatch einer Schraffur. Rendert:
 *   • Bild-Schraffur (`kind==="image"`) als gekachelten <pattern>/<image>-Fill
 *     mit unabhängiger Skalierung (scaleX/scaleY) und Rotation.
 *   • Vektor-Schraffur nach `pattern`: solid/none/diagonal/crosshatch/insulation.
 *     Untermodus `lines==="random"` verteilt kurze Striche zufällig (Kies/Splitt).
 * `scale` verdichtet/streckt das Muster, `angle` dreht es.
 */
export function HatchSwatch({
  hatch,
  size = 34,
}: {
  hatch: HatchStyle;
  size?: number;
}) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const clipId = `hsc_${rawId}`;
  const w = size;
  const h = size;

  return (
    <svg
      className="res-swatch"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: "block" }}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={w} height={h} rx={3} />
        </clipPath>
      </defs>
      <rect
        x={0.5}
        y={0.5}
        width={w - 1}
        height={h - 1}
        rx={3}
        fill="var(--input)"
        stroke="var(--border)"
        strokeWidth={1}
      />
      <g clipPath={`url(#${clipId})`}>{hatchInner(hatch, w, h, rawId)}</g>
    </svg>
  );
}

/**
 * Eine Schicht für den geschichteten Wand-/Decken-Querschnitt: ihre
 * Schnittschraffur (oder `undefined` = leer/weiß) und die relative Dicke
 * (proportional zur Bandbreite). Farbe kommt wie sonst über `currentColor`.
 */
export interface SwatchLayer {
  hatch: HatchStyle | undefined;
  thickness: number;
}

/**
 * Live-SVG-Querschnitt EINES Wand-/Deckentyps: die Schichten als aneinander-
 * liegende Bänder, proportional zur Dicke, jedes Band mit der Schnittschraffur
 * seines Bauteils. `orientation="wall"` legt die Bänder NEBENEINANDER (Blick
 * entlang der Wand — Schichten quer über die Dicke), `"ceiling"` STAPELT sie
 * (liegender Deckenaufbau, oben → innen). Dünne Trennlinien markieren die Fugen;
 * ein gerundeter Rahmen fasst das Ganze wie die übrigen Swatches ein.
 */
export function WallTypeSwatch({
  layers,
  width = 128,
  height = 64,
  orientation = "wall",
}: {
  layers: SwatchLayer[];
  width?: number;
  height?: number;
  orientation?: "wall" | "ceiling";
}) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const clipId = `wtc_${rawId}`;
  const w = width;
  const h = height;

  // Gewichte: 0-dicke Schichten dünn, aber sichtbar. Proportional zur Summe.
  const weights = layers.map((l) => (l.thickness > 0 ? l.thickness : 0.01));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const along = orientation === "wall" ? w : h;

  // Bänder entlang der Stapelachse aufsummieren (px-Offsets).
  let acc = 0;
  const bands = layers.map((l, i) => {
    const len = (weights[i] / total) * along;
    const start = acc;
    acc += len;
    const bx = orientation === "wall" ? start : 0;
    const by = orientation === "wall" ? 0 : start;
    const bw = orientation === "wall" ? len : w;
    const bh = orientation === "wall" ? h : len;
    return { hatch: l.hatch, bx, by, bw, bh, start, len };
  });

  return (
    <svg
      className="res-swatch res-wallswatch"
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: "block" }}
    >
      <defs>
        <clipPath id={clipId}>
          <rect x={0} y={0} width={w} height={h} rx={3} />
        </clipPath>
        {bands.map((b, i) => (
          <clipPath key={i} id={`${clipId}_b${i}`}>
            <rect x={0} y={0} width={b.bw} height={b.bh} />
          </clipPath>
        ))}
      </defs>
      <rect
        x={0.5}
        y={0.5}
        width={w - 1}
        height={h - 1}
        rx={3}
        fill="var(--input)"
        stroke="var(--border)"
        strokeWidth={1}
      />
      <g clipPath={`url(#${clipId})`}>
        {bands.map((b, i) => (
          <g
            key={i}
            transform={`translate(${b.bx.toFixed(2)},${b.by.toFixed(2)})`}
            clipPath={`url(#${clipId}_b${i})`}
          >
            {b.hatch && hatchInner(b.hatch, b.bw, b.bh, `${rawId}_${i}`, orientation === "wall" ? 90 : undefined)}
          </g>
        ))}
        {/* Fugen: dünne Trennlinie an jeder INNEREN Bandgrenze. */}
        {bands.slice(1).map((b, i) =>
          orientation === "wall" ? (
            <line
              key={i}
              x1={b.start}
              y1={0}
              x2={b.start}
              y2={h}
              stroke="currentColor"
              strokeWidth={0.6}
              opacity={0.5}
            />
          ) : (
            <line
              key={i}
              x1={0}
              y1={b.start}
              x2={w}
              y2={b.start}
              stroke="currentColor"
              strokeWidth={0.6}
              opacity={0.5}
            />
          ),
        )}
      </g>
      <rect
        x={0.5}
        y={0.5}
        width={w - 1}
        height={h - 1}
        rx={3}
        fill="none"
        stroke="var(--border)"
        strokeWidth={1}
      />
    </svg>
  );
}

/**
 * Live-SVG-Swatch eines Linienstils. `kind==="zigzag"` zeichnet eine Zickzack-/
 * Wellenlinie aus `amplitude`/`wavelength` (mm Papier, optisch skaliert); sonst
 * eine gerade Linie mit `dash`-Strichmuster. `weight` (mm) wird auf eine
 * sichtbare Pixelstärke abgebildet. Farbe über `currentColor`.
 */
export function LineSwatch({
  style,
  width = 120,
  height = 22,
}: {
  style: LineStyle;
  width?: number;
  height?: number;
}) {
  // Linienstile tragen keine Stärke mehr ([110]): Vorschau mit einheitlicher Linie.
  const px = 1.5;
  const midY = height / 2;
  const x0 = 4;
  const x1 = width - 4;

  let path: React.ReactNode;
  if (style.kind === "zigzag") {
    const amp = Math.max(1, Math.min(height / 2 - 2, (style.zigzag?.amplitude ?? 1) * 4));
    const wl = Math.max(4, (style.zigzag?.wavelength ?? 4) * 4);
    let d = `M ${x0} ${midY}`;
    // Halbperioden-Segmente: abwechselnd nach oben/unten.
    let x = x0;
    let up = true;
    let seg = 0;
    while (x < x1) {
      const nx = Math.min(x + wl / 2, x1);
      const ny = midY + (up ? -amp : amp);
      d += ` L ${nx.toFixed(1)} ${ny.toFixed(1)}`;
      x = nx;
      up = !up;
      seg++;
      if (seg > 200) break;
    }
    path = (
      <path
        d={d}
        fill="none"
        stroke="currentColor"
        strokeWidth={px}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    );
  } else if (style.kind === "custom" && style.motif && style.motif.points.length >= 2) {
    // Custom-Motiv: die Einheitszelle (mm) wird entlang der Linie gekachelt
    // (mm-Papier → px ·4, wie das Dash-Muster). Deckungsgleich zur motifPoints-
    // Kachelung im Plan-Renderer, hier nur schematisch/px.
    const PX_PER_MM = 4;
    const motif = style.motif;
    const cellPx = Math.max(2, motif.length * PX_PER_MM);
    let d = "";
    let started = false;
    let lastX = -1;
    let lastY = 0;
    let x = x0;
    let rep = 0;
    outer: while (x <= x1 && rep < 400) {
      const base = x0 + rep * cellPx;
      for (const p of motif.points) {
        const px2 = base + p.x * PX_PER_MM;
        if (px2 > x1 + 0.5) break outer;
        const py2 = midY - p.y * PX_PER_MM;
        if (Math.abs(px2 - lastX) < 0.01 && Math.abs(py2 - lastY) < 0.01) continue;
        d += `${started ? " L" : "M"} ${px2.toFixed(1)} ${py2.toFixed(1)}`;
        started = true;
        lastX = px2;
        lastY = py2;
      }
      x = base + cellPx;
      rep++;
    }
    path = (
      <path
        d={d || `M ${x0} ${midY} L ${x1} ${midY}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={px}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    );
  } else if (!style.dash || !style.dash.length) {
    // Volllinie: durchgezogen, eine dunkle Linie.
    path = (
      <line
        x1={x0}
        y1={midY}
        x2={x1}
        y2={midY}
        stroke="currentColor"
        strokeWidth={px}
        strokeLinecap="butt"
      />
    );
  } else {
    // Muster-Linie (Strich/Punkt/Lücke, loopend): den ERSTEN Loop in Ink-Farbe
    // (currentColor), danach 2 weitere Loops in Grau (var(--muted)) — so sieht man
    // den fortgesetzten Loop. Punkte (0-Längen-Segmente) brauchen runde Kappen.
    const PX_PER_MM = 4;
    const dpx = style.dash.map((d) => d * PX_PER_MM);
    const dasharray = dpx.join(" ");
    const loopLen = dpx.reduce((a, b) => a + b, 0) || PX_PER_MM;
    const cap = dashHasDot(style.dash) ? "round" : "butt";
    // Der graue Teil beginnt exakt an der Loop-Grenze (x0 + loopLen) → das Muster
    // läuft phasengleich weiter (dash startet bei jedem Pfadanfang neu).
    const darkEnd = Math.min(x1, x0 + loopLen);
    const greyEnd = Math.min(x1, x0 + loopLen * 3);
    path = (
      <>
        {greyEnd > darkEnd && (
          <line
            x1={darkEnd}
            y1={midY}
            x2={greyEnd}
            y2={midY}
            stroke="var(--muted)"
            strokeWidth={px}
            strokeDasharray={dasharray}
            strokeLinecap={cap}
          />
        )}
        <line
          x1={x0}
          y1={midY}
          x2={darkEnd}
          y2={midY}
          stroke="currentColor"
          strokeWidth={px}
          strokeDasharray={dasharray}
          strokeLinecap={cap}
        />
      </>
    );
  }

  return (
    <svg
      className="res-line-preview"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
    >
      {path}
    </svg>
  );
}

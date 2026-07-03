// Live-SVG-Vorschau (Swatch) für Schraffuren und Linienstile — eigenständig.
//
// Bewusst OHNE Rückgriff auf die Plan-Renderer (generatePlan/toRenderScene):
// diese Datei zeichnet die Muster direkt aus den HatchStyle-/LineStyle-Parametern
// als SVG nach, damit die Vorschau im Ressourcen-Manager auch dann konsistent
// bleibt, während der Plan-Renderer separat umgebaut wird. Die Farbe kommt hier
// bewusst NICHT vom (deprecated) HatchStyle.color, sondern über `currentColor`
// aus dem umgebenden CSS (var(--ink)) — die echte Vordergrundfarbe stammt im Plan
// vom Bauteil/Attribut. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useId } from "react";
import type { HatchStyle, LineStyle } from "../model/types";
import { dashHasDot } from "./lineSegments";

// ── Kleiner deterministischer PRNG (mulberry32) ────────────────────────────
// Für „random"-Striche: stabil pro Seed, damit die Vorschau bei gleichem
// Maßstab/Winkel nicht bei jedem Render „springt".
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Parallele Linienschar über die Box (w×h) unter `angleDeg`, Abstand `spacing`
 * px senkrecht zur Linienrichtung. Liefert fertige <line>-Elemente, die die Box
 * komplett überdecken (Clip übernimmt der Aufrufer).
 */
function parallelLines(
  w: number,
  h: number,
  angleDeg: number,
  spacing: number,
  strokeWidth: number,
  keyPrefix: string,
): React.ReactNode[] {
  const a = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  // Senkrechte zur Linienrichtung.
  const px = -sin;
  const py = cos;
  const cx = w / 2;
  const cy = h / 2;
  const half = Math.hypot(w, h); // Linien lang genug, um die Box zu überdecken.
  const step = Math.max(spacing, 1.2);
  const n = Math.ceil(half / step) + 2;
  const out: React.ReactNode[] = [];
  for (let k = -n; k <= n; k++) {
    const mx = cx + k * step * px;
    const my = cy + k * step * py;
    out.push(
      <line
        key={`${keyPrefix}${k}`}
        x1={mx - cos * half}
        y1={my - sin * half}
        x2={mx + cos * half}
        y2={my + sin * half}
        stroke="currentColor"
        strokeWidth={strokeWidth}
      />,
    );
  }
  return out;
}

/**
 * Reine Muster-Füllung EINER Schraffur als SVG-Knoten für eine Box `w`×`h`
 * (ohne Rahmen/Clip — die übernimmt der Aufrufer). Ausgelagert aus
 * {@link HatchSwatch}, damit auch der geschichtete {@link WallTypeSwatch} pro
 * Band DASSELBE Muster zeichnet. `uid` macht interne <pattern>-IDs eindeutig
 * (mehrere Bänder je SVG).
 */
function hatchInner(hatch: HatchStyle, w: number, h: number, uid: string): React.ReactNode {
  const patId = `hsp_${uid}`;

  // Grundabstand der Musterlinien (px), über den Maßstab moduliert.
  const scale = hatch.scale > 0 ? hatch.scale : 1;
  const spacing = Math.max(3, 8 / Math.sqrt(scale));
  const angle = hatch.angle || 0;

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
  } else if (hatch.pattern === "solid") {
    inner = <rect x={0} y={0} width={w} height={h} fill="currentColor" />;
  } else if (hatch.pattern === "none") {
    inner = null;
  } else if (hatch.lines === "random") {
    // Zufällig verteilte kurze Striche (deterministisch geseedet). Dichte, Länge
    // und der explizite Seed spiegeln die Plan-Parameter (HatchStyle) — so ändert
    // „Neu würfeln"/Dichte/Länge die Vorschau wie im Plan. Rein schematisch (px),
    // NICHT deckungsgleich mit der Modell-Streuung, aber qualitativ konsistent.
    const density = hatch.density != null && hatch.density > 0 ? hatch.density : 1;
    const seed = (Math.round(scale * 1000) + Math.round(angle) + Math.round(hatch.seed ?? 0)) >>> 0;
    const rnd = mulberry32(seed);
    const count = Math.min(400, Math.max(4, Math.round((18 * Math.min(2, scale) + 6) * density)));
    // mm-Papier → Vorschau-px (wie das Dash-Muster im LineSwatch: ·4).
    const PX_PER_MM = 4;
    const hasRange =
      hatch.lengthMin != null && hatch.lengthMax != null &&
      hatch.lengthMin > 0 && hatch.lengthMax >= hatch.lengthMin;
    const baseLen = Math.max(3, 6 / Math.sqrt(scale));
    const out: React.ReactNode[] = [];
    for (let i = 0; i < count; i++) {
      const cx = rnd() * w;
      const cy = rnd() * h;
      const ang = rnd() * Math.PI;
      const lr = rnd();
      const len = hasRange
        ? (hatch.lengthMin! + lr * (hatch.lengthMax! - hatch.lengthMin!)) * PX_PER_MM
        : baseLen;
      const dx = (Math.cos(ang) * len) / 2;
      const dy = (Math.sin(ang) * len) / 2;
      out.push(
        <line
          key={i}
          x1={cx - dx}
          y1={cy - dy}
          x2={cx + dx}
          y2={cy + dy}
          stroke="currentColor"
          strokeWidth={0.9}
          strokeLinecap="round"
        />,
      );
    }
    inner = out;
  } else if (hatch.pattern === "crosshatch") {
    inner = [
      ...parallelLines(w, h, angle, spacing, 0.8, "a"),
      ...parallelLines(w, h, angle + 90, spacing, 0.8, "b"),
    ];
  } else if (hatch.pattern === "insulation") {
    // Dämmung: eine gewellte Schar quer über die Box (angenähert als Zickzack).
    const rows = Math.max(2, Math.round(h / Math.max(6, spacing)));
    const out: React.ReactNode[] = [];
    for (let r = 0; r < rows; r++) {
      const y = ((r + 0.5) / rows) * h;
      const amp = Math.min(h / rows / 2, 3);
      const waves = Math.max(2, Math.round(w / 6));
      let d = `M 0 ${y}`;
      for (let i = 1; i <= waves; i++) {
        const x = (i / waves) * w;
        const yy = y + (i % 2 === 0 ? -amp : amp);
        d += ` L ${x.toFixed(1)} ${yy.toFixed(1)}`;
      }
      out.push(
        <path key={r} d={d} fill="none" stroke="currentColor" strokeWidth={0.8} />,
      );
    }
    inner = out;
  } else {
    // "diagonal" (Default): eine parallele Schar.
    inner = parallelLines(w, h, angle, spacing, 0.8, "d");
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
            {b.hatch && hatchInner(b.hatch, b.bw, b.bh, `${rawId}_${i}`)}
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
  const px = Math.max(1, Math.min(6, style.weight * 6));
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

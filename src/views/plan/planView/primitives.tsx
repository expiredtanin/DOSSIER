// Reine SVG-Darstellung der Plan-Primitive: Schraffur-<pattern>s, gebündelte
// 2D-Zeichen-Läufe, das „andere grau"-Umfärben und der grosse Primitiv→SVG-
// Renderer. Bekommt `toScreen`/Massstab-Parameter gereicht, kein eigener
// Zugriff auf PlanView-internen State.

import type { HatchRender, Primitive } from "../../../core";
import { NO_HATCH } from "../../../core";
import { layoutText, stampBlockLines, wrapPlainText } from "../../../text/renderHtml";
import type { Vec2 } from "../../../model/types";
import { quantizePen } from "../../../export/sceneToPrintSvg";
import { buildRandomHatchRuns, zigzagPoints, motifPoints, DASH_MM_TO_M } from "../../../core";
import { dashHasDot } from "../../../core";
import { HAIRLINE_PX, PX_PER_M, mmToPx, printStrokeVb, visibleEdgeRuns } from "../../../core";

/** Basis-Kachelmaß (viewBox-Einheiten) einer Bild-Schraffur bei scaleX/scaleY = 1. */
const IMG_TILE_VB = 40;

/** Lineare/Kreuz-Muster brauchen ein <pattern>; solid/none nicht. */
export function needsPattern(pattern: HatchRender["pattern"]): boolean {
  return (
    pattern === "insulation" ||
    pattern === "diagonal" ||
    pattern === "crosshatch" ||
    pattern === "custom"
  );
}

/**
 * Ob ein Polygon einen SVG-Fill-Server aus `<defs>` braucht (`<pattern>` ODER
 * `<linearGradient>`/`<radialGradient>` — beide lassen sich identisch per
 * `fill="url(#id)"` referenzieren):
 *  • Bild-Schraffur (`kind==="image"`) → ja (gekacheltes Bild-Muster).
 *  • Verlauf-Schraffur (`kind==="gradient"`) → ja (Farbverlauf).
 *  • Random-Vektor (`lines==="random"`) → NEIN: die Streu-Striche werden als
 *    geclippte Polylinien direkt gezeichnet (Determinismus, Parität zu GL/PDF).
 *  • sonst die klassischen Parallel-/Kreuz-/Dämmungs-Muster.
 */
export function polyUsesPattern(h: HatchRender): boolean {
  if (h.kind === "image") return !!h.image;
  if (h.kind === "gradient") return !!h.gradient;
  if (h.lines === "random") return false;
  return needsPattern(h.pattern);
}

/**
 * Ein parametrisiertes Schraffur-<pattern>. Maßstab skaliert die Kachelgröße,
 * Winkel dreht das Muster (patternTransform), Farbe/Linienstärke kommen aus dem
 * aufgelösten Hatch/LineStyle. Die Musterlinie ist ein GEWÖHNLICHER Papier-mm-
 * Stift (wie jede andere Linie) — dieselbe Display-/Print-Logik wie
 * `renderPrimitive`: Display = konstante Haarlinie (Bildschirm-px, via
 * non-scaling-stroke), Print = echte, PEN_STEPS-gequantelte Papier-mm.
 */
export function HatchPattern({
  id,
  hatch,
  hairline,
  paperScale,
}: {
  id: string;
  hatch: HatchRender;
  hairline: boolean;
  paperScale: number | null;
}) {
  const print = !hairline && paperScale != null && paperScale > 0;
  const sw = hairline
    ? HAIRLINE_PX
    : print
      ? printStrokeVb(quantizePen(hatch.lineWeight), paperScale!)
      : mmToPx(hatch.lineWeight);
  const vfx = print ? undefined : ("non-scaling-stroke" as const);
  const dashes = hatch.dash?.length
    ? hatch.dash
        .map((mm) => (print ? printStrokeVb(mm, paperScale!) : mmToPx(mm)))
        .join(" ")
    : undefined;
  // Punktmuster in den Musterlinien: runde Kappe → Dots (Punkt/Strich-Punkt).
  const dashCap = dashHasDot(hatch.dash) ? ("round" as const) : undefined;

  if (hatch.kind === "image" && hatch.image) {
    // Bild-Schraffur: gekacheltes <image>-Muster. Kachel-Basismaß in viewBox-
    // Einheiten, unabhängig in L×B verzerrt (scaleX/scaleY), um `rotation` gedreht.
    // preserveAspectRatio="none" erlaubt die Verzerrung.
    const img = hatch.image;
    const w = Math.max(1, IMG_TILE_VB * (img.scaleX > 0 ? img.scaleX : 1));
    const h = Math.max(1, IMG_TILE_VB * (img.scaleY > 0 ? img.scaleY : 1));
    return (
      <pattern
        id={id}
        patternUnits="userSpaceOnUse"
        width={w}
        height={h}
        patternTransform={img.rotation ? `rotate(${img.rotation})` : undefined}
      >
        <image href={img.src} x={0} y={0} width={w} height={h} preserveAspectRatio="none" />
      </pattern>
    );
  }

  if (hatch.kind === "gradient" && hatch.gradient) {
    // Verlauf-Schraffur: <linearGradient>/<radialGradient> statt <pattern> —
    // SVG referenziert beide identisch über `fill="url(#id)"`, der Aufrufer
    // (renderPrimitive) muss NICHT unterscheiden. objectBoundingBox (SVG-
    // Default) spannt 0..1 relativ zur Polygon-Bbox auf, unabhängig vom
    // aktuellen Zoom/Massstab.
    const g = hatch.gradient;
    if (g.type === "radial") {
      return (
        <radialGradient id={id}>
          <stop offset="0%" stopColor={g.color1} />
          <stop offset="100%" stopColor={g.color2} />
        </radialGradient>
      );
    }
    const rad = (g.angle * Math.PI) / 180;
    const dx = Math.cos(rad) / 2;
    const dy = Math.sin(rad) / 2;
    return (
      <linearGradient id={id} x1={0.5 - dx} y1={0.5 - dy} x2={0.5 + dx} y2={0.5 + dy}>
        <stop offset="0%" stopColor={g.color1} />
        <stop offset="100%" stopColor={g.color2} />
      </linearGradient>
    );
  }

  if (hatch.pattern === "insulation") {
    // Weiche Zickzack-/Wellenlinie (SIA-nah). Kachel 14×10 × Maßstab.
    const w = 14 * hatch.scale;
    const h = 10 * hatch.scale;
    const my = 5 * hatch.scale;
    const qy1 = -1 * hatch.scale;
    const qy2 = 11 * hatch.scale;
    const qx1 = 3.5 * hatch.scale;
    const qx2 = 7 * hatch.scale;
    const qx3 = 10.5 * hatch.scale;
    return (
      <pattern
        id={id}
        patternUnits="userSpaceOnUse"
        width={w}
        height={h}
        patternTransform={`rotate(${hatch.angle})`}
      >
        <path
          d={`M0 ${my} Q ${qx1} ${qy1} ${qx2} ${my} Q ${qx3} ${qy2} ${w} ${my}`}
          fill="none"
          stroke={hatch.color}
          strokeWidth={sw}
          strokeDasharray={dashes}
          strokeLinecap={dashCap}
          vectorEffect={vfx}
        />
      </pattern>
    );
  }

  if (
    hatch.pattern === "custom" &&
    hatch.motif &&
    hatch.motif.points.length >= 2 &&
    hatch.motif.length > 1e-6
  ) {
    // Frei gezeichnetes Motiv: EINE Wiederhollänge (Papier-mm → viewBox über
    // `hatch.scale`) per `motifPoints` entlang eines vertikalen Referenz-
    // segments (0,0)→(0,period) tesselliert und als <path> in die Kachel
    // gelegt — dieselbe „Musterlinie läuft entlang der Kachel-y-Achse"-
    // Konvention wie diagonal/crosshatch (Zeilenabstand `rowSpacing` = Kachel-
    // breite, wie deren `tile`; das Motiv selbst bestimmt die Kachelhöhe).
    const rowSpacing = 8 * hatch.scale;
    const period = hatch.motif.length * hatch.scale;
    const pts = motifPoints({ x: 0, y: 0 }, { x: 0, y: period }, hatch.motif, hatch.scale);
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x} ${p.y}`).join(" ");
    return (
      <pattern
        id={id}
        patternUnits="userSpaceOnUse"
        width={rowSpacing}
        height={period}
        patternTransform={`rotate(${hatch.angle})`}
      >
        <path
          d={d}
          fill="none"
          stroke={hatch.color}
          strokeWidth={sw}
          strokeDasharray={dashes}
          strokeLinecap={dashCap}
          vectorEffect={vfx}
        />
      </pattern>
    );
  }

  // Diagonal + Crosshatch (+ "custom" ohne gesetztes Motiv, s. o. — degradiert
  // bewusst zu geraden Linien statt abzustürzen): dünne Linien, Winkel via
  // patternTransform.
  // Kachel 8×8 × Maßstab; crosshatch fügt eine zweite, senkrechte Schar hinzu.
  const tile = 8 * hatch.scale;
  return (
    <pattern
      id={id}
      patternUnits="userSpaceOnUse"
      width={tile}
      height={tile}
      patternTransform={`rotate(${hatch.angle})`}
    >
      <line
        x1={0}
        y1={0}
        x2={0}
        y2={tile}
        stroke={hatch.color}
        strokeWidth={sw}
        strokeDasharray={dashes}
        strokeLinecap={dashCap}
        vectorEffect={vfx}
      />
      {hatch.pattern === "crosshatch" && (
        <line
          x1={0}
          y1={0}
          x2={tile}
          y2={0}
          stroke={hatch.color}
          strokeWidth={sw}
          strokeDasharray={dashes}
          strokeLinecap={dashCap}
          vectorEffect={vfx}
        />
      )}
    </pattern>
  );
}

/**
 * Ein zusammenhängender 2D-Zeichen-Linienzug (aus gemergten line-Primitiven):
 * verkettete Punkte + gemeinsamer Stil. `closed` ⇒ als Ring (polygon) zeichnen,
 * damit auch die Schluss-Ecke gehrt. Reine Darstellung.
 */
export interface DrawingRun {
  pts: Vec2[];
  closed: boolean;
  cls: string;
  weightMm: number;
  dash: number[] | null | undefined;
  color?: string;
  greyed?: boolean;
  /** Zickzack-Parameter (Papier-mm); gesetzt ⇒ Lauf als Zickzack-Pfad zeichnen. */
  zigzag?: { amplitude: number; wavelength: number };
  /** Custom-Motiv (Papier-mm); gesetzt ⇒ Lauf als gekacheltes Motiv zeichnen. */
  motif?: { points: Vec2[]; length: number };
}

/** Kleiner Toleranz-Test auf Punktgleichheit (Modell-Meter). */
const samePt = (a: Vec2, b: Vec2): boolean =>
  Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9;

/** Ob zwei line-Primitive denselben Stil (für einen gemeinsamen Zug) tragen. */
function sameLineStyle(
  a: Extract<Primitive, { kind: "line" }>,
  b: Extract<Primitive, { kind: "line" }>,
): boolean {
  return (
    a.drawingId === b.drawingId &&
    a.cls === b.cls &&
    a.color === b.color &&
    a.weightMm === b.weightMm &&
    !!a.greyed === !!b.greyed &&
    JSON.stringify(a.dash ?? null) === JSON.stringify(b.dash ?? null)
  );
}

/**
 * Bündelt aufeinanderfolgende 2D-Zeichen-Linien (mit drawingId) zu verketteten
 * Zügen (End-an-Start). Erkennt Ringschluss (letzter == erster Punkt) → `closed`.
 * Linien ohne drawingId (Wand-/Tür-/Kontext-Striche) bleiben unberührt (nicht
 * enthalten). Reihenfolge-stabil in Auftreten der Primitive.
 */
export function buildDrawingRuns(prims: Primitive[]): DrawingRun[] {
  const runs: DrawingRun[] = [];
  let curPts: Vec2[] | null = null;
  let curSrc: Extract<Primitive, { kind: "line" }> | null = null;
  const flush = () => {
    if (curPts && curSrc && curPts.length >= 2) {
      const closed = curPts.length > 2 && samePt(curPts[0], curPts[curPts.length - 1]);
      runs.push({
        pts: closed ? curPts.slice(0, -1) : curPts,
        closed,
        cls: curSrc.cls,
        weightMm: curSrc.weightMm,
        dash: curSrc.dash,
        color: curSrc.color,
        greyed: curSrc.greyed,
      });
    }
    curPts = null;
    curSrc = null;
  };

  for (const p of prims) {
    if (p.kind !== "line" || !p.drawingId) {
      flush();
      continue;
    }
    // Zickzack-Linien werden NICHT verkettet (jede als eigener Zickzack-Lauf) —
    // sonst würde die Tessellierung über eine Gehrung hinweg zerreißen.
    if (p.zigzag) {
      flush();
      runs.push({
        pts: [p.a, p.b],
        closed: false,
        cls: p.cls,
        weightMm: p.weightMm,
        dash: p.dash,
        color: p.color,
        greyed: p.greyed,
        zigzag: p.zigzag,
      });
      continue;
    }
    // Custom-Motiv-Linien ebenfalls einzeln (analog Zickzack).
    if (p.motif) {
      flush();
      runs.push({
        pts: [p.a, p.b],
        closed: false,
        cls: p.cls,
        weightMm: p.weightMm,
        dash: p.dash,
        color: p.color,
        greyed: p.greyed,
        motif: p.motif,
      });
      continue;
    }
    if (curPts && curSrc && sameLineStyle(curSrc, p) && samePt(curPts[curPts.length - 1], p.a)) {
      // An den laufenden Zug anhängen.
      curPts.push(p.b);
    } else {
      // Neuen Zug beginnen.
      flush();
      curPts = [p.a, p.b];
      curSrc = p;
    }
  }
  flush();
  return runs;
}

/**
 * Fester Grauton gedimmter Primitive im Darstellungsmodus „andere grau" —
 * ECHTE Umfärbung (nicht nur Deckkraft), da dünne Haarlinien auf dem hellen
 * Zeichenblatt (--sheet: #f0f0f0) bei reiner Transparenz kaum erkennbar
 * gedimmt wirken. Gleicher Ton in allen drei Render-Pfaden (SVG/WebGL/nativ,
 * siehe glPlanCompile.ts `GREY_RGB` und toRenderScene.ts `GREY_RGB`).
 */
export const GREYED_COLOR = "#8c8c8c";

/** Ersetzt Fill-/Stroke-/Farbfelder (inkl. Schraffur) eines Primitivs durch den festen Grauton. */
export function greyColor(c: string | undefined): string | undefined {
  return !c || c === "none" || c === "transparent" ? c : GREYED_COLOR;
}

/**
 * Flache Kopie eines Primitivs, gedimmt für den Hintergrund: die Flächen-
 * Grundfüllung bleibt WEISS (Nutzer-Wunsch: "im Hintergrund nicht als graue
 * Fläche gefüllt"), aber echte Schraffur-LINIEN (Kreuz/Parallel/Dämmung/Kies)
 * bleiben sichtbar — nur grau eingefärbt statt in ihrer Bauteilfarbe (Nutzer-
 * Präzisierung: "Schraffuren selber sollten sichtbar sein, also die Linien
 * davon"). Nur eine reine VOLLFÜLLUNG ("solid", hat keine eigenen Linien) und
 * Bild-Schraffuren (keine sinnvolle Grau-Variante) weichen auf `NO_HATCH` —
 * sonst bliebe die Fläche grau bzw. in voller Bild-Farbe gefüllt.
 */
export function greyedCopy<T extends Primitive>(p: T): T {
  const q: any = { ...p };
  if ("fill" in q && q.fill && q.fill !== "none") q.fill = "#ffffff";
  if ("stroke" in q) q.stroke = greyColor(q.stroke);
  if ("color" in q) q.color = greyColor(q.color);
  if ("hatch" in q && q.hatch) {
    const noLines = q.hatch.pattern === "solid" || q.hatch.kind === "image";
    q.hatch = noLines
      ? { ...NO_HATCH, color: greyColor(q.hatch.color) }
      : { ...q.hatch, color: greyColor(q.hatch.color) };
  }
  return q;
}

/** Zeichnet einen gebündelten 2D-Zeichen-Zug als EIN Element (gehrte Ecken). */
export function DrawingRunShape({
  run,
  toScreen,
  hairline,
  paperScale,
}: {
  run: DrawingRun;
  toScreen: (v: Vec2) => Vec2;
  hairline: boolean;
  paperScale: number | null;
}) {
  const print = !hairline && paperScale != null && paperScale > 0;
  const sw = hairline
    ? HAIRLINE_PX
    : print
      ? printStrokeVb(quantizePen(run.weightMm), paperScale!)
      : mmToPx(run.weightMm);
  const vfx = print ? undefined : ("non-scaling-stroke" as const);
  const dashStr =
    run.dash && run.dash.length
      ? run.dash
          .map((mm) => (print ? printStrokeVb(mm, paperScale!) : mmToPx(mm)))
          .join(" ")
      : undefined;
  // Zickzack-/Custom-Motiv-Lauf: im MODELL-Raum tessellieren (Papier-mm →
  // Modell-Meter via DASH_MM_TO_M), dann toScreen. Sonst die Roh-Stützpunkte.
  const modelPts = run.zigzag
    ? zigzagPoints(
        run.pts[0],
        run.pts[run.pts.length - 1],
        run.zigzag.amplitude * DASH_MM_TO_M,
        run.zigzag.wavelength * DASH_MM_TO_M,
      )
    : run.motif
      ? motifPoints(run.pts[0], run.pts[run.pts.length - 1], run.motif, DASH_MM_TO_M)
      : run.pts;
  const pts = modelPts.map(toScreen).map((s) => `${s.x},${s.y}`).join(" ");
  // Punktmuster (dash enthält eine 0): runde Kappe, damit die 0-Längen-Segmente
  // als Dots erscheinen (Punktlinie / Strich-Punkt).
  const cap = dashHasDot(run.dash) ? ("round" as const) : undefined;
  const stroke = run.greyed ? greyColor(run.color) : run.color;
  const shape = run.closed ? (
    <polygon
      points={pts}
      className={run.cls}
      fill="none"
      stroke={stroke}
      strokeWidth={sw}
      strokeDasharray={dashStr}
      strokeLinecap={cap}
      vectorEffect={vfx}
    />
  ) : (
    <polyline
      points={pts}
      className={run.cls}
      fill="none"
      stroke={stroke}
      strokeWidth={sw}
      strokeDasharray={dashStr}
      strokeLinecap={cap}
      vectorEffect={vfx}
    />
  );
  return shape;
}

export function PrimitiveShape({
  p,
  index,
  toScreen,
  hairline,
  paperScale,
}: {
  p: Primitive;
  index: number;
  toScreen: (v: Vec2) => Vec2;
  hairline: boolean;
  paperScale: number | null;
}) {
  // Gedimmte Elemente werden auf den festen Grauton umgefärbt (Strich, Füllung
  // UND Schraffur) — deutlich erkennbar unabhängig von Papierfarbe/Linienstärke.
  const shape = renderPrimitive(p.greyed ? greyedCopy(p) : p, index, toScreen, hairline, paperScale);
  // Objekt-Transparenz (Drawing2D.opacity, im Kern aufgestempelt, `plan/drawings.rs`) als
  // eine Hülle darüber — so muss sie nicht in jeden Primitiv-Zweig eingebaut
  // werden und wirkt gleichermassen auf Strich, Füllung und Schraffur.
  const op = p.kind === "drawingImage" ? undefined : p.opacity;
  if (op !== undefined && op < 1 && shape) {
    return (
      <g opacity={Math.max(0, op)} key={index}>
        {shape}
      </g>
    );
  }
  return shape;
}

/** Erzeugt das reine SVG eines Primitivs (ohne Dimm-Hülle). */
export function renderPrimitive(
  p: Primitive,
  index: number,
  toScreen: (v: Vec2) => Vec2,
  hairline: boolean,
  paperScale: number | null,
) {
  // Print-Modus nur, wenn ein Referenz-Massstab vorliegt; sonst (bzw. Display)
  // gilt der bisherige non-scaling-Pfad. Beide Modi setzen die GLEICHEN
  // Präsentationsattribute (nur Wert + vectorEffect unterscheiden sich).
  const print = !hairline && paperScale != null && paperScale > 0;
  // Strichstärke:
  //  • Display  → konstante Haarlinie (Bildschirm-px), papierunabhängig.
  //  • Print    → echte Papier-mm, VORHER auf die PEN_STEPS-Stiftstufe
  //    gequantelt (identisch zum PDF-Export, `quantizePen` aus
  //    `sceneToPrintSvg.ts`), dann in viewBox-Einheiten (skaliert mit dem
  //    Zoom) — so zeigt die Vorschau exakt die Strichbreite, die auch gedruckt
  //    wird.
  const weight = (mm: number): number =>
    hairline ? HAIRLINE_PX : print ? printStrokeVb(quantizePen(mm), paperScale!) : mmToPx(mm);
  // vectorEffect: non-scaling NUR, wenn NICHT im Print-Modus (Print skaliert die
  // Linie bewusst mit der Geometrie). undefined ⇒ Attribut entfällt.
  const vfx = print ? undefined : ("non-scaling-stroke" as const);
  // Strichmuster: im Print-Modus ebenfalls in viewBox-Einheiten (skaliert mit),
  // sonst wie bisher in Bildschirm-px (non-scaling).
  const dashOf = (dash: number[] | null | undefined): string | undefined => {
    if (!dash || !dash.length) return undefined;
    return dash
      .map((mm) => (print ? printStrokeVb(mm, paperScale!) : mmToPx(mm)))
      .join(" ");
  };
  switch (p.kind) {
    case "polygon": {
      const scr = p.pts.map(toScreen);
      const pts = scr.map((s) => `${s.x},${s.y}`).join(" ");
      // Umriss-Strichstärke in mm Papier (Display: konstante px / Print: skaliert).
      const sw = weight(p.strokeWidthMm);
      // Innere Gehrungs-Stirnkanten am Wandknoten (noStrokeEdges) NICHT stricheln:
      // die Füllung bleibt das volle Polygon, aber die Diagonale am Knoten (Naht)
      // und die überschießende Eck-Barbe entfallen. Sichtbare Kanten werden als
      // zusammenhängende offene <polyline>-Läufe gezeichnet (keine Gehrung über
      // die weggelassene Kante). Leeres/kein noStrokeEdges ⇒ voller Umriss.
      const noStroke = p.noStrokeEdges;
      const outline = () => {
        if (!noStroke || noStroke.length === 0) {
          return (
            <polygon points={pts} fill="none" stroke={p.stroke} strokeWidth={sw} vectorEffect={vfx} />
          );
        }
        const runs = visibleEdgeRuns(scr, noStroke);
        return (
          <>
            {runs.map((run, ri) => (
              <polyline
                key={`e${ri}`}
                points={run.map((s) => `${s.x},${s.y}`).join(" ")}
                fill="none"
                stroke={p.stroke}
                strokeWidth={sw}
                vectorEffect={vfx}
              />
            ))}
          </>
        );
      };
      // Bild-Schraffur: Grundfüllung + gekacheltes Bild-Muster (<pattern> aus
      // <defs>, id=hatch-index) + Umriss — unabhängig vom `pattern`-Feld.
      if (p.hatch.kind === "image" && p.hatch.image) {
        return (
          <g>
            <polygon points={pts} fill={p.fill} stroke="none" />
            <polygon points={pts} fill={`url(#hatch-${index})`} stroke="none" />
            {outline()}
          </g>
        );
      }
      // Verlauf-Schraffur: der Verlauf (<linearGradient>/<radialGradient> aus
      // <defs>, id=hatch-index) deckt die Fläche vollständig ab — keine
      // separate Grundfüllung nötig, unabhängig vom `pattern`-Feld.
      if (p.hatch.kind === "gradient" && p.hatch.gradient) {
        return (
          <g>
            <polygon points={pts} fill={`url(#hatch-${index})`} stroke="none" />
            {outline()}
          </g>
        );
      }
      // Random-Vektor-Schraffur (Kies/Splitt): Grundfüllung + deterministische
      // Streu-Striche (im MODELL-Raum erzeugt → toScreen; identischer Seed wie
      // GL/PDF) + Umriss. KEIN <pattern> (die Striche werden direkt gezeichnet).
      if (p.hatch.kind !== "image" && p.hatch.lines === "random") {
        const hsw = weight(p.hatch.lineWeight > 0 ? p.hatch.lineWeight : 0.13);
        const runs = buildRandomHatchRuns(p.pts, p.hatch);
        return (
          <g>
            <polygon points={pts} fill={p.fill} stroke="none" />
            {runs.map((run, ri) => (
              <polyline
                key={`r${ri}`}
                points={run.map(toScreen).map((s) => `${s.x},${s.y}`).join(" ")}
                fill="none"
                stroke={p.hatch.color}
                strokeWidth={hsw}
                vectorEffect={vfx}
              />
            ))}
            {outline()}
          </g>
        );
      }
      // Ohne Schraffur: reine Component-Füllung bzw. „none" (nur Umriss).
      if (p.hatch.pattern === "none") {
        return (
          <g>
            <polygon points={pts} fill={p.fill} stroke="none" />
            {outline()}
          </g>
        );
      }
      // Vollfüllung: Schraffurfarbe deckt die Component-Füllung (Poché).
      if (p.hatch.pattern === "solid") {
        return (
          <g>
            <polygon points={pts} fill={p.hatch.color} stroke="none" />
            {outline()}
          </g>
        );
      }
      // Linien-/Kreuz-Schraffur: erst Grundfüllung, dann Muster, dann Umriss.
      return (
        <g>
          <polygon points={pts} fill={p.fill} stroke="none" />
          <polygon points={pts} fill={`url(#hatch-${index})`} stroke="none" />
          {outline()}
        </g>
      );
    }
    case "line": {
      const a = toScreen(p.a);
      const b = toScreen(p.b);
      // Zickzack-Linie: als Polylinie (im MODELL-Raum tesselliert → toScreen;
      // amplitude/wavelength Papier-mm → Modell-Meter via DASH_MM_TO_M, wie
      // GL/PDF). ADDITIV — gerade/gestrichelte Linien bleiben unverändert.
      if (p.zigzag) {
        const zpts = zigzagPoints(
          p.a,
          p.b,
          p.zigzag.amplitude * DASH_MM_TO_M,
          p.zigzag.wavelength * DASH_MM_TO_M,
        ).map(toScreen);
        return (
          <polyline
            points={zpts.map((s) => `${s.x},${s.y}`).join(" ")}
            className={p.cls}
            fill="none"
            stroke={p.color}
            strokeWidth={weight(p.weightMm)}
            vectorEffect={vfx}
          />
        );
      }
      // Custom-Motiv: gekachelt im MODELL-Raum (Papier-mm → Modell-Meter), analog
      // Zickzack. ADDITIV — gerade/gestrichelte Linien bleiben unverändert.
      if (p.motif) {
        const mpts = motifPoints(p.a, p.b, p.motif, DASH_MM_TO_M).map(toScreen);
        return (
          <polyline
            points={mpts.map((s) => `${s.x},${s.y}`).join(" ")}
            className={p.cls}
            fill="none"
            stroke={p.color}
            strokeWidth={weight(p.weightMm)}
            vectorEffect={vfx}
          />
        );
      }
      // Strichstärke + Strichmuster in mm Papier. Die Farbe kommt weiterhin aus
      // der CSS-Klasse (z. B. .door-leaf / .wall-axis).
      return (
        <line
          x1={a.x}
          y1={a.y}
          x2={b.x}
          y2={b.y}
          className={p.cls}
          stroke={p.color}
          strokeWidth={weight(p.weightMm)}
          strokeDasharray={dashOf(p.dash)}
          strokeLinecap={dashHasDot(p.dash) ? "round" : undefined}
          vectorEffect={vfx}
        />
      );
    }
    case "arc": {
      const c = toScreen(p.center);
      const from = toScreen(p.from);
      const to = toScreen(p.to);
      const r = p.r * PX_PER_M;
      // Kurzer Weg (≤180°): large-arc = 0. Drehrichtung aus Kreuzprodukt
      // im Bildschirmraum (y nach unten).
      const v1 = { x: from.x - c.x, y: from.y - c.y };
      const v2 = { x: to.x - c.x, y: to.y - c.y };
      const cross = v1.x * v2.y - v1.y * v2.x;
      const sweep = cross > 0 ? 1 : 0;
      const d = `M ${from.x} ${from.y} A ${r} ${r} 0 0 ${sweep} ${to.x} ${to.y}`;
      return (
        <path
          d={d}
          className={p.cls}
          strokeWidth={weight(p.weightMm)}
          strokeDasharray={dashOf(p.dash)}
          strokeLinecap={dashHasDot(p.dash) ? "round" : undefined}
          vectorEffect={vfx}
        />
      );
    }
    case "text": {
      const c = toScreen(p.at);
      // Punkt → viewBox-Einheiten. Physisch: basePt pt bei Massstab 1:N belegt
      // basePt/72·0.0254·N Modell-Meter; im Display-Modus gilt der Referenz-
      // massstab 1:100 (der Stempel skaliert dann mit dem Zoom, am Modell
      // verankert). unitPerPt bildet 1 pt auf viewBox-Einheiten ab.
      const nRef = print ? paperScale! : 100;
      const unitPerPt = (1 / 72) * 0.0254 * nRef * PX_PER_M;
      // Rich-Text-Zeilen (Stempel-Doc) + LIVE-Zusatzzeilen (Fläche/SIA) darunter, Block vertikal
      // um den Anker zentriert (Kern `stamp_block`, absatzeigene Zeilenhöhen inbegriffen).
      const lines = stampBlockLines(p, unitPerPt, c.x, c.y);
      if (lines.length === 0) return null;
      return (
        <text style={{ pointerEvents: "none", userSelect: "none" }}>
          {lines.map((line, k) => {
            return (
              <tspan
                key={k}
                x={line.x}
                y={line.y}
                textAnchor={line.anchor}
              >
                {line.tspans.map((ts, j) => (
                  <tspan
                    key={j}
                    fontSize={ts.fontSize}
                    fontWeight={ts.fontWeight}
                    fontStyle={ts.fontStyle}
                    fontFamily={ts.fontFamily ?? "var(--font-ui, sans-serif)"}
                    fill={ts.fill}
                    textDecoration={ts.textDecoration}
                  >
                    {ts.text}
                  </tspan>
                ))}
              </tspan>
            );
          })}
        </text>
      );
    }
    case "drawingImage": {
      // Eingebettetes Rasterbild (Foto/Logo/gerasterte PDF-Seite), achsparallel.
      // Screen-Y ist gespiegelt (toScreen) → oben-links = (min.x, max.y).
      const topLeft = toScreen(p.max);
      const w = (p.max.x - p.min.x) * PX_PER_M;
      const h = (p.max.y - p.min.y) * PX_PER_M;
      if (w <= 0 || h <= 0) return null;
      return (
        <image
          href={p.src}
          x={toScreen(p.min).x}
          y={topLeft.y}
          width={w}
          height={h}
          opacity={(p.greyed ? 0.45 : 1) * p.opacity}
          preserveAspectRatio="none"
        />
      );
    }
    case "drawingText": {
      // Modellverankerter Einzeltext (DXF-Import / Text-Werkzeug): Höhe in Metern →
      // viewBox-Einheiten (skaliert mit dem Zoom), Baseline am Ankerpunkt (links).
      const c = toScreen(p.at);
      const fontSize = p.heightM * PX_PER_M;
      // Modell-Winkel CCW; Screen-Y ist gespiegelt und SVG-rotate CW-positiv → -deg.
      const deg = -(p.angle * 180) / Math.PI;

      // Reiches Textfeld (InDesign-artig, mehrere Absätze/gemischte Formatierung):
      // hat Vorrang vor dem Alt-Pfad (einfacher String + einheitliche `marks`)
      // weiter unten. Bricht bei gesetzter Spaltenbreite wortweise um (Run-Grenzen
      // bleiben erhalten); Zeilen samt Lage aus dem Kern (`layoutText`).
      if (p.doc) {
        const wrapWidthUnits = p.wrapWidth && p.wrapWidth > 0 ? p.wrapWidth * PX_PER_M : undefined;
        const docLines = layoutText(p.doc, {
          x: c.x,
          y: c.y,
          lineHeight: fontSize * 1.25,
          unitPerPt: (0.0254 / 72) * PX_PER_M,
          basePt: (p.heightM / 0.0254) * 72,
          color: p.color,
          wrapWidthUnits,
          columnWidth: wrapWidthUnits,
        });
        if (docLines.length === 0) return null;
        return (
          <text
            opacity={p.greyed ? 0.45 : undefined}
            transform={deg ? `rotate(${deg} ${c.x} ${c.y})` : undefined}
            style={{ pointerEvents: "none", userSelect: "none" }}
          >
            {docLines.map((line, k) => {
              return (
                <tspan key={k} x={line.x} y={line.y} textAnchor={line.anchor}>
                  {line.tspans.length === 0
                    ? "​"
                    : line.tspans.map((ts, j) => (
                        <tspan
                          key={j}
                          fontSize={ts.fontSize}
                          fontWeight={ts.fontWeight}
                          fontStyle={ts.fontStyle}
                          fontFamily={ts.fontFamily ?? "var(--font-ui, sans-serif)"}
                          fill={ts.fill}
                          textDecoration={ts.textDecoration}
                        >
                          {ts.text}
                        </tspan>
                      ))}
                </tspan>
              );
            })}
          </text>
        );
      }

      // Alt-Pfad: einfacher String + einheitliche `marks` (Text-Werkzeug/DXF-Import
      // ohne Rich-Doc) — unverändert.
      // Spaltentext: bei gesetzter `wrapWidth` den Text wortweise auf die Breite
      // umbrechen (Kern `wrap_plain`, Zeichenbreite ≈ 0.55·fontSize geschätzt), sonst eine Zeile.
      const lineH = fontSize * 1.25;
      const lines: string[] = p.wrapWidth && p.wrapWidth > 0 ? wrapPlainText(p.text, p.wrapWidth * PX_PER_M, fontSize) : [p.text];
      // Einheitliche Formatierung (Text-Werkzeug + Oberleisten-Formatier-Gruppe):
      // Schriftfamilie/fett/kursiv/Unterstreichung aus `marks`; Grösse bleibt über
      // heightM (Modell-Meter). Farbe steckt bereits in p.color (marks.color-Vorrang
      // in generatePlan aufgelöst).
      const mk = p.marks;
      const deco =
        mk && (mk.underline || mk.strike)
          ? [mk.underline ? "underline" : "", mk.strike ? "line-through" : ""].join(" ").trim()
          : undefined;
      return (
        <text
          x={c.x}
          y={c.y}
          fontSize={fontSize}
          fontFamily={mk?.font ?? "var(--font-ui, sans-serif)"}
          fontWeight={mk?.bold ? 700 : undefined}
          fontStyle={mk?.italic ? "italic" : undefined}
          textDecoration={deco}
          fill={p.color}
          opacity={p.greyed ? 0.45 : undefined}
          textAnchor="start"
          transform={deg ? `rotate(${deg} ${c.x} ${c.y})` : undefined}
          style={{ pointerEvents: "none", userSelect: "none" }}
        >
          {lines.length <= 1 ? (
            p.text
          ) : (
            lines.map((ln, li) => (
              <tspan key={li} x={c.x} dy={li === 0 ? 0 : lineH}>
                {ln === "" ? "​" : ln}
              </tspan>
            ))
          )}
        </text>
      );
    }
    case "drawingTextPath": {
      // Text-entlang-Pfad: unsichtbarer `<path>` (nur Geometrie-Träger) +
      // `<text><textPath>` — der Browser übernimmt die Zeichen-Positionierung
      // entlang der Kurve, keine eigene Glyphen-Transform-Mathematik nötig.
      if (p.pathPts.length < 2 || !p.text) return null;
      const screenPts = p.pathPts.map(toScreen);
      const d = `M ${screenPts.map((s) => `${s.x} ${s.y}`).join(" L ")}`;
      const fontSize = p.heightM * PX_PER_M;
      const pathId = `textpath-${p.drawingId ?? index}`;
      return (
        <>
          <path id={pathId} d={d} fill="none" style={{ pointerEvents: "none" }} />
          <text
            fontSize={fontSize}
            fill={p.color}
            opacity={p.greyed ? 0.45 : undefined}
            style={{ pointerEvents: "none", userSelect: "none" }}
          >
            <textPath href={`#${pathId}`}>{p.text}</textPath>
          </text>
        </>
      );
    }
    case "drawingCircle": {
      // Echtes `<circle>` — rund bei jedem Zoom (kein Vieleck). Füllung optional.
      const c = toScreen(p.center);
      const r = p.r * PX_PER_M;
      return (
        <circle
          cx={c.x}
          cy={c.y}
          r={r}
          fill={p.fill}
          stroke={p.stroke}
          strokeWidth={weight(p.weightMm)}
          strokeDasharray={dashOf(p.dash)}
          vectorEffect={vfx}
        />
      );
    }
    case "drawingArc": {
      // Glatter SVG-Bogen. Winkel in Radiant (CCW im Modell); Screen-Y ist
      // gespiegelt → ein modell-CCW-Bogen läuft am Bildschirm im Uhrzeigersinn
      // (SVG sweep-flag 1). large-arc aus der Spannweite (>π).
      const TAU = Math.PI * 2;
      const rPx = p.r * PX_PER_M;
      const from = toScreen({
        x: p.center.x + p.r * Math.cos(p.a0),
        y: p.center.y + p.r * Math.sin(p.a0),
      });
      const to = toScreen({
        x: p.center.x + p.r * Math.cos(p.a1),
        y: p.center.y + p.r * Math.sin(p.a1),
      });
      const sweep = (((p.a1 - p.a0) % TAU) + TAU) % TAU;
      const largeArc = sweep > Math.PI ? 1 : 0;
      const d = `M ${from.x} ${from.y} A ${rPx} ${rPx} 0 ${largeArc} 1 ${to.x} ${to.y}`;
      return (
        <path
          d={d}
          fill="none"
          stroke={p.stroke}
          strokeWidth={weight(p.weightMm)}
          strokeDasharray={dashOf(p.dash)}
          strokeLinecap={dashHasDot(p.dash) ? "round" : undefined}
          vectorEffect={vfx}
        />
      );
    }
  }
}

/**
 * Typen des WebGL2-GPU-Plan-Renderers.
 * Gemeinsamer Vertrag zwischen Shader-Kompilierung, Tessellierung und Render-Loop.
 *
 * Koordinaten-Konvention (WICHTIG, muss überall gleich sein):
 *  • Die Tessellierung liefert BILDSCHIRM-Raum-Koordinaten exakt wie `toScreen`
 *    in PlanView: `sx = mx·PX_PER_M`, `sy = -my·PX_PER_M` (Modell-Y zeigt nach
 *    oben, Bildschirm-Y nach unten). So ist die Projektion eine reine viewBox-
 *    Orthografie — kein zusätzlicher Skalen-/Spiegel-Schritt, deckungsgleich zum
 *    SVG-Renderer.
 *  • Linienbreiten sind BILDSCHIRM-KONSTANT (Papier-px): die Geometrie trägt eine
 *    Normale + Seiten-Flag, der Vertex-Shader expandiert erst im Clip-Raum um
 *    `strokePx` — unabhängig vom Zoom, ohne Re-Tessellierung.
 */

/** RGBA-Farbe, Komponenten in [0,1]. */
export type Rgba = [number, number, number, number];

/** Shader-Programm mit kompiliertem Programm + Attribut-/Uniform-Orten. */
export interface ShaderProgram {
  program: WebGLProgram;
  attribs: {
    position?: GLint;
    /** Bildschirm-Raum-Miter-Bisektor (Einheits-Versatzrichtung) für Linien. */
    normal?: GLint;
    /** Seite der Linie: +1 oder -1. */
    side?: GLint;
    /** Miter-Längenfaktor 1/cos(θ/2) (1 = gerade). */
    miter?: GLint;
  };
  uniforms: {
    viewProj?: WebGLUniformLocation | null;
    color?: WebGLUniformLocation | null;
    /** Basis-Strichbreite in Geräte-Pixeln (bei strokeScale=1). */
    strokePx?: WebGLUniformLocation | null;
    /** Zoom-Skalierung der Strichbreite (>1 = reingezoomt → dicker, Papier). */
    strokeScale?: WebGLUniformLocation | null;
    /** Zeichenpuffer-Größe in Geräte-Pixeln [w,h] (px→Clip-Umrechnung). */
    viewportPx?: WebGLUniformLocation | null;
  };
}

/** Ein Zeichen-Batch: zusammenhängender Index-Bereich mit einer Farbe. */
export interface FillBatch {
  startIndex: number;
  indexCount: number;
  color: Rgba;
}

/** Ein Linien-Batch: Index-Bereich mit Farbe + echter Papier-Strichbreite. */
export interface LineBatch {
  startIndex: number;
  indexCount: number;
  color: Rgba;
  /**
   * Strichbreite. Interpretation hängt von `screenPx` ab:
   *  • `screenPx` falsch (Standard) — ECHTE Papier-Millimeter. Der Renderer
   *    rechnet über den Massstab (1:N) + die aktuelle meet-Skala in Pixel —
   *    genau wie der SVG-`printStrokeVb`-Pfad (0.35 mm bei 1:100 = 0.35 mm
   *    Papier).
   *  • `screenPx` wahr — bereits eine BILDSCHIRM-Raum-Breite (viewBox-px, wie
   *    SVG-`hatchStrokePx`): skaliert NUR mit dem Zoom (`meet`), NICHT mit dem
   *    Papier-Massstab N. Für Schraffur-Musterlinien (s. `glPlanCompile`).
   */
  strokeMm: number;
  /** Siehe `strokeMm`-Doku: true = Bildschirm-Raum-px statt Papier-mm. */
  screenPx?: boolean;
}

/**
 * GPU-fertige Geometrie: getrennte Puffer für gefüllte Flächen (Poché) und
 * Striche (bildschirmkonstante Breite). Einmal je Plan tessellieren, danach
 * treibt nur die Projektionsmatrix Pan/Zoom.
 */
export interface GpuGeometry {
  /**
   * Beim Zeichnen gedimmt darstellen (Referenz-Ebene): Linien → festes Grau,
   * Füllungen → Weiss, jeweils mit erhaltenem Alpha — dieselbe Abbildung wie
   * `dim`/`dimFill` in glPlanCompile.ts, nur zur Zeichenzeit statt beim Kompilieren.
   */
  greyed?: boolean;
  /**
   * Lokaler Ursprung (Bildschirm-Raum), relativ zu dem alle Vertices dieser
   * Geometrie abgelegt sind. Fehlt er → (0,0). Der Renderer verschiebt die
   * Ansicht in doppelter Genauigkeit um diesen Wert.
   */
  origin?: { x: number; y: number };
  /** Gefüllte Polygone (Poché/Räume/Decken) — Bildschirm-Raum. */
  fill: {
    /** Interleaved [x,y, x,y, …] in Bildschirm-Raum. */
    positionBuffer: WebGLBuffer | null;
    indexBuffer: WebGLBuffer | null;
    batches: FillBatch[];
  };
  /** Striche — Bildschirm-Raum-Position + Normale + Seiten-Flag. */
  line: {
    /** Interleaved [x,y, nx,ny, side, …] in Bildschirm-Raum. */
    vertexBuffer: WebGLBuffer | null;
    indexBuffer: WebGLBuffer | null;
    batches: LineBatch[];
  };
  /** Modell-Bounds (Meter) für Debug/Einpassen; nicht render-kritisch. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

/** Rechteckiger Ausschnitt in Bildschirm-Einheiten (viewBox). */
export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

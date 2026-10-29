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

/**
 * Der Teil des GL-Kontexts, den Kompilierung + Chunk-Cache wirklich brauchen:
 * Puffer anlegen/befüllen/freigeben. WebGL2 erfüllt das direkt; der native
 * Renderer (nativeGl.ts) liefert eine Attrappe, die die Bytes an Rust schickt.
 */
export interface BufferGl {
  /**
   * Linien-Vertices kompakt (12 statt 24 Byte): [x,y als float32, dann 4 Bytes
   * snorm8 = nx, ny, side, miter]. Nur der native Renderer (chunks.rs) liest das;
   * der WebGL-Pfad bleibt beim 6-Float-Layout.
   */
  readonly packedLineVertices?: boolean;
  readonly ARRAY_BUFFER: number;
  readonly ELEMENT_ARRAY_BUFFER: number;
  readonly STATIC_DRAW: number;
  createBuffer(): WebGLBuffer | null;
  bindBuffer(target: number, buffer: WebGLBuffer | null): void;
  bufferData(target: number, data: ArrayBufferView, usage: number): void;
  deleteBuffer(buffer: WebGLBuffer | null): void;
}

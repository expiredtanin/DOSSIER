/**
 * WebGL2-Render-Loop des GPU-Grundrisses.
 *
 * Zeichnet zwischengespeicherte GPU-Geometrie (aus glPlanCompile) und aktualisiert
 * beim Pan/Zoom NUR die Projektionsmatrix (kein Re-Tessellieren). Getrieben vom
 * Aufrufer (PlanView-Pan/Zoom-Handler), nicht per requestAnimationFrame.
 */

import type { GpuGeometry, ShaderProgram, ViewBox } from './glPlanTypes';

/** viewBox-Einheiten je Meter (identisch zu PlanView/toScreen). */
const PX_PER_M = 90;

/** 4×4-Einheitsmatrix (Spalten-Major, WebGL-Konvention). */
function mat4Identity(): Float32Array {
  const m = new Float32Array(16);
  m[0] = 1;
  m[5] = 1;
  m[10] = 1;
  m[15] = 1;
  return m;
}

/**
 * Orthografische Projektion [left,right]×[bottom,top] → Clip [-1,1].
 * Spalten-Major.
 */
function mat4Ortho(
  left: number,
  right: number,
  bottom: number,
  top: number,
): Float32Array {
  const m = mat4Identity();
  const w = right - left;
  const h = top - bottom;
  m[0] = 2 / w;
  m[5] = 2 / h;
  m[10] = -1;
  m[12] = -(right + left) / w;
  m[13] = -(top + bottom) / h;
  return m;
}

/** viewBox-Gleichheit (Cache-Invalidierung). */
function viewBoxEqual(a: ViewBox, b: ViewBox): boolean {
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/**
 * Projektionsmatrix für einen viewBox, aspekt-korrigiert wie SVG
 * `preserveAspectRatio="xMidYMid meet"`: der viewBox wird auf das
 * Canvas-Seitenverhältnis GEDEHNT (zentriert), damit die Skalierung in X und Y
 * gleich ist (keine Verzerrung, Perpendikel bleiben senkrecht).
 *
 * Eingabe-Positionen sind bereits im BILDSCHIRM-Raum (toScreen), daher keine
 * zusätzliche Meter-Skalierung. Bildschirm-Y zeigt nach unten → top=vb.y,
 * bottom=vb.y+vb.h (kleineres Y oben → Clip +1).
 */
export function computeOrthoMatrix(
  viewBox: ViewBox,
  canvasW: number,
  canvasH: number,
): Float32Array {
  let { x, y, w, h } = viewBox;
  if (canvasW > 0 && canvasH > 0 && w > 0 && h > 0) {
    const cAspect = canvasW / canvasH;
    const vAspect = w / h;
    if (cAspect > vAspect) {
      // Canvas breiter → viewBox in der Breite dehnen, X zentrieren.
      const nw = h * cAspect;
      x -= (nw - w) / 2;
      w = nw;
    } else {
      // Canvas höher → viewBox in der Höhe dehnen, Y zentrieren.
      const nh = w / cAspect;
      y -= (nh - h) / 2;
      h = nh;
    }
  }
  // top = y (Bildschirm-Y oben, kleiner), bottom = y + h.
  return mat4Ortho(x, x + w, y + h, y);
}

/**
 * WebGL2-GPU-Renderer. Verwaltet Shader-Programme + Projektionsmatrix, zeichnet
 * Füll- und Linien-Batches effizient über Matrix-Uniforms.
 */
export class PlanGpuRenderer {
  private gl: WebGL2RenderingContext;
  private fillProgram: ShaderProgram;
  private lineProgram: ShaderProgram;
  private lastViewBox: ViewBox | null = null;
  private lastCanvas: { w: number; h: number } = { w: 0, h: 0 };
  private projMatrix: Float32Array;

  constructor(
    gl: WebGL2RenderingContext,
    fillProg: ShaderProgram,
    lineProg: ShaderProgram,
  ) {
    this.gl = gl;
    this.fillProgram = fillProg;
    this.lineProgram = lineProg;
    this.projMatrix = mat4Identity();

    // Zeichenblatt-Hintergrund (hell, Default #f0f0f0 = --sheet), keine Tiefe;
    // Alpha-Blending für weiche Kanten/transluzente Räume.
    gl.clearColor(0.941, 0.941, 0.941, 1);
    gl.disable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  }

  /** Löschfarbe (Zeichenblatt) setzen — theme-sicher aus --sheet. */
  setClearColor(r: number, g: number, b: number): void {
    this.gl.clearColor(r, g, b, 1);
  }

  /** Projektionsmatrix nur bei viewBox-/Canvas-Änderung neu berechnen. */
  private updateProjection(viewBox: ViewBox, canvasW: number, canvasH: number): void {
    if (
      !this.lastViewBox ||
      !viewBoxEqual(viewBox, this.lastViewBox) ||
      this.lastCanvas.w !== canvasW ||
      this.lastCanvas.h !== canvasH
    ) {
      this.projMatrix = computeOrthoMatrix(viewBox, canvasW, canvasH);
      this.lastViewBox = { ...viewBox };
      this.lastCanvas = { w: canvasW, h: canvasH };
    }
  }

  /**
   * Zeichnet einen Frame.
   * @param geometry GPU-Geometrie (Fill + Line); null → nur löschen.
   * @param viewBox Aktueller Ausschnitt (Bildschirm-Einheiten).
   * @param viewport Zeichenpuffer-Größe in Geräte-Pixeln.
   * @param paperScaleN Papier-Massstab-Nenner (1:N) für echte mm-Strichbreiten.
   */
  render(
    geometry: GpuGeometry | null,
    viewBox: ViewBox,
    viewport: { width: number; height: number },
    paperScaleN = 100,
  ): void {
    const gl = this.gl;
    gl.viewport(0, 0, viewport.width, viewport.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!geometry) return;

    this.updateProjection(viewBox, viewport.width, viewport.height);

    // Umrechnung Papier-mm → Geräte-px, EXAKT wie der SVG-printStrokeVb-Pfad:
    //   Breite_vb = mm·N/1000·PX_PER_M  (viewBox-Einheiten, skaliert mit Zoom)
    //   Breite_px = Breite_vb · meetSkala   (Geräte-px je viewBox-Einheit)
    // → mm·(N/1000·PX_PER_M·meet). meet nutzt die Geräte-px-Viewport-Größe, enthält
    // damit dpr. So gilt: 0.35 mm bei 1:100 = echte 0.35 mm Papier (== SVG).
    const meet = Math.min(viewport.width / viewBox.w, viewport.height / viewBox.h);
    const mmToDevicePx = (paperScaleN / 1000) * PX_PER_M * meet;

    this.drawFills(geometry);
    this.drawLines(geometry, viewport, mmToDevicePx, meet);
  }

  /** Gefüllte Polygone (Poché). */
  private drawFills(geometry: GpuGeometry): void {
    const gl = this.gl;
    const { positionBuffer, indexBuffer, batches } = geometry.fill;
    if (!positionBuffer || !indexBuffer || !batches.length) return;
    const prog = this.fillProgram;
    if (!prog?.program) return;

    gl.useProgram(prog.program);
    if (prog.uniforms.viewProj) {
      gl.uniformMatrix4fv(prog.uniforms.viewProj, false, this.projMatrix);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    const pos = prog.attribs.position;
    if (pos !== undefined && pos >= 0) {
      gl.enableVertexAttribArray(pos);
      gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 8, 0);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

    for (const b of batches) {
      if (prog.uniforms.color) gl.uniform4fv(prog.uniforms.color, b.color);
      gl.drawElements(gl.TRIANGLES, b.indexCount, gl.UNSIGNED_INT, b.startIndex * 4);
    }
    if (pos !== undefined && pos >= 0) gl.disableVertexAttribArray(pos);
  }

  /**
   * Striche. Zwei Skalierungs-Regime pro Batch (siehe `LineBatch.screenPx`):
   *  • Papier-mm (Standard) — Wand-/Objekt-Umrisse UND Schraffur-Musterlinien
   *    (letztere seit dem Haarlinien-Fix ein gewöhnlicher 0.02-mm-Stift wie
   *    die Wand-Schichtfugen): massstabs- + zoomrichtig über `mmToDevicePx`.
   *  • Bildschirm-px (`screenPx`) — für etwaige künftige rein bildschirm-
   *    gekoppelte Linien: NUR mit `meet` (Zoom) skaliert, unabhängig vom
   *    Papier-Massstab N. Aktuell von keinem Batch mehr genutzt, Infrastruktur
   *    bleibt erhalten.
   */
  private drawLines(
    geometry: GpuGeometry,
    viewport: { width: number; height: number },
    mmToDevicePx: number,
    meet: number,
  ): void {
    const gl = this.gl;
    const { vertexBuffer, indexBuffer, batches } = geometry.line;
    if (!vertexBuffer || !indexBuffer || !batches.length) return;
    const prog = this.lineProgram;
    if (!prog?.program) return;

    gl.useProgram(prog.program);
    if (prog.uniforms.viewProj) {
      gl.uniformMatrix4fv(prog.uniforms.viewProj, false, this.projMatrix);
    }
    if (prog.uniforms.viewportPx) {
      gl.uniform2f(prog.uniforms.viewportPx, viewport.width, viewport.height);
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    const stride = 6 * 4; // [x,y, nx,ny, side, miter]
    const pos = prog.attribs.position;
    const nrm = prog.attribs.normal;
    const side = prog.attribs.side;
    const miter = prog.attribs.miter;
    if (pos !== undefined && pos >= 0) {
      gl.enableVertexAttribArray(pos);
      gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, stride, 0);
    }
    if (nrm !== undefined && nrm >= 0) {
      gl.enableVertexAttribArray(nrm);
      gl.vertexAttribPointer(nrm, 2, gl.FLOAT, false, stride, 2 * 4);
    }
    if (side !== undefined && side >= 0) {
      gl.enableVertexAttribArray(side);
      gl.vertexAttribPointer(side, 1, gl.FLOAT, false, stride, 4 * 4);
    }
    if (miter !== undefined && miter >= 0) {
      gl.enableVertexAttribArray(miter);
      gl.vertexAttribPointer(miter, 1, gl.FLOAT, false, stride, 5 * 4);
    }
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);

    // strokePx-Uniform trägt die Breite (Papier-mm ODER Bildschirm-px, je nach
    // `screenPx`); strokeScale wählt PRO BATCH den passenden Massstabsfaktor.
    // Der Shader multipliziert beides und klemmt bei ~0.6 px (Haarlinie
    // sichtbar, MSAA via antialias:true), damit sehr feine Gewichte beim
    // Rauszoomen nicht verschwinden.
    for (const b of batches) {
      if (prog.uniforms.color) gl.uniform4fv(prog.uniforms.color, b.color);
      if (prog.uniforms.strokePx) gl.uniform1f(prog.uniforms.strokePx, b.strokeMm);
      if (prog.uniforms.strokeScale) {
        gl.uniform1f(prog.uniforms.strokeScale, b.screenPx ? meet : mmToDevicePx);
      }
      gl.drawElements(gl.TRIANGLES, b.indexCount, gl.UNSIGNED_INT, b.startIndex * 4);
    }
    if (pos !== undefined && pos >= 0) gl.disableVertexAttribArray(pos);
    if (nrm !== undefined && nrm >= 0) gl.disableVertexAttribArray(nrm);
    if (side !== undefined && side >= 0) gl.disableVertexAttribArray(side);
    if (miter !== undefined && miter >= 0) gl.disableVertexAttribArray(miter);
  }

  /** Cache invalidieren (z. B. nach Größenänderung). */
  invalidateViewBox(): void {
    this.lastViewBox = null;
  }
}

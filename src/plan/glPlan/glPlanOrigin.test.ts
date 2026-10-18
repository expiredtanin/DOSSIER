// Genauigkeit bei Landeskoordinaten: float32 kann bei ~2,4·10⁸ (2,7 Mio. m ×
// 90 px/m) nur noch ~16 Einheiten auflösen. Die Geometrie wird deshalb relativ
// zu einem lokalen Ursprung abgelegt; der Renderer zieht ihn in doppelter
// Genauigkeit von der Ansicht ab.

import { describe, it, expect } from "vitest";
import type { Primitive } from "../generatePlan";
import { compilePrimitivesToGpu } from "./glPlanCompile";
import { PlanGpuRenderer, orthoBounds } from "./glPlanRender";
import type { GpuGeometry, ShaderProgram } from "./glPlanTypes";

const X0 = 2_665_000.123; // Landeskoordinate (m)
const Y0 = 1_211_000.456;

const seg = (ax: number, ay: number, bx: number, by: number): Primitive => ({
  kind: "line",
  a: { x: ax, y: ay },
  b: { x: bx, y: by },
  cls: "draw2d",
  weightMm: 0.18,
  color: "#000000",
  drawingId: "d",
});

function captureGl() {
  const vertexData: Float32Array[] = [];
  const gl = {
    createBuffer: () => ({}),
    bindBuffer: () => {},
    bufferData: (_t: number, data: Float32Array | Uint32Array) => {
      if (data instanceof Float32Array) vertexData.push(data.slice());
    },
    ARRAY_BUFFER: 1,
    ELEMENT_ARRAY_BUFFER: 2,
    STATIC_DRAW: 3,
  } as unknown as WebGL2RenderingContext;
  return { gl, vertexData };
}

describe("lokaler Ursprung je Geometrie", () => {
  it("legt Vertices bei Landeskoordinaten klein (relativ) ab", () => {
    const { gl, vertexData } = captureGl();
    const geo = compilePrimitivesToGpu(gl, [seg(X0, Y0, X0 + 10, Y0), seg(X0 + 10, Y0, X0 + 10, Y0 + 5)], 90);
    // Ursprung = erster Punkt in Bildschirm-Einheiten.
    expect(geo.origin!.x).toBeCloseTo(X0 * 90, 3);
    expect(geo.origin!.y).toBeCloseTo(-Y0 * 90, 3);
    // Linien-Vertexpuffer: [x,y, nx,ny, side, miter] — x,y nur wenige hundert Einheiten.
    const verts = vertexData[0];
    for (let i = 0; i < verts.length; i += 6) {
      expect(Math.abs(verts[i])).toBeLessThan(2000);
      expect(Math.abs(verts[i + 1])).toBeLessThan(2000);
    }
  });

  it("Renderer: lokale Position + Ursprungs-Projektion == absolute Projektion (doppelte Genauigkeit)", () => {
    const uniforms: Float32Array[] = [];
    const gl = {
      clearColor() {}, disable() {}, enable() {}, blendFunc() {}, viewport() {}, clear() {},
      useProgram() {}, bindBuffer() {}, enableVertexAttribArray() {}, disableVertexAttribArray() {},
      vertexAttribPointer() {}, uniform1f() {}, uniform2f() {}, uniform4fv() {}, drawElements() {},
      uniformMatrix4fv: (_loc: unknown, _t: boolean, m: Float32Array) => uniforms.push(m.slice()),
      DEPTH_TEST: 1, BLEND: 2, SRC_ALPHA: 3, ONE_MINUS_SRC_ALPHA: 4, COLOR_BUFFER_BIT: 5,
      ARRAY_BUFFER: 6, ELEMENT_ARRAY_BUFFER: 7, FLOAT: 8, TRIANGLES: 9, UNSIGNED_INT: 10,
    } as unknown as WebGL2RenderingContext;
    const prog = (): ShaderProgram =>
      ({ program: {}, uniforms: { viewProj: 1, color: 2, strokePx: 3, strokeScale: 4, viewportPx: 5 }, attribs: { position: 0, normal: 1, side: 2, miter: 3 } }) as unknown as ShaderProgram;
    const renderer = new PlanGpuRenderer(gl, prog(), prog());

    const origin = { x: X0 * 90, y: -Y0 * 90 };
    const geometry = {
      fill: { positionBuffer: {}, indexBuffer: {}, batches: [{ startIndex: 0, indexCount: 3, color: [0, 0, 0, 1] }] },
      line: { positionBuffer: null, vertexBuffer: {}, indexBuffer: {}, batches: [] },
      bounds: { minX: 0, minY: 0, maxX: 1, maxY: 1 },
      origin,
    } as unknown as GpuGeometry;

    // Ansicht 30 Einheiten breit, weit draussen bei den Landeskoordinaten.
    const vb = { x: origin.x + 100, y: origin.y + 50, w: 30, h: 20 };
    renderer.render(geometry, vb, { width: 600, height: 400 });
    const m = uniforms[uniforms.length - 1];

    // Ein Punkt in der Mitte der Ansicht, lokal ausgedrückt.
    const local = { x: 100 + 15, y: 50 + 10 };
    const ndcX = m[0] * local.x + m[12];
    const ndcY = m[5] * local.y + m[13];
    expect(ndcX).toBeCloseTo(0, 5);
    expect(ndcY).toBeCloseTo(0, 5);
    // Der linke Rand der Ansicht liegt bei NDC -1.
    expect(m[0] * 100 + m[12]).toBeCloseTo(-1, 5);

    // Gegenprobe: dieselbe Rechnung in doppelter Genauigkeit mit absoluten Koordinaten.
    const b = orthoBounds(vb, 600, 400);
    const absX = origin.x + local.x;
    expect((2 * (absX - b.left)) / (b.right - b.left) - 1).toBeCloseTo(0, 9);
  });
});

/**
 * Tessellierung: wandelt Plan-`Primitive` in GPU-fertige Puffer.
 *  • Polygone → echtes Ear-Clipping (konkav-fähig), Bildschirm-Raum-Dreiecke
 *  • Linien   → Quad mit Normale + Seiten-Flag (bildschirmkonstante Breite)
 *
 * Koordinaten: alles wird in BILDSCHIRM-Raum abgelegt (wie `toScreen`):
 *   sx = mx·PX_PER_M,  sy = -my·PX_PER_M.
 * Damit ist die Projektion eine reine viewBox-Orthografie (siehe glPlanRender).
 */

import type { Primitive } from '../generatePlan';
import type { Vec2 } from '../../model/types';
import type { GpuGeometry, Rgba } from './glPlanTypes';
import { applyDashRuns, buildHatchRuns } from './glPlanHatch';

const PX_PER_M = 90;

/** Modell-Meter → Bildschirm-Raum (identisch zu PlanView.toScreen). */
function toScreen(p: Vec2): Vec2 {
  return { x: p.x * PX_PER_M, y: -p.y * PX_PER_M };
}

/** Signierte Fläche (Shoelace); >0 = CCW (Modell-Y nach oben). */
function signedArea(pts: Vec2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j].x * pts[i].y - pts[i].x * pts[j].y;
  }
  return a / 2;
}

/** Kreuzprodukt (b-a)×(c-a). */
function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Liegt p im (a,b,c)-Dreieck? (CCW-orientiert). */
function pointInTri(a: Vec2, b: Vec2, c: Vec2, p: Vec2): boolean {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * Ear-Clipping-Triangulierung eines einfachen (lochfreien) Polygons. Robust für
 * konvexe UND konkave Ringe. O(n²) — für Plan-Polygone (wenige Ecken) völlig
 * ausreichend. Gibt Dreiecks-Indizes (0-basiert auf `pts`) zurück; [] bei <3
 * Ecken oder Degeneration.
 */
export function triangulate(pts: Vec2[]): number[] {
  const n = pts.length;
  if (n < 3) return [];

  // Ohr-Test unten nutzt cross>0 = konvex, was CCW voraussetzt. Bei CW-Polygonen
  // die Index-Reihenfolge umdrehen (Triangulierung ist raum-affin-invariant, die
  // Indizes gelten danach auch für die Bildschirm-Raum-Vertices).
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  if (signedArea(pts) < 0) idx.reverse(); // <0 = CW → auf CCW drehen

  const tris: number[] = [];
  let guard = 0;
  const maxGuard = n * n + 16;

  while (idx.length > 3 && guard++ < maxGuard) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const iPrev = idx[(i + idx.length - 1) % idx.length];
      const iCur = idx[i];
      const iNext = idx[(i + 1) % idx.length];
      const a = pts[iPrev];
      const b = pts[iCur];
      const c = pts[iNext];

      // Konvexe Ecke? (bei CCW: cross > 0)
      if (cross(a, b, c) <= 0) continue;

      // Kein anderer Vertex im Ohr?
      let contains = false;
      for (let k = 0; k < idx.length; k++) {
        const vi = idx[k];
        if (vi === iPrev || vi === iCur || vi === iNext) continue;
        if (pointInTri(a, b, c, pts[vi])) {
          contains = true;
          break;
        }
      }
      if (contains) continue;

      // Ohr abschneiden.
      tris.push(iPrev, iCur, iNext);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break; // Degeneriert → abbrechen (kein Absturz).
  }
  if (idx.length === 3) tris.push(idx[0], idx[1], idx[2]);
  return tris;
}

/**
 * Farbe → RGBA[0..1]; ungültig/"none"/"transparent" → null.
 * Unterstützt "#rgb", "#rrggbb", "#rrggbbaa" und "rgb()/rgba()".
 */
function parseColor(hex: string | undefined): Rgba | null {
  if (!hex) return null;
  const s = hex.trim().toLowerCase();
  if (s === 'none' || s === 'transparent') return null;

  if (s.startsWith('rgb')) {
    const m = s.match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    const a = m.length >= 4 ? parseFloat(m[3]) : 1;
    return [+m[0] / 255, +m[1] / 255, +m[2] / 255, a > 1 ? a / 255 : a];
  }

  let h = s[0] === '#' ? s.slice(1) : s;
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length !== 6 && h.length !== 8) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return [r / 255, g / 255, b / 255, a];
}


/**
 * Tessellliert Plan-Primitive zu GPU-Geometrie (MVP: gefüllte Polygone +
 * bildschirmkonstante Striche). Text/Bögen bleiben im SVG-Overlay.
 */
export function compilePrimitivesToGpu(
  gl: WebGL2RenderingContext,
  primitives: Primitive[],
): GpuGeometry {
  // Füll-Puffer (Bildschirm-Raum Positionen + Indizes).
  const fillPos: number[] = [];
  const fillIdx: number[] = [];
  const fillBatches: GpuGeometry['fill']['batches'] = [];

  // Linien-Puffer (interleaved [x,y, nx,ny, side]).
  const lineVerts: number[] = [];
  const lineIdx: number[] = [];
  const lineBatches: GpuGeometry['line']['batches'] = [];

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const track = (mx: number, my: number) => {
    if (mx < minX) minX = mx;
    if (my < minY) minY = my;
    if (mx > maxX) maxX = mx;
    if (my > maxY) maxY = my;
  };

  const sameRgba = (a: Rgba, b: Rgba): boolean =>
    a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];

  // Ordnungserhaltendes Batch-Merging: aufeinanderfolgende Indizes gleicher Farbe
  // (+ Breite bei Linien) werden zu EINEM Draw-Call zusammengefasst (Reihenfolge
  // bleibt exakt → korrekte Z-/Alpha-Überlagerung, nur viel weniger State-Wechsel).
  const addFillBatch = (count: number, color: Rgba) => {
    const last = fillBatches[fillBatches.length - 1];
    if (last && sameRgba(last.color, color)) last.indexCount += count;
    else fillBatches.push({ startIndex: fillIdx.length - count, indexCount: count, color });
  };
  const addLineBatch = (count: number, color: Rgba, strokeMm: number) => {
    const last = lineBatches[lineBatches.length - 1];
    if (last && last.strokeMm === strokeMm && sameRgba(last.color, color))
      last.indexCount += count;
    else lineBatches.push({ startIndex: lineIdx.length - count, indexCount: count, color, strokeMm });
  };

  /** Maximaler Miter-Längenfaktor; darüber wird geklemmt (kein Spike an spitzen Ecken). */
  const MITER_LIMIT = 4;

  /**
   * Zeichnet einen zusammenhängenden Linienzug (Bildschirm-Raum) als EINEN
   * gehrten Streifen: an jedem Stützpunkt wird der Versatz entlang des Miter-
   * Bisektors verlängert (1/cos(θ/2)), sodass benachbarte Segmente bündig
   * verschmelzen → gehrte Ecke statt Butt-Cap-Stufe. `closed` schließt den Ring
   * (letzter↔erster Punkt). Vertex-Layout: [x,y, bx,by, side, miter].
   */
  const strokePolyline = (ptsM: Vec2[], closed: boolean, color: Rgba, strokeMm: number) => {
    // Auf Bildschirm-Raum abbilden + aufeinanderfolgende Duplikate entfernen.
    const S: Vec2[] = [];
    for (const p of ptsM) {
      const s = toScreen(p);
      if (S.length && Math.abs(S[S.length - 1].x - s.x) < 1e-6 && Math.abs(S[S.length - 1].y - s.y) < 1e-6)
        continue;
      S.push(s);
      track(p.x, p.y);
    }
    if (closed && S.length > 1) {
      const f = S[0], l = S[S.length - 1];
      if (Math.abs(f.x - l.x) < 1e-6 && Math.abs(f.y - l.y) < 1e-6) S.pop();
    }
    const k = S.length;
    if (k < 2) return;

    const leftNormal = (from: Vec2, to: Vec2): Vec2 | null => {
      const dx = to.x - from.x, dy = to.y - from.y;
      const len = Math.hypot(dx, dy);
      return len < 1e-6 ? null : { x: -dy / len, y: dx / len };
    };

    const base = lineVerts.length / 6;
    for (let i = 0; i < k; i++) {
      const hasIn = closed || i > 0;
      const hasOut = closed || i < k - 1;
      const nIn = hasIn ? leftNormal(S[(i - 1 + k) % k], S[i]) : null;
      const nOut = hasOut ? leftNormal(S[i], S[(i + 1) % k]) : null;

      let bx: number, by: number, miter: number;
      if (nIn && nOut) {
        let sx = nIn.x + nOut.x, sy = nIn.y + nOut.y;
        const slen = Math.hypot(sx, sy);
        if (slen < 1e-3) {
          // ~180°-Umkehr → kein sinnvoller Bisektor, gerade weiterlaufen.
          bx = nOut.x; by = nOut.y; miter = 1;
        } else {
          bx = sx / slen; by = sy / slen;
          const denom = bx * nOut.x + by * nOut.y; // cos(θ/2)
          miter = denom > 1e-3 ? Math.min(1 / denom, MITER_LIMIT) : 1;
        }
      } else {
        const n = nIn ?? nOut!;
        bx = n.x; by = n.y; miter = 1;
      }
      lineVerts.push(S[i].x, S[i].y, bx, by, +1, miter);
      lineVerts.push(S[i].x, S[i].y, bx, by, -1, miter);
    }

    const segs = closed ? k : k - 1;
    for (let i = 0; i < segs; i++) {
      const a = base + 2 * i;
      const b = base + 2 * ((i + 1) % k);
      lineIdx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    addLineBatch(segs * 6, color, strokeMm);
  };

  /** Einzelnes Segment als (ungehrter) 2-Punkt-Zug. */
  const pushLine = (aM: Vec2, bM: Vec2, color: Rgba, strokeMm: number) =>
    strokePolyline([aM, bM], false, color, strokeMm);

  /**
   * Strichelt den Umriss eines Polygons, wobei die Kanten in `noStroke`
   * ÜBERSPRUNGEN werden (Kante `i` = pts[i]→pts[i+1]). Die Füllung bleibt das
   * volle Polygon; nur innere Gehrungs-Stirnkanten am Wandknoten entfallen. Die
   * sichtbaren Kanten werden als zusammenhängende OFFENE Züge gestrichelt → an
   * den weggelassenen Kanten laufen die Enden gerade aus (keine Gehrung über die
   * Naht = keine überschießende Barbe). Leeres `noStroke` ⇒ geschlossener,
   * gehrter Umriss wie bisher.
   */
  const strokePolygonOutline = (
    ptsM: Vec2[],
    color: Rgba,
    strokeMm: number,
    noStroke: number[] | undefined,
  ) => {
    const n = ptsM.length;
    if (!noStroke || noStroke.length === 0 || n < 2) {
      strokePolyline(ptsM, true, color, strokeMm);
      return;
    }
    const skip = new Set(noStroke.map((i) => ((i % n) + n) % n));
    if (skip.size >= n) return; // alle Kanten unterdrückt → nichts zeichnen
    // Sichtbare Kanten zu zusammenhängenden Läufen bündeln; ein Lauf beginnt an
    // einer sichtbaren Kante, deren Vorgänger übersprungen ist.
    const visible = (i: number) => !skip.has(((i % n) + n) % n);
    for (let s = 0; s < n; s++) {
      if (!visible(s) || visible(s - 1 + n)) continue; // kein Lauf-Anfang
      const run: Vec2[] = [ptsM[s]];
      let j = s;
      while (visible(j)) {
        run.push(ptsM[(j + 1) % n]);
        j++;
        if (j - s >= n) break; // voller Umlauf (kann bei skip.size≥1 nicht sein)
      }
      strokePolyline(run, false, color, strokeMm);
    }
  };

  for (const prim of primitives) {
    if (prim.kind === 'polygon') {
      // Füllung (falls vorhanden).
      const fill = parseColor(prim.fill);
      if (fill) {
        const tris = triangulate(prim.pts);
        if (tris.length) {
          const base = fillPos.length / 2;
          for (const pt of prim.pts) {
            const s = toScreen(pt);
            fillPos.push(s.x, s.y);
            track(pt.x, pt.y);
          }
          for (const t of tris) fillIdx.push(base + t);
          addFillBatch(tris.length, fill);
        }
      }
      // Schraffur (nach der Füllung, vor/passend zum Umriss — wie der SVG stapelt):
      // das Muster wird in echte Linien-Geometrie (Modell-Meter) tesselliert und
      // aufs Polygon geclippt (konkav-fähig, even-odd). Musterlinien fließen als
      // zusammenhängende Läufe in `strokePolyline` → GEHRTE, glatte Übergänge
      // (insb. die Dämmungswelle bleibt spitzenfrei). Breite = dieselbe Papier-mm
      // wie der SVG-`<pattern>`; `hatch.dash` wird geometrisch (Strich/Lücke)
      // aufgelöst, da die GL-Linien-Pipeline kein Dash kennt.
      if (prim.hatch && prim.hatch.pattern !== 'none' && prim.hatch.pattern !== 'solid') {
        const hatchColor = parseColor(prim.hatch.color) ?? [0.1, 0.1, 0.1, 1];
        const hatchMm = prim.hatch.lineWeight > 0 ? prim.hatch.lineWeight : 0.13;
        const runs = applyDashRuns(buildHatchRuns(prim.pts, prim.hatch), prim.hatch.dash);
        for (const run of runs) strokePolyline(run, false, hatchColor, hatchMm);
      }
      // Umriss (crispe Kante) — geschlossener Ring, GEHRT (kein Stufen-Cap an
      // Ecken). Breite = ECHTE Papier-mm; der Renderer rechnet massstabs-/
      // zoomrichtig in px (wie SVG-printStrokeVb → GL == SVG).
      const stroke = parseColor(prim.stroke);
      if (stroke && prim.strokeWidthMm > 0 && prim.pts.length >= 2) {
        strokePolygonOutline(prim.pts, stroke, prim.strokeWidthMm, prim.noStrokeEdges);
      }
    } else if (prim.kind === 'line') {
      const color = parseColor(prim.color) ?? [0.1, 0.1, 0.1, 1];
      pushLine(prim.a, prim.b, color, prim.weightMm || 0.18);
    } else if (prim.kind === 'arc') {
      // Bogen → ein gehrter Polylinienzug (glatt, keine Segment-Stufen).
      const color = parseColor((prim as { color?: string }).color) ?? [0.1, 0.1, 0.1, 1];
      const strokeMm = prim.weightMm || 0.18;
      const c = prim.center;
      const a0 = Math.atan2(prim.from.y - c.y, prim.from.x - c.x);
      const a1 = Math.atan2(prim.to.y - c.y, prim.to.x - c.x);
      // Kürzeste Drehrichtung (Delta nach (-π, π]).
      let d = a1 - a0;
      while (d <= -Math.PI) d += 2 * Math.PI;
      while (d > Math.PI) d -= 2 * Math.PI;
      const segs = Math.max(4, Math.ceil((Math.abs(d) / (Math.PI / 2)) * 16));
      const arcPts: Vec2[] = [prim.from];
      for (let i = 1; i <= segs; i++) {
        const t = a0 + (d * i) / segs;
        arcPts.push({ x: c.x + prim.r * Math.cos(t), y: c.y + prim.r * Math.sin(t) });
      }
      strokePolyline(arcPts, false, color, strokeMm);
    }
    // Text: bleibt im SVG-Overlay (scharfe Schrift, DOM-Hit-Test).
  }

  // Puffer hochladen.
  const uploadArray = (data: number[]): WebGLBuffer | null => {
    if (!data.length) return null;
    const buf = gl.createBuffer();
    if (!buf) return null;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
    return buf;
  };
  const uploadIndex = (data: number[]): WebGLBuffer | null => {
    if (!data.length) return null;
    const buf = gl.createBuffer();
    if (!buf) return null;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(data), gl.STATIC_DRAW);
    return buf;
  };

  return {
    fill: {
      positionBuffer: uploadArray(fillPos),
      indexBuffer: uploadIndex(fillIdx),
      batches: fillBatches,
    },
    line: {
      vertexBuffer: uploadArray(lineVerts),
      indexBuffer: uploadIndex(lineIdx),
      batches: lineBatches,
    },
    bounds: {
      minX: isFinite(minX) ? minX : 0,
      minY: isFinite(minY) ? minY : 0,
      maxX: isFinite(maxX) ? maxX : 1,
      maxY: isFinite(maxY) ? maxY : 1,
    },
  };
}

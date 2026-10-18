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
import { applyDashRuns, buildHatchRuns, zigzagPoints, motifPoints, DASH_MM_TO_M } from './glPlanHatch';

const PX_PER_M = 90;

/**
 * Wachsender Typed-Array-Puffer statt `number[]` für die Vertex-/Index-Daten.
 * Normale JS-Arrays sind in V8/JSC praktisch auf ~134 Mio. Elemente begrenzt
 * (`FixedArray::kMaxLength`) — ein ganzer Kataster-Import (3,7 Mio. Linien-
 * Segmente, reproduziert mit der 439-MB-Luzerner-DXF) überschreitet das beim
 * Linien-Vertexpuffer (`RangeError: Invalid array length`). Typed Arrays haben
 * diese Grenze nicht und brauchen nur 4 statt 8 Byte je Wert. Die hochgeladenen
 * Daten sind identisch: der Upload hat schon bisher nach Float32/Uint32 gewandelt.
 */
class GrowBuffer<T extends Float32Array | Uint32Array> {
  private buf: T;
  length = 0;
  constructor(private readonly make: (n: number) => T) {
    this.buf = make(1024);
  }
  private ensure(extra: number): void {
    const need = this.length + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = this.make(cap);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
  push1(a: number): void {
    this.ensure(1);
    this.buf[this.length++] = a;
  }
  push2(a: number, b: number): void {
    this.ensure(2);
    const o = this.length;
    this.buf[o] = a;
    this.buf[o + 1] = b;
    this.length = o + 2;
  }
  push3(a: number, b: number, c: number): void {
    this.ensure(3);
    const o = this.length;
    this.buf[o] = a;
    this.buf[o + 1] = b;
    this.buf[o + 2] = c;
    this.length = o + 3;
  }
  push6(a: number, b: number, c: number, d: number, e: number, f: number): void {
    this.ensure(6);
    const o = this.length;
    this.buf[o] = a;
    this.buf[o + 1] = b;
    this.buf[o + 2] = c;
    this.buf[o + 3] = d;
    this.buf[o + 4] = e;
    this.buf[o + 5] = f;
    this.length = o + 6;
  }
  /** Gefüllter Bereich (View, keine Kopie). */
  view(): T {
    return this.buf.subarray(0, this.length) as T;
  }
}

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
 * konvexe UND konkave Ringe. Gibt Dreiecks-Indizes (0-basiert auf `pts`)
 * zurück; [] bei <3 Ecken oder Degeneration.
 *
 * PERFORMANCE (Nutzer-Report 2026-10: App hängt nach Import einer grossen
 * Kataster-DXF, 69k Konturen): die naive Fassung war O(n) Ohren × O(n)
 * Kandidatensuche × O(n) Enthalten-Test (plus O(n) `Array.splice` pro Ohr)
 * — für ein paar Dutzend Handzeichnungs-Ecken unmerklich, aber bei einem
 * einzelnen gefüllten Polygon mit tausenden Stützpunkten (z. B. eine
 * detaillierte Parzellen-/Flächen-HATCH-Kontur aus einer amtlichen
 * Vermessung) effektiv O(n³) — EIN solches Polygon konnte die App für
 * Minuten einfrieren. Fix, ohne das Ergebnis zu ändern: nur REFLEXE (konkave)
 * Ecken können in einem Ohr liegen (Standard-Resultat der Ear-Clipping-
 * Literatur) — der Enthalten-Test scannt daher nur die (meist kleine)
 * Reflex-Menge statt aller Ecken, und das Abschneiden eines Ohrs läuft über
 * eine verkettete Liste (O(1)) statt `splice` (O(n)). Für überwiegend konvexe
 * Polygone (die Mehrheit realer Gebäude-/Parzellen-Umrisse) sinkt die
 * Gesamtkosten dadurch von O(n³) auf nahe O(n · r) mit r = Anzahl Reflex-
 * Ecken (oft einstellig, unabhängig von n); echter Worst-Case (ALLE Ecken
 * reflex, z. B. ein Zickzack) bleibt bei O(n²) — nie schlechter als vorher.
 */
export function triangulate(pts: Vec2[]): number[] {
  const n = pts.length;
  if (n < 3) return [];

  // Ohr-Test unten nutzt cross>0 = konvex, was CCW voraussetzt. Bei CW-Polygonen
  // die Reihenfolge umdrehen (Triangulierung ist raum-affin-invariant, die
  // Indizes gelten danach auch für die Bildschirm-Raum-Vertices).
  const order: number[] = [];
  for (let i = 0; i < n; i++) order.push(i);
  if (signedArea(pts) < 0) order.reverse(); // <0 = CW → auf CCW drehen

  // Doppelt verkettete Liste über die (ggf. gedrehte) Reihenfolge — macht das
  // Entfernen eines abgeschnittenen Ohrs O(1) (Nachbarn neu verknüpfen statt
  // Array-splice).
  const next = new Int32Array(n);
  const prev = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    next[order[i]] = order[(i + 1) % n];
    prev[order[i]] = order[(i - 1 + n) % n];
  }

  const isReflex = (i: number): boolean => cross(pts[prev[i]], pts[i], pts[next[i]]) <= 0;
  const reflex = new Set<number>();
  for (const i of order) if (isReflex(i)) reflex.add(i);

  const tris: number[] = [];
  let remaining = n;
  let i = order[0];
  let noEarStreak = 0;
  let guard = 0;
  const maxGuard = n * n + 16;

  while (remaining > 3 && guard++ < maxGuard) {
    const a = prev[i];
    const b = i;
    const c = next[i];
    // Konvexe Ecke (nicht reflex) UND kein anderer (notwendig reflexer)
    // Vertex im Ohr-Dreieck → gültiges Ohr.
    let isEar = !reflex.has(b);
    if (isEar) {
      for (const vi of reflex) {
        if (vi === a || vi === b || vi === c) continue;
        if (pointInTri(pts[a], pts[b], pts[c], pts[vi])) {
          isEar = false;
          break;
        }
      }
    }

    if (isEar) {
      tris.push(a, b, c);
      next[a] = c;
      prev[c] = a;
      reflex.delete(b);
      remaining--;
      // Nachbarn können durch die neue Kante ihre Konvexität wechseln (in
      // beide Richtungen) — Reflex-Menge entsprechend nachführen.
      if (isReflex(a)) reflex.add(a); else reflex.delete(a);
      if (isReflex(c)) reflex.add(c); else reflex.delete(c);
      i = a; // nach einem Schnitt zuerst den Vorgänger erneut prüfen (üblich)
      noEarStreak = 0;
    } else {
      i = c;
      // Kein Ohr nach einer vollen Runde über den Restring gefunden →
      // degeneriert (z. B. selbstüberschneidend). Abbrechen statt endlos
      // weiterzusuchen (kein Crash, wie zuvor).
      if (++noEarStreak > remaining) break;
    }
  }
  if (remaining === 3) tris.push(prev[i], i, next[i]);
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
 * Fester Grauton gedimmter (greyed) Primitive — ECHTE Umfärbung statt
 * Deckkraft (dünne Haarlinien auf dem hellen Zeichenblatt wären bei reiner
 * Transparenz kaum erkennbar gedimmt). Gleicher Ton wie GREYED_COLOR in
 * PlanView.tsx / GREY_RGB in toRenderScene.ts (#8c8c8c ≈ 0.549).
 */
export const GREY_RGB = 0.549;

/**
 * Färbt auf den festen Grauton um, wenn das Primitiv im Darstellungsmodus
 * „grau" ist, und multipliziert die Objekt-Transparenz (`Drawing2D.opacity`)
 * in den Alphakanal. Beides ist unabhängig: gedimmt wird UMGEFÄRBT (damit
 * dünne Linien erkennbar bleiben), transparent wird über Alpha.
 */
function dim(color: Rgba, greyed: boolean | undefined, opacity?: number): Rgba {
  const c: Rgba = greyed ? [GREY_RGB, GREY_RGB, GREY_RGB, color[3]] : color;
  if (opacity === undefined || opacity >= 1) return c;
  return [c[0], c[1], c[2], c[3] * Math.max(0, opacity)];
}

/**
 * Wie `dim`, aber für FLÄCHEN-Füllung: gedimmte Flächen bleiben WEISS statt
 * grau eingefärbt — nur der Umriss (weiterhin `dim`) macht das Element als
 * gedimmt erkennbar (Nutzer-Wunsch: "im Hintergrund nicht als graue Fläche
 * gefüllt, sondern weiss mit nur den Linien sichtbar").
 */
function dimFill(color: Rgba, greyed: boolean | undefined, opacity?: number): Rgba {
  const c: Rgba = greyed ? [1, 1, 1, color[3]] : color;
  if (opacity === undefined || opacity >= 1) return c;
  return [c[0], c[1], c[2], c[3] * Math.max(0, opacity)];
}

/**
 * Tessellliert Plan-Primitive zu GPU-Geometrie (MVP: gefüllte Polygone +
 * bildschirmkonstante Striche). Text/Bögen bleiben im SVG-Overlay.
 */
export function compilePrimitivesToGpu(
  gl: WebGL2RenderingContext,
  primitives: Primitive[],
  // Bildschirm-Massstab (Geräte-px je Modell-Meter) beim aktuellen Zoom. Steuert
  // NUR die adaptive Bogen-Tessellierung (siehe 'arc'-Zweig): je stärker
  // hineingezoomt, desto mehr Segmente, damit der Bogen rund statt facettiert
  // erscheint. 0 → zoom-unabhängiger Rückfall (fixe 16 Segmente je 90°), z. B.
  // wenn der Aufrufer den Massstab (noch) nicht kennt.
  pxPerMeter = 0,
): GpuGeometry {
  // Füll-Puffer (Bildschirm-Raum Positionen + Indizes).
  const fillPos = new GrowBuffer((n) => new Float32Array(n));
  const fillIdx = new GrowBuffer((n) => new Uint32Array(n));
  const fillBatches: GpuGeometry['fill']['batches'] = [];

  // Linien-Puffer (interleaved [x,y, nx,ny, side]).
  const lineVerts = new GrowBuffer((n) => new Float32Array(n));
  const lineIdx = new GrowBuffer((n) => new Uint32Array(n));
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
  const addLineBatch = (count: number, color: Rgba, strokeMm: number, screenPx: boolean) => {
    const last = lineBatches[lineBatches.length - 1];
    if (last && last.strokeMm === strokeMm && !!last.screenPx === screenPx && sameRgba(last.color, color))
      last.indexCount += count;
    else
      lineBatches.push({
        startIndex: lineIdx.length - count,
        indexCount: count,
        color,
        strokeMm,
        screenPx,
      });
  };

  /**
   * Zeichnet einen zusammenhängenden Linienzug (Bildschirm-Raum) mit ECHTEN
   * RUNDEN Kappen/Ecken (wie SVG `stroke-linecap/linejoin: round` und der
   * Vektor-PDF-Pfad) statt eckigem Butt-Cap/Gehrung:
   *  • jedes Segment ist ein eigenständiges Quad mit BUTT-Enden (eigene
   *    Segment-Normale, keine Miter-Verlängerung);
   *  • an jedem inneren Stützpunkt füllt ein Dreiecksfächer (Radius = halbe
   *    Strichbreite) die Außenseite der Ecke rund auf (Innenseite überlappt
   *    unsichtbar, wie bei jedem Disjoint-Segment-Liniendicken-Ansatz);
   *  • an offenen Enden (nicht `closed`) sitzt ein Halbkreis-Fächer als runde
   *    Kappe.
   * Die tatsächliche Pixel-Breite bleibt bildschirmkonstant: alle Fächer-/Quad-
   * Vertices tragen nur eine EINHEITS-Richtung (`normal`) + `side`-Skalar; der
   * Vertex-Shader multipliziert im Clip-Raum mit der aktuellen Strichbreite
   * (`strokePx*strokeScale`) — die Tessellierung selbst kennt keine Pixelmasse.
   * `closed` schließt den Ring (letzter↔erster Punkt). Vertex-Layout unverändert:
   * [x,y, bx,by, side, miter] (miter bleibt hier immer 1, s. Shader-Vertrag).
   */
  const strokePolyline = (
    ptsM: Vec2[],
    closed: boolean,
    color: Rgba,
    strokeMm: number,
    screenPx = false,
  ) => {
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

    const dir = (from: Vec2, to: Vec2): Vec2 | null => {
      const dx = to.x - from.x, dy = to.y - from.y;
      const len = Math.hypot(dx, dy);
      return len < 1e-9 ? null : { x: dx / len, y: dy / len };
    };
    const leftNormal = (d: Vec2): Vec2 => ({ x: -d.y, y: d.x });

    const startIdxLen = lineIdx.length;
    const vBase = lineVerts.length / 6;
    let vcount = 0;
    const pushVert = (p: Vec2, nx: number, ny: number, side: number): number => {
      lineVerts.push6(p.x, p.y, nx, ny, side, 1);
      vcount++;
      return vBase + vcount - 1;
    };

    const segs = closed ? k : k - 1;
    const segDir: (Vec2 | null)[] = [];
    for (let i = 0; i < segs; i++) segDir.push(dir(S[i], S[(i + 1) % k]));

    // Segment-Quads: butt-endig, jedes mit seiner EIGENEN Normale (kein
    // gemeinsamer Bisektor mehr — Ecken werden separat durch Fächer geschlossen).
    for (let i = 0; i < segs; i++) {
      const d = segDir[i];
      if (!d) continue; // entartetes (Länge-0) Segment
      const n = leftNormal(d);
      const a = S[i], b = S[(i + 1) % k];
      const i0 = pushVert(a, n.x, n.y, +1);
      const i1 = pushVert(a, n.x, n.y, -1);
      const i2 = pushVert(b, n.x, n.y, +1);
      const i3 = pushVert(b, n.x, n.y, -1);
      lineIdx.push6(i0, i1, i2, i1, i3, i2);
    }

    // Kreisbogen-Fächer (Zentrum = Vertex, Radius = halbe Strichbreite, per
    // Shader skaliert): `side=0` am Zentrum (kein Versatz), `side=1` an den
    // Randpunkten (voller Versatz in Richtung (cosθ,sinθ)).
    const addFanArc = (p: Vec2, aFrom: number, aTo: number) => {
      const delta = aTo - aFrom;
      const steps = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 10)));
      const iCenter = pushVert(p, 1, 0, 0);
      let prev = pushVert(p, Math.cos(aFrom), Math.sin(aFrom), 1);
      for (let s = 1; s <= steps; s++) {
        const t = aFrom + (delta * s) / steps;
        const cur = pushVert(p, Math.cos(t), Math.sin(t), 1);
        lineIdx.push3(iCenter, prev, cur);
        prev = cur;
      }
    };

    // Runder Join an einem inneren Stützpunkt: Fächer NUR auf der konvexen
    // (äußeren) Seite der Ecke — die konkave Seite überlappt bereits durch die
    // beiden Segment-Quads (kein Loch, keine zusätzliche Geometrie nötig).
    const addRoundJoin = (p: Vec2, d1: Vec2, d2: Vec2) => {
      const turn = d1.x * d2.y - d1.y * d2.x;
      const dot = d1.x * d2.x + d1.y * d2.y;
      if (Math.abs(turn) < 1e-6 && dot > 0) return; // praktisch gerade
      const n1 = leftNormal(d1), n2 = leftNormal(d2);
      if (dot < -0.9999) {
        // ~180°-Umkehr: Außenseite mehrdeutig → voller Kreis (robust, entspricht
        // zwei gestapelten Rund-Kappen an derselben Stelle).
        const a0 = Math.atan2(n1.y, n1.x);
        addFanArc(p, a0, a0 + 2 * Math.PI);
        return;
      }
      const outer = turn > 0 ? -1 : 1;
      const u1 = { x: outer * n1.x, y: outer * n1.y };
      const u2 = { x: outer * n2.x, y: outer * n2.y };
      const a1 = Math.atan2(u1.y, u1.x);
      let a2 = Math.atan2(u2.y, u2.x);
      let delta = a2 - a1;
      while (delta <= -Math.PI) delta += 2 * Math.PI;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      if (Math.abs(delta) < 1e-4) return;
      addFanArc(p, a1, a1 + delta);
    };

    // Runde Kappe an einem offenen Ende: Halbkreis, der auf der Außenseite
    // (weg von der Linie) bulgt.
    const addRoundCap = (p: Vec2, n: Vec2, sweepSign: 1 | -1) => {
      const a0 = Math.atan2(n.y, n.x);
      addFanArc(p, a0, a0 + sweepSign * Math.PI);
    };

    for (let v = 0; v < k; v++) {
      const hasIn = closed || v > 0;
      const hasOut = closed || v < k - 1;
      const dIn = hasIn ? segDir[(v - 1 + segs) % segs] : null;
      const dOut = hasOut ? segDir[v % segs] : null;
      if (dIn && dOut) {
        addRoundJoin(S[v], dIn, dOut);
      } else if (dOut && !dIn) {
        // Start-Kappe: bulgt rückwärts (weg vom ersten Segment).
        addRoundCap(S[v], leftNormal(dOut), 1);
      } else if (dIn && !dOut) {
        // End-Kappe: bulgt vorwärts (weg vom letzten Segment).
        addRoundCap(S[v], leftNormal(dIn), -1);
      }
    }

    addLineBatch(lineIdx.length - startIdxLen, color, strokeMm, screenPx);
  };

  /** Einzelnes Segment als (ungehrter, rund gekapptes) 2-Punkt-Zug. */
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

  // Zusammenhängende, gleich gestylte 'line'-Primitive (typischerweise die
  // EINZELNEN Segmente einer importierten Polylinie/Kontur — s. `seg()` in
  // `generatePlan/drawing2d.ts`, das pro Punktpaar ein eigenes 'line'-Primitiv
  // erzeugt) werden hier VOR dem Stricheln zu EINEM zusammenhängenden Zug
  // zusammengefasst. Grund: `strokePolyline` setzt an jedem OFFENEN Ende einen
  // vollen Rundkappen-Fächer (`addRoundCap`, s. u.); bei N unabhängigen
  // 2-Punkt-Segmenten macht das aus einer durchgehenden Kontur 2N teure
  // Kappen statt der 2 echten Enden + (N-1) günstigerer Rund-ÜBERGÄNGE
  // (`addRoundJoin`, nur auf der Aussenseite). Bei einem Kataster-Import mit
  // Millionen solcher Segmente (reproduziert mit der echten 439-MB-Luzerner-
  // Datei: 69'107 Konturen, Ø ~53 Punkte → 3,68 Mio. 'line'-Primitive) hat das
  // den Linien-Vertexpuffer bis zur `RangeError: Invalid array length`
  // aufgebläht. NUR eine Rendering-Optimierung — `primitives[i]` bleibt für
  // Auswahl/Hit-Testing (PlanView.tsx indiziert direkt in `plan.primitives`)
  // unverändert einzeln adressierbar; am Primitiv-Modell ändert sich nichts,
  // nur daran, wie die GPU-Geometrie daraus kompiliert wird.
  const mergedLineRun = new Set<number>();
  {
    let i = 0;
    while (i < primitives.length) {
      const p0 = primitives[i];
      if (p0.kind !== 'line' || p0.zigzag || p0.motif) {
        i++;
        continue;
      }
      const pts: Vec2[] = [p0.a, p0.b];
      let j = i + 1;
      while (j < primitives.length) {
        const pj = primitives[j];
        if (
          pj.kind !== 'line' ||
          pj.zigzag ||
          pj.motif ||
          // `drawingId` MUSS übereinstimmen: ohne das verketten sich sonst
          // ZWEI VERSCHIEDENE (gleich gestylte) Drawing2D-Elemente, die
          // zufällig einen Eckpunkt teilen (bei Kataster-Daten der Normalfall
          // — Nachbarparzellen teilen Grenzpunkte) zu EINEM künstlichen,
          // potenziell riesigen Polylinienzug — genau das hat beim echten
          // Luzerner Import einen einzelnen `strokePolyline`-Aufruf auf
          // Milliarden Vertices aufgebläht (`RangeError: Invalid array
          // length`, reproduziert).
          pj.drawingId !== p0.drawingId ||
          pj.color !== p0.color ||
          pj.weightMm !== p0.weightMm ||
          pj.greyed !== p0.greyed ||
          pj.opacity !== p0.opacity ||
          pj.dash !== p0.dash ||
          pj.a.x !== pts[pts.length - 1].x ||
          pj.a.y !== pts[pts.length - 1].y
        ) {
          break;
        }
        pts.push(pj.b);
        j++;
      }
      if (j - i > 1) {
        const color = dim(parseColor(p0.color) ?? [0.1, 0.1, 0.1, 1], p0.greyed, p0.opacity);
        strokePolyline(pts, false, color, p0.weightMm || 0.18);
        for (let k = i; k < j; k++) mergedLineRun.add(k);
      }
      i = j;
    }
  }

  for (let primIdx = 0; primIdx < primitives.length; primIdx++) {
    const prim = primitives[primIdx];
    if (mergedLineRun.has(primIdx)) continue;
    if (prim.kind === 'polygon') {
      // Füllung (falls vorhanden).
      const fill = parseColor(prim.fill);
      if (fill) {
        const tris = triangulate(prim.pts);
        if (tris.length) {
          const base = fillPos.length / 2;
          for (const pt of prim.pts) {
            const s = toScreen(pt);
            fillPos.push2(s.x, s.y);
            track(pt.x, pt.y);
          }
          for (const t of tris) fillIdx.push1(base + t);
          addFillBatch(tris.length, dimFill(fill, prim.greyed, prim.opacity));
        }
      }
      // Schraffur (nach der Füllung, vor/passend zum Umriss — wie der SVG stapelt):
      // das Muster wird in echte Linien-Geometrie (Modell-Meter) tesselliert und
      // aufs Polygon geclippt (konkav-fähig, even-odd). Musterlinien fließen als
      // zusammenhängende Läufe in `strokePolyline` → glatte, RUND gekappte/
      // -verbundene Übergänge (insb. die Dämmungswelle bleibt spitzenfrei).
      // BREITE — die Schraffur ist jetzt ein GEWÖHNLICHER Papier-mm-Stift, mit
      // derselben LineStyle-Stärke (0.02 mm) wie die Wand-Schichtfugen, und
      // läuft durch dieselbe STANDARD-Pipeline wie jede andere Linie
      // (screenPx=false). `paperScaleForGl` liefert im Bildschirm-/Haarlinien-
      // Modus den reziproken `meet`-Massstab, wodurch `mmToDevicePx` dort
      // zoomunabhängig konstant bleibt — die Schraffur erscheint als konstante
      // Haarlinie wie jede Wandlinie, und im Druckmodus als echte 0.02 mm,
      // deckungsgleich mit den Schichtfugen in beiden Modi.
      // `hatch.dash` wird geometrisch (Strich/Lücke) aufgelöst, da die GL-
      // Linien-Pipeline kein Dash kennt.
      // Bild-/Verlauf-Schraffur (kind==="image"/"gradient"): WebGL2-Ebene kennt
      // weder Muster-Textur noch echten Farbverlauf → FALLBACK auf die neutrale
      // Poché-Füllung (oben), keine Musterlinien. Der Random-Untermodus läuft
      // transparent über `buildHatchRuns` (Streu-Striche).
      if (
        prim.hatch &&
        prim.hatch.kind !== 'image' &&
        prim.hatch.kind !== 'gradient' &&
        prim.hatch.pattern !== 'none' &&
        prim.hatch.pattern !== 'solid'
      ) {
        const hatchColor = dim(parseColor(prim.hatch.color) ?? [0.1, 0.1, 0.1, 1], prim.greyed, prim.opacity);
        const hatchMm = prim.hatch.lineWeight > 0 ? prim.hatch.lineWeight : 0.13;
        const runs = applyDashRuns(buildHatchRuns(prim.pts, prim.hatch), prim.hatch.dash);
        for (const run of runs) strokePolyline(run, false, hatchColor, hatchMm, false);
      }
      // Umriss (crispe Kante) — geschlossener Ring, GEHRT (kein Stufen-Cap an
      // Ecken). Breite = ECHTE Papier-mm; der Renderer rechnet massstabs-/
      // zoomrichtig in px (wie SVG-printStrokeVb → GL == SVG).
      const stroke = parseColor(prim.stroke);
      if (stroke && prim.strokeWidthMm > 0 && prim.pts.length >= 2) {
        strokePolygonOutline(prim.pts, dim(stroke, prim.greyed, prim.opacity), prim.strokeWidthMm, prim.noStrokeEdges);
      }
    } else if (prim.kind === 'line') {
      const color = dim(parseColor(prim.color) ?? [0.1, 0.1, 0.1, 1], prim.greyed, prim.opacity);
      if (prim.zigzag) {
        // Zickzack-Linie → gehrter Polylinienzug (amplitude/wavelength Papier-mm
        // → Modell-Meter über dieselbe Kopplung wie Strichmuster).
        const amp = prim.zigzag.amplitude * DASH_MM_TO_M;
        const wav = prim.zigzag.wavelength * DASH_MM_TO_M;
        const zpts = zigzagPoints(prim.a, prim.b, amp, wav);
        strokePolyline(zpts, false, color, prim.weightMm || 0.18);
      } else if (prim.motif) {
        // Custom-Motiv → gehrter Polylinienzug (Papier-mm → Modell-Meter, wie Zickzack).
        const mpts = motifPoints(prim.a, prim.b, prim.motif, DASH_MM_TO_M);
        strokePolyline(mpts, false, color, prim.weightMm || 0.18);
      } else {
        pushLine(prim.a, prim.b, color, prim.weightMm || 0.18);
      }
    } else if (prim.kind === 'arc') {
      // Bogen → ein gehrter Polylinienzug (glatt, keine Segment-Stufen).
      const color = dim(
        parseColor((prim as { color?: string }).color) ?? [0.1, 0.1, 0.1, 1],
        prim.greyed,
        prim.opacity,
      );
      const strokeMm = prim.weightMm || 0.18;
      const c = prim.center;
      const a0 = Math.atan2(prim.from.y - c.y, prim.from.x - c.x);
      const a1 = Math.atan2(prim.to.y - c.y, prim.to.x - c.x);
      // Kürzeste Drehrichtung (Delta nach (-π, π]).
      let d = a1 - a0;
      while (d <= -Math.PI) d += 2 * Math.PI;
      while (d > Math.PI) d -= 2 * Math.PI;
      // Bildschirm-adaptive Tessellierung (LOD): der Bogen-Radius in Geräte-px
      // ist rPx = r · pxPerMeter. Der Segment-Winkel θ wird so gewählt, dass die
      // Sagitta (Sehnen-Ausbauchung) rPx·(1−cos(θ/2)) unter ~0.5 px bleibt →
      // θ = 2·acos(1 − 0.5/rPx). Weit weg (kleiner rPx) = wenige Segmente (billig,
      // Facetten unsichtbar); hineingezoomt = viele Segmente = runder Bogen — wie
      // im CAD. Geklammert auf [8, 2048]. pxPerMeter=0 → fixer Rückfall (16/90°).
      // Der Aufrufer (PlanView) re-tesselliert nur bei LOD-Bucket-Wechseln, nicht
      // je Frame; Pan/Zoom bleibt reines Matrix-Update.
      let segs: number;
      if (pxPerMeter > 0) {
        const rPx = prim.r * pxPerMeter;
        // Für sehr kleine rPx ist 0.5/rPx ≥ 1 (kein realer acos) → Minimum greift.
        const theta = rPx > 0.5 ? 2 * Math.acos(1 - 0.5 / rPx) : Math.PI;
        segs = Math.min(2048, Math.max(8, Math.ceil(Math.abs(d) / theta)));
      } else {
        segs = Math.max(4, Math.ceil((Math.abs(d) / (Math.PI / 2)) * 16));
      }
      const arcPts: Vec2[] = [prim.from];
      for (let i = 1; i <= segs; i++) {
        const t = a0 + (d * i) / segs;
        arcPts.push({ x: c.x + prim.r * Math.cos(t), y: c.y + prim.r * Math.sin(t) });
      }
      strokePolyline(arcPts, false, color, strokeMm);
    } else if (prim.kind === 'drawingCircle' || prim.kind === 'drawingArc') {
      // 2D-Zeichnungs-Kreis/-Bogen (Kreis-/Bogen-Werkzeug ODER DXF-Import). Der
      // SVG-Pfad zeichnet sie als glattes <circle>/<path>; die WebGL-Ebene kennt
      // kein Kreis-Primitiv → hier bildschirm-adaptiv tessellieren (wie 'arc').
      // Kreis = voller Umlauf (geschlossen, optional gefüllt), Bogen = a0..a1 (CCW,
      // offen). OHNE diesen Zweig blieben gezeichnete Kreise/Bögen im GL unsichtbar.
      const stroke = dim(parseColor(prim.stroke) ?? [0.1, 0.1, 0.1, 1], prim.greyed, prim.opacity);
      const strokeMm = prim.weightMm || 0.18;
      const c = prim.center;
      const TAU = Math.PI * 2;
      const a0 = prim.kind === 'drawingArc' ? prim.a0 : 0;
      const sweep =
        prim.kind === 'drawingArc'
          ? ((prim.a1 - prim.a0) % TAU + TAU) % TAU || TAU
          : TAU;
      // Segmentzahl wie im 'arc'-Zweig: Sagitta < ~0.5 px (LOD über pxPerMeter).
      let segs: number;
      if (pxPerMeter > 0) {
        const rPx = prim.r * pxPerMeter;
        const theta = rPx > 0.5 ? 2 * Math.acos(1 - 0.5 / rPx) : Math.PI;
        segs = Math.min(2048, Math.max(8, Math.ceil(sweep / theta)));
      } else {
        segs = Math.max(8, Math.ceil((sweep / (Math.PI / 2)) * 16));
      }
      const pts: Vec2[] = [];
      for (let i = 0; i <= segs; i++) {
        const t = a0 + (sweep * i) / segs;
        pts.push({ x: c.x + prim.r * Math.cos(t), y: c.y + prim.r * Math.sin(t) });
      }
      // Vollton-Füllung nur beim geschlossenen Kreis (Bogen ist offen).
      if (prim.kind === 'drawingCircle') {
        const fill = parseColor(prim.fill);
        if (fill) {
          const ring = pts.slice(0, segs); // ohne den doppelten Schlusspunkt
          const tris = triangulate(ring);
          if (tris.length) {
            const base = fillPos.length / 2;
            for (const pt of ring) {
              const s = toScreen(pt);
              fillPos.push2(s.x, s.y);
              track(pt.x, pt.y);
            }
            for (const t of tris) fillIdx.push1(base + t);
            addFillBatch(tris.length, dimFill(fill, prim.greyed, prim.opacity));
          }
        }
      }
      strokePolyline(pts, prim.kind === 'drawingCircle', stroke, strokeMm);
    }
    // Text: bleibt im SVG-Overlay (scharfe Schrift, DOM-Hit-Test).
  }

  // Puffer hochladen.
  const uploadArray = (data: GrowBuffer<Float32Array>): WebGLBuffer | null => {
    if (!data.length) return null;
    const buf = gl.createBuffer();
    if (!buf) return null;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data.view(), gl.STATIC_DRAW);
    return buf;
  };
  const uploadIndex = (data: GrowBuffer<Uint32Array>): WebGLBuffer | null => {
    if (!data.length) return null;
    const buf = gl.createBuffer();
    if (!buf) return null;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buf);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.view(), gl.STATIC_DRAW);
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

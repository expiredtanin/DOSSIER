/**
 * Schraffur-Tessellierung für den GPU-Grundriss: wandelt ein Polygon mit
 * aufgelöster {@link HatchRender} in eine Schar echter Linien-Segmente (Modell-
 * Meter), die anschließend über `strokePolyline`/`pushLine` in die Linien-Puffer
 * fließen. Damit rendert die GPU-Ebene dieselben Muster wie der SVG-`<pattern>`-
 * Renderer, nur als tessellierte Geometrie statt als Kachel-Füllung.
 *
 * KOORDINATEN & MASSSTAB (muss deckungsgleich zum SVG sein):
 *  • Der SVG-`<pattern>` ist in BILDSCHIRM-Raum (viewBox-px, `sx = mx·PX_PER_M`)
 *    definiert; Kachelgröße = `8·scale` px (diagonal/cross) bzw. `14×10·scale` px
 *    (insulation), gedreht per `rotate(angle)` (im Uhrzeigersinn, Bildschirm-Y
 *    nach unten). Die Muster-GEOMETRIE skaliert also mit dem Zoom (Papier).
 *  • Wir erzeugen die Muster direkt in MODELL-Metern: ein px in Bildschirm-Raum
 *    entspricht `1/PX_PER_M` m. So passen Abstand/Winkel exakt zum SVG, und die
 *    Segmente lassen sich unverändert an `strokePolyline` (Papier-mm-Breite)
 *    übergeben.
 *  • Die STRICHBREITE bleibt in Papier-mm (`hatch.lineWeight`) — genau wie beim
 *    SVG-Muster, das `hatchStrokePx(lineWeight)` als non-scaling-artige Breite
 *    zeichnet.
 */

import type { Vec2 } from '../../model/types';
import type { HatchRender } from '../generatePlan';

/** Bildschirm-Einheiten (viewBox-px) je Meter — identisch zu PlanView.toScreen. */
const PX_PER_M = 90;

/** px (Bildschirm-Raum) → Meter (Modell-Raum). */
const PX_TO_M = 1 / PX_PER_M;

/** Ein Linien-Segment in Modell-Metern. */
export interface HatchSegment {
  a: Vec2;
  b: Vec2;
}

/**
 * Achsen-ausgerichtetes Bounding-Rechteck eines Polygons (Modell-Meter).
 * Leeres Polygon → degeneriert (min>max), der Aufrufer erzeugt dann keine Linien.
 */
function bbox(poly: Vec2[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Schneidet eine UNENDLICHE Linie (Aufpunkt `p0`, Einheits-Richtung `dir`) mit
 * einem einfachen (auch KONKAVEN) Polygon und liefert die INNERHALB liegenden
 * Segmente. Vorgehen (robustes Even-Odd-Scanline-Prinzip):
 *  1. Für jede Polygon-Kante den Schnitt-Parameter `t` (entlang `dir`) berechnen,
 *     bei dem die Linie die Kante quert.
 *  2. Alle `t` sortieren; aufeinanderfolgende Paare (t0,t1),(t2,t3),… liegen im
 *     Inneren (even-odd) → als Segmente zurückgeben.
 * Das ist für beliebige konkave Polygone korrekt, weil eine Gerade ein einfaches
 * Polygon stets in eine gerade Anzahl Kanten schneidet und die Innen-Intervalle
 * sich mit jeder Kreuzung ein-/ausschalten.
 *
 * Robustheit an Ecken: Ein Schnitt wird nur gezählt, wenn die Linie die Kante
 * ECHT quert (die beiden Endpunkte liegen auf verschiedenen Seiten). Berührungen
 * genau am Eckpunkt werden über eine halb-offene Kanten-Konvention (das untere
 * Kanten-Ende zählt, das obere nicht) vermieden, sodass keine doppelten oder
 * fehlenden Kreuzungen entstehen.
 */
export function clipLineToPolygon(p0: Vec2, dir: Vec2, poly: Vec2[]): HatchSegment[] {
  const n = poly.length;
  if (n < 3) return [];

  // Senkrechte zur Richtung: side(p) = vorzeichenbehaftete Distanz zur Linie.
  const nx = -dir.y;
  const ny = dir.x;
  const side = (p: Vec2) => (p.x - p0.x) * nx + (p.y - p0.y) * ny;

  const ts: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    const sa = side(a);
    const sb = side(b);

    // Beide echt auf derselben Seite → keine Kreuzung.
    if (sa > 0 && sb > 0) continue;
    if (sa < 0 && sb < 0) continue;

    // Halb-offene Konvention gegen Doppel-/Fehlzählung an Eckpunkten:
    //  • Kante liegt exakt AUF der Linie → ignorieren.
    //  • Berührung genau an einem Endpunkt (side==0) zählt nur, wenn der ANDERE
    //    Endpunkt echt oberhalb (>0) liegt. So gehört ein Eckpunkt eindeutig zur
    //    Kante darunter und wird genau EINMAL gezählt.
    if (sa === 0 && sb === 0) continue;
    if (sa === 0 && sb < 0) continue;
    if (sb === 0 && sa < 0) continue;

    // Parameter `t` entlang `dir` am Schnittpunkt: Nullstelle von side auf der
    // Kante interpolieren, dann auf `dir` projizieren.
    const denom = sa - sb;
    const u = denom !== 0 ? sa / denom : 0; // Anteil a→b bis side==0
    const ix = a.x + (b.x - a.x) * u;
    const iy = a.y + (b.y - a.y) * u;
    const t = (ix - p0.x) * dir.x + (iy - p0.y) * dir.y;
    ts.push(t);
  }

  if (ts.length < 2) return [];
  ts.sort((x, y) => x - y);

  const segs: HatchSegment[] = [];
  for (let i = 0; i + 1 < ts.length; i += 2) {
    const t0 = ts[i];
    const t1 = ts[i + 1];
    if (t1 - t0 < 1e-9) continue; // entartetes Intervall (Tangente an Ecke)
    segs.push({
      a: { x: p0.x + dir.x * t0, y: p0.y + dir.y * t0 },
      b: { x: p0.x + dir.x * t1, y: p0.y + dir.y * t1 },
    });
  }
  return segs;
}

/**
 * Schneidet ein ENDLICHES Segment [a,b] gegen ein (konkaves) Polygon und liefert
 * die innenliegenden Teilstücke. Baut auf {@link clipLineToPolygon} auf: erst die
 * Innen-Intervalle der Trägergeraden bestimmen, dann mit [a,b] (Parameterbereich
 * [0,len]) verschneiden.
 */
export function clipSegmentToPolygon(a: Vec2, b: Vec2, poly: Vec2[]): HatchSegment[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return [];
  const dir: Vec2 = { x: dx / len, y: dy / len };
  const full = clipLineToPolygon(a, dir, poly);
  const out: HatchSegment[] = [];
  for (const seg of full) {
    // Parameter der Innen-Intervall-Enden entlang `dir` (ab Aufpunkt a).
    const t0 = (seg.a.x - a.x) * dir.x + (seg.a.y - a.y) * dir.y;
    const t1 = (seg.b.x - a.x) * dir.x + (seg.b.y - a.y) * dir.y;
    const lo = Math.max(0, Math.min(t0, t1));
    const hi = Math.min(len, Math.max(t0, t1));
    if (hi - lo < 1e-9) continue;
    out.push({
      a: { x: a.x + dir.x * lo, y: a.y + dir.y * lo },
      b: { x: a.x + dir.x * hi, y: a.y + dir.y * hi },
    });
  }
  return out;
}

/**
 * Erzeugt eine Schar paralleler, aufs Polygon geclippter Linien-Segmente:
 * Richtung `angleRad` (Modell-Raum, gegen den Uhrzeigersinn), Abstand `spacingM`
 * (Meter) senkrecht zur Richtung, Phasen-Versatz `offsetM` (Meter, entlang der
 * Normalen). Deckt das Polygon vollständig ab (über dessen projizierte Ausdehnung).
 */
export function hatchLineFamily(
  poly: Vec2[],
  angleRad: number,
  spacingM: number,
  offsetM = 0,
): HatchSegment[] {
  if (poly.length < 3 || spacingM <= 1e-9) return [];
  const bb = bbox(poly);
  if (!(bb.maxX > bb.minX) && !(bb.maxY > bb.minY)) return [];

  const dir: Vec2 = { x: Math.cos(angleRad), y: Math.sin(angleRad) };
  const nrm: Vec2 = { x: -dir.y, y: dir.x }; // Linien-Normale (Scan-Richtung)

  // Rechtwinklige Projektion aller Ecken auf die Normale → Abdeckungsbereich.
  const center: Vec2 = {
    x: (bb.minX + bb.maxX) / 2,
    y: (bb.minY + bb.maxY) / 2,
  };
  let dMin = Infinity, dMax = -Infinity;
  for (const p of poly) {
    const d = (p.x - center.x) * nrm.x + (p.y - center.y) * nrm.y;
    if (d < dMin) dMin = d;
    if (d > dMax) dMax = d;
  }

  const segs: HatchSegment[] = [];
  // Raster so wählen, dass es den Bereich (inkl. Versatz) sicher deckt.
  const first = Math.floor((dMin - offsetM) / spacingM) - 1;
  const last = Math.ceil((dMax - offsetM) / spacingM) + 1;
  for (let k = first; k <= last; k++) {
    const d = offsetM + k * spacingM;
    const p0: Vec2 = { x: center.x + nrm.x * d, y: center.y + nrm.y * d };
    for (const s of clipLineToPolygon(p0, dir, poly)) segs.push(s);
  }
  return segs;
}

/** 2D-Vektor um `rad` drehen (gegen den Uhrzeigersinn, Modell-Konvention). */
function rotate(v: Vec2, rad: number): Vec2 {
  const c = Math.cos(rad), s = Math.sin(rad);
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c };
}

/**
 * Faktor mm-Papier → px-Musterraum, identisch zum SVG-`dashArray` (dort
 * `dash·(1/0.13)`). Ein 0.13-mm-Strich entspricht ~1 px Kachelmaß; dividiert man
 * mit `PX_TO_M`, ergeben sich die Strichlängen in Modell-Metern (skalieren mit
 * dem Zoom wie die Kachel selbst — genau wie die SVG-Schraffur).
 */
const DASH_MM_TO_M = (1 / 0.13) * PX_TO_M;

/**
 * Zerlegt eine Segment-Schar entlang eines Strichmusters (`dash`, in mm-Papier)
 * in die durchgezogenen Teilstücke. `dash` ist eine Sequenz [an, aus, an, …];
 * ungerade Längen werden (wie SVG/Canvas) verdoppelt. Leeres/ungültiges Muster
 * → Segmente unverändert (durchgezogen). Die Phase läuft je Segment neu bei 0
 * (Segmente sind bereits kurze Musterlinien-Stücke → sichtbar konsistent).
 */
export function applyDash(segs: HatchSegment[], dash: number[] | null): HatchSegment[] {
  if (!dash || dash.length === 0) return segs;
  // Musterlängen in Meter; nicht-positive/ungültige Werte verwerfen.
  const pat = dash.map((d) => Math.max(0, d) * DASH_MM_TO_M).filter((d) => d > 0);
  if (pat.length === 0) return segs;
  // Ungerade Länge → verdoppeln (Standard-Dash-Semantik).
  const cycle = pat.length % 2 === 0 ? pat : pat.concat(pat);
  const total = cycle.reduce((s, d) => s + d, 0);
  if (total <= 1e-9) return segs;

  const out: HatchSegment[] = [];
  for (const seg of segs) {
    const dx = seg.b.x - seg.a.x;
    const dy = seg.b.y - seg.a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-12) continue;
    const ux = dx / len, uy = dy / len;
    let pos = 0;
    let idx = 0; // gerade Index = „an", ungerade = „aus"
    while (pos < len - 1e-9) {
      const remain = cycle[idx % cycle.length];
      const end = Math.min(len, pos + remain);
      if (idx % 2 === 0 && end - pos > 1e-9) {
        out.push({
          a: { x: seg.a.x + ux * pos, y: seg.a.y + uy * pos },
          b: { x: seg.a.x + ux * end, y: seg.a.y + uy * end },
        });
      }
      pos = end;
      idx++;
    }
  }
  return out;
}

/**
 * SVG-`rotate(angleDeg)` (im Uhrzeigersinn, Bildschirm-Y nach unten) → Winkel im
 * MODELL-Raum (gegen den Uhrzeigersinn, Modell-Y nach oben). Da die Bildschirm-
 * Abbildung Y spiegelt (`sy=-my`), kehrt sich der Drehsinn um: eine im Bildschirm
 * um +angle (CW) gedrehte Musterrichtung entspricht im Modell −angle relativ zur
 * gewählten Basisrichtung.
 */
function toModelAngleRad(screenDeg: number): number {
  return (-screenDeg * Math.PI) / 180;
}

/**
 * Baut die Schraffur eines Polygons als Linien-Segmente (Modell-Meter). Bildet
 * die SVG-`<pattern>`-Geometrie 1:1 nach:
 *  • diagonal   — eine Schar; SVG-Kachel 8·scale px mit senkrechter Musterlinie
 *                 (x-konstant), gedreht um `angle`. Abstand = 8·scale px.
 *  • crosshatch — zwei Scharen (90° versetzt), gleicher Abstand.
 *  • insulation — weiche Wellenlinie, Kachel 14×10·scale px, gedreht um `angle`;
 *                 als segmentierte Polylinie tesselliert und geclippt.
 *  • solid/none — keine Linien (Vollfüllung/Umriss übernimmt der Aufrufer).
 *
 * Skala 0/negativ wird auf 1 geklemmt (kein Division-durch-Null, keine leere
 * Kachel), damit degeneriert konfigurierte Hatches trotzdem sichtbar bleiben.
 */
export function buildHatchSegments(poly: Vec2[], hatch: HatchRender): HatchSegment[] {
  if (poly.length < 3) return [];
  const pattern = hatch.pattern;
  if (pattern === 'none' || pattern === 'solid') return [];

  const scale = hatch.scale > 1e-6 ? hatch.scale : 1;

  if (pattern === 'insulation') {
    return insulationSegments(poly, hatch, scale);
  }

  // diagonal / crosshatch: parallele Geradenscharen.
  // Die SVG-Kachel ist 8·scale px; die Musterlinie läuft senkrecht (y-Achse der
  // Kachel), Abstand also 8·scale px in x. In Metern: (8·scale)/PX_PER_M.
  const spacingM = 8 * scale * PX_TO_M;

  // Kachel-Basisrichtung: die Linie läuft in der SVG-Kachel entlang +Y
  // (Bildschirm, nach unten). Im Modell (Y gespiegelt) entspricht das (0,-1).
  // Zusätzlich um `angle` (SVG-CW) gedreht → Modell-CCW um −angle.
  const rot = toModelAngleRad(hatch.angle);
  const dir1 = rotate({ x: 0, y: -1 }, rot);
  const a1 = Math.atan2(dir1.y, dir1.x);
  const segs = hatchLineFamily(poly, a1, spacingM, 0);

  if (pattern === 'crosshatch') {
    // Zweite Schar: die SVG-Kachel trägt zusätzlich eine horizontale Linie
    // (x-Achse der Kachel) → 90° zur ersten, gleicher Abstand.
    for (const s of hatchLineFamily(poly, a1 + Math.PI / 2, spacingM, 0)) segs.push(s);
  }
  return segs;
}

/**
 * Dämmungs-Schraffur (Wellenlinie): die SVG-Kachel ist 14×10·scale px und trägt
 * pro Kachel eine weiche Bézier-Welle. Wir bilden sie als Scharwellen nach: eine
 * Schar paralleler „Musterachsen" im Abstand der Kachelhöhe (10·scale px), auf
 * jeder Achse eine tessellierte Sinuswelle mit Wellenlänge = Kachelbreite
 * (14·scale px) und weicher Amplitude. Jede Wellen-Polylinie wird Segment für
 * Segment aufs Polygon geclippt (even-odd), sodass die Welle exakt an den
 * Polygonkanten endet.
 */
function insulationSegments(poly: Vec2[], hatch: HatchRender, scale: number): HatchSegment[] {
  const bb = bbox(poly);
  const rot = toModelAngleRad(hatch.angle);

  // Muster-Parameter in Metern (aus den SVG-px-Werten der Kachel).
  const wavelength = 14 * scale * PX_TO_M; // Kachelbreite
  const rowGap = 10 * scale * PX_TO_M; // Kachelhöhe → Zeilenabstand
  const amplitude = 3 * scale * PX_TO_M; // Wellen-Amplitude (weich)

  // Lokales Muster-Koordinatensystem: u entlang der Welle, v quer (Zeilen).
  const uDir = rotate({ x: 1, y: 0 }, rot);
  const vDir = rotate({ x: 0, y: 1 }, rot);

  // Abdeckungsbereich in (u,v) über die Polygon-Ecken bestimmen.
  const center: Vec2 = { x: (bb.minX + bb.maxX) / 2, y: (bb.minY + bb.maxY) / 2 };
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const p of poly) {
    const u = (p.x - center.x) * uDir.x + (p.y - center.y) * uDir.y;
    const v = (p.x - center.x) * vDir.x + (p.y - center.y) * vDir.y;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  if (!(uMax > uMin) || !(vMax > vMin)) return [];

  // Feinheit der Wellen-Tessellierung (Segmente je Wellenlänge).
  const STEPS = 12;
  const du = wavelength / STEPS;

  const out: HatchSegment[] = [];
  const toWorld = (u: number, v: number): Vec2 => ({
    x: center.x + uDir.x * u + vDir.x * v,
    y: center.y + uDir.y * u + vDir.y * v,
  });

  const firstRow = Math.floor(vMin / rowGap) - 1;
  const lastRow = Math.ceil(vMax / rowGap) + 1;
  const uStart = Math.floor((uMin - wavelength) / du) * du;
  const uEnd = uMax + wavelength;

  for (let r = firstRow; r <= lastRow; r++) {
    const vBase = r * rowGap;
    // Eine Welle als Polylinie tessellieren, dann JEDES Segment clippen.
    let prev: Vec2 | null = null;
    for (let u = uStart; u <= uEnd + 1e-9; u += du) {
      const wave = amplitude * Math.sin((2 * Math.PI * u) / wavelength);
      const pt = toWorld(u, vBase + wave);
      if (prev) {
        for (const s of clipSegmentToPolygon(prev, pt, poly)) out.push(s);
      }
      prev = pt;
    }
  }
  return out;
}

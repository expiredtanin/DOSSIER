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
 * Ein zusammenhängender Linienzug in Modell-Metern (≥2 Punkte). Gerade
 * Musterlinien (diagonal/crosshatch) sind 2-Punkt-Läufe; die Dämmungs-Welle ist
 * ein langer, an den Polygonkanten geclippter Lauf. Läufe fließen als EIN gehrter
 * Streifen in `strokePolyline` → glatte Übergänge statt Butt-Cap-Stufen.
 */
export type HatchRun = Vec2[];

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
 * Schneidet eine ZUSAMMENHÄNGENDE Polylinie `pts` gegen ein (auch KONKAVES)
 * einfaches Polygon und liefert die innenliegenden Teile als CONTINUOUS runs
 * (jeder Lauf = Vec2[] mit ≥2 Punkten). Anders als segmentweises Clippen bleiben
 * aufeinanderfolgende Innen-Segmente in EINEM Lauf verbunden — die interne
 * Tessellierung (z. B. Sinus-Stützpunkte) wird NICHT an jedem Vertex zerrissen.
 * Nur ein echtes Austreten aus dem Polygon (bzw. eine Lücke) beginnt einen neuen
 * Lauf. Nutzt dieselbe Even-Odd-/halb-offene-Kanten-Konvention wie
 * {@link clipLineToPolygon} via {@link clipSegmentToPolygon}.
 *
 * Verfahren: jede Polylinien-Kante wird geclippt; die (in Laufrichtung
 * sortierten) Innenstücke werden an den laufenden Lauf angehängt, solange ihr
 * Anfang bündig ans bisherige Lauf-Ende anschließt. Sobald ein Innenstück nicht
 * am Lauf-Ende beginnt (Wiedereintritt nach einem Austritt) oder die Kante gar
 * kein Innenstück liefert (komplett außen), wird der Lauf abgeschlossen.
 */
export function clipPolylineToPolygon(pts: Vec2[], poly: Vec2[]): HatchRun[] {
  if (pts.length < 2 || poly.length < 3) return [];
  const EPS = 1e-9;
  const near = (p: Vec2, q: Vec2) => Math.abs(p.x - q.x) < EPS && Math.abs(p.y - q.y) < EPS;

  const runs: HatchRun[] = [];
  let cur: HatchRun | null = null;

  const closeRun = () => {
    if (cur && cur.length >= 2) runs.push(cur);
    cur = null;
  };

  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    // Innenstücke dieser Kante, in Laufrichtung a→b sortiert (clipSegment liefert
    // sie bereits entlang der Trägergeraden geordnet; a→b ist die positive Richtung).
    const pieces = clipSegmentToPolygon(a, b, poly);
    for (const seg of pieces) {
      // Kante in Laufrichtung orientieren (clipSegment kann a/b vertauschen).
      const dx = b.x - a.x, dy = b.y - a.y;
      const ta = (seg.a.x - a.x) * dx + (seg.a.y - a.y) * dy;
      const tb = (seg.b.x - a.x) * dx + (seg.b.y - a.y) * dy;
      const s = ta <= tb ? seg.a : seg.b;
      const e = ta <= tb ? seg.b : seg.a;

      if (cur && near(cur[cur.length - 1], s)) {
        // Nahtloser Anschluss ans Lauf-Ende → nur den neuen Endpunkt anhängen.
        cur.push(e);
      } else {
        // Neuer Lauf (erster Innenteil oder Wiedereintritt nach Austritt).
        closeRun();
        cur = [s, e];
      }
    }
    // Endete diese Kante NICHT genau am Polygonrand-Innenstück bis b (d. h. das
    // letzte Innenstück reicht nicht bis zum Kantenende b), so tritt der Lauf hier
    // aus dem Polygon → beim nächsten Innenteil beginnt ein neuer Lauf.
    if (cur && !near(cur[cur.length - 1], b)) closeRun();
  }
  closeRun();
  return runs;
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
  // ANKER = MODELL-URSPRUNG (nicht die Polygon-Mitte): der SVG-`<pattern>` ist
  // `userSpaceOnUse`, sein Kachelgitter liegt global im viewBox-Raum fest
  // (Ursprung (0,0) = Modell-Ursprung). Nur mit demselben Anker liegen die
  // Musterlinien deckungsgleich zum SVG-Referenzpfad — und benachbarte Polygone
  // teilen dieselbe Muster-Phase statt je eigener (bbox-abhängiger) Versätze.
  const center: Vec2 = { x: 0, y: 0 };
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
export const DASH_MM_TO_M = (1 / 0.13) * PX_TO_M;

/**
 * Zerlegt zusammenhängende Läufe entlang eines Strichmusters (`dash`, in mm-
 * Papier) in die durchgezogenen Teil-Läufe. `dash` ist eine Sequenz
 * [an, aus, an, …]; ungerade Längen werden (wie SVG/Canvas) verdoppelt. Leeres/
 * ungültiges Muster → Läufe unverändert (durchgezogen). Die Phase läuft ENTLANG
 * DES GESAMTEN LAUFS durch (über Stützpunkt-Ecken hinweg), sodass die Striche
 * einer gekrümmten Musterlinie (Dämmungswelle) gleichmäßig und ecken-übergreifend
 * verteilt sind. Jedes „an"-Stück wird als eigener (kurzer) Lauf ausgegeben und
 * kann selbst über mehrere Stützpunkt-Segmente reichen.
 */
export function applyDashRuns(runs: HatchRun[], dash: number[] | null): HatchRun[] {
  if (!dash || dash.length === 0) return runs;
  // Musterlängen in Meter; nicht-positive/ungültige Werte verwerfen.
  const pat = dash.map((d) => Math.max(0, d) * DASH_MM_TO_M).filter((d) => d > 0);
  if (pat.length === 0) return runs;
  // Ungerade Länge → verdoppeln (Standard-Dash-Semantik).
  const cycle = pat.length % 2 === 0 ? pat : pat.concat(pat);
  const total = cycle.reduce((s, d) => s + d, 0);
  if (total <= 1e-9) return runs;

  const out: HatchRun[] = [];
  for (const run of runs) {
    if (run.length < 2) continue;
    // Bogenlänge je Stützpunkt vorab, um Dash-Positionen auf Segmente abzubilden.
    let idx = 0; // gerade Index = „an", ungerade = „aus"
    let dashLeft = cycle[0]; // verbleibende Länge im aktuellen Dash-Zustand
    let on = true;
    let piece: Vec2[] | null = [run[0]]; // aktuell offenes „an"-Stück

    const flush = () => {
      if (piece && piece.length >= 2) out.push(piece);
      piece = null;
    };

    for (let i = 0; i + 1 < run.length; i++) {
      let a = run[i];
      const b = run[i + 1];
      let segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen < 1e-12) continue;
      let ux = (b.x - a.x) / segLen, uy = (b.y - a.y) / segLen;
      // Segment ggf. an Dash-Grenzen zerschneiden.
      while (segLen > 1e-9) {
        const step = Math.min(segLen, dashLeft);
        const mid: Vec2 = { x: a.x + ux * step, y: a.y + uy * step };
        if (on) {
          if (!piece) piece = [a];
          piece.push(mid);
        }
        // Vorrücken.
        a = mid;
        segLen -= step;
        dashLeft -= step;
        if (dashLeft <= 1e-9) {
          // Dash-Zustand wechseln.
          if (on) flush();
          on = !on;
          idx++;
          dashLeft = cycle[idx % cycle.length];
          if (on) piece = [a]; // neues „an"-Stück beginnt hier
        }
      }
    }
    flush();
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
 * Baut die Schraffur eines Polygons als zusammenhängende Läufe ({@link HatchRun},
 * Modell-Meter). Bildet die SVG-`<pattern>`-Geometrie 1:1 nach:
 *  • diagonal   — eine Schar; SVG-Kachel 8·scale px mit senkrechter Musterlinie
 *                 (x-konstant), gedreht um `angle`. Abstand = 8·scale px. Jede
 *                 Musterlinie ist ein gerader 2-Punkt-Lauf.
 *  • crosshatch — zwei Scharen (90° versetzt), gleicher Abstand.
 *  • insulation — weiche Wellenlinie, Kachel 14×10·scale px, gedreht um `angle`;
 *                 als DURCHGEHENDE Polylinie tesselliert und in kontinuierliche
 *                 Läufe geclippt (glatte gehrte Übergänge statt Butt-Cap-Stufen).
 *  • solid/none — keine Linien (Vollfüllung/Umriss übernimmt der Aufrufer).
 *
 * Skala 0/negativ wird auf 1 geklemmt (kein Division-durch-Null, keine leere
 * Kachel), damit degeneriert konfigurierte Hatches trotzdem sichtbar bleiben.
 */
export function buildHatchRuns(poly: Vec2[], hatch: HatchRender): HatchRun[] {
  if (poly.length < 3) return [];
  const pattern = hatch.pattern;
  if (pattern === 'none' || pattern === 'solid') return [];

  const scale = hatch.scale > 1e-6 ? hatch.scale : 1;

  // Random-Vektor-Untermodus (Kies/Splitt): kurze, deterministisch gestreute
  // Striche statt der regelmäßigen Parallel-/Kreuzschar. Bild-Schraffuren
  // (kind==="image") werden hier NICHT als Vektorlinien erzeugt — sie fallen im
  // Aufrufer auf eine neutrale Füllung zurück (RScene/GL kennen keine Textur).
  if (hatch.kind !== 'image' && hatch.lines === 'random') {
    return buildRandomHatchRuns(poly, hatch, scale);
  }

  if (pattern === 'insulation') {
    return insulationRuns(poly, hatch, scale);
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
  // Gerade Musterlinien → 2-Punkt-Läufe (visuell identisch zu Butt-Cap-Segmenten).
  const runs: HatchRun[] = hatchLineFamily(poly, a1, spacingM, 0).map((s) => [s.a, s.b]);

  if (pattern === 'crosshatch') {
    // Zweite Schar: die SVG-Kachel trägt zusätzlich eine horizontale Linie
    // (x-Achse der Kachel) → 90° zur ersten, gleicher Abstand.
    for (const s of hatchLineFamily(poly, a1 + Math.PI / 2, spacingM, 0)) runs.push([s.a, s.b]);
  }
  return runs;
}

/**
 * Dämmungs-Schraffur (Wellenlinie): die SVG-Kachel ist 14×10·scale px und trägt
 * pro Kachel eine weiche Bézier-Welle. Wir bilden sie als Scharwellen nach: eine
 * Schar paralleler „Musterachsen" im Abstand der Kachelhöhe (10·scale px), auf
 * jeder Achse eine tessellierte Sinuswelle mit Wellenlänge = Kachelbreite
 * (14·scale px) und weicher Amplitude. Jede Wellen-Polylinie wird als
 * DURCHGEHENDER Zug aufs Polygon geclippt ({@link clipPolylineToPolygon}), sodass
 * benachbarte Wellen-Stützpunkte in EINEM Lauf verbunden bleiben. Der Compiler
 * strokt den Lauf als gehrten Streifen → glatte, spitzenfreie Welle. Die Welle
 * endet exakt an den Polygonkanten (even-odd-Clipping, konkav-fähig).
 */
function insulationRuns(poly: Vec2[], hatch: HatchRender, scale: number): HatchRun[] {
  const rot = toModelAngleRad(hatch.angle);

  // Muster-Parameter in Metern (aus den SVG-px-Werten der Kachel).
  const wavelength = 14 * scale * PX_TO_M; // Kachelbreite
  const rowGap = 10 * scale * PX_TO_M; // Kachelhöhe → Zeilenabstand

  // Lokales Muster-Koordinatensystem: u entlang der Welle, v quer (Zeilen).
  // ANKER = MODELL-URSPRUNG, wie beim SVG-`userSpaceOnUse`-Pattern (siehe
  // hatchLineFamily): so liegen Wellen-Phase UND Zeilenraster deckungsgleich
  // zum SVG-Referenzpfad und über alle Polygone hinweg in EINEM Gitter.
  const uDir = rotate({ x: 1, y: 0 }, rot);
  const vDir = rotate({ x: 0, y: 1 }, rot);

  // Abdeckungsbereich in (u,v) über die Polygon-Ecken bestimmen.
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const p of poly) {
    const u = p.x * uDir.x + p.y * uDir.y;
    const v = p.x * vDir.x + p.y * vDir.y;
    if (u < uMin) uMin = u;
    if (u > uMax) uMax = u;
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  if (!(uMax > uMin) || !(vMax > vMin)) return [];

  // Feinheit der Wellen-Tessellierung (Segmente je Wellenlänge). Höher als beim
  // segmentweisen Ansatz, da die Läufe jetzt glatt gehrt werden → weichere Welle.
  const STEPS = 22;
  const du = wavelength / STEPS;

  const runs: HatchRun[] = [];
  const toWorld = (u: number, v: number): Vec2 => ({
    x: uDir.x * u + vDir.x * v,
    y: uDir.y * u + vDir.y * v,
  });

  // Die Wellen-Mittellinie liegt in der SVG-Kachel bei y = h/2 (my = 5·scale),
  // die Zeilen also auf HALBEN Rasterlinien: v = (r + 0.5)·rowGap.
  const firstRow = Math.floor(vMin / rowGap - 0.5) - 1;
  const lastRow = Math.ceil(vMax / rowGap - 0.5) + 1;
  const uStart = Math.floor((uMin - wavelength) / du) * du;
  const uEnd = uMax + wavelength;

  // EXAKT die SVG-Wellenform: die Kachel zeichnet zwei quadratische Béziers
  // `M0 5s Q 3.5s -1s 7s 5s Q 10.5s 11s 14s 5s`. Deren x(t) ist LINEAR (7s·t je
  // Halbwelle), die Auslenkung eine Parabel ±12s·t(1−t) (Scheitel ±3s) — also
  // Halbwellen-Parabeln statt einer Sinuskurve (flachere Kämme, steilere
  // Nulldurchgänge). Erste Halbwelle: Kamm nach OBEN (Bildschirm) = +v (Modell).
  const half = wavelength / 2;
  const waveAt = (u: number): number => {
    const phase = ((u % wavelength) + wavelength) % wavelength;
    const t = (phase % half) / half;
    const mag = 12 * scale * PX_TO_M * t * (1 - t);
    return phase < half ? mag : -mag;
  };

  for (let r = firstRow; r <= lastRow; r++) {
    const vBase = (r + 0.5) * rowGap;
    // Ganze Welle als EINE Polylinie tessellieren, dann DURCHGEHEND clippen.
    // Das u-Raster ist an Vielfachen von du = λ/22 ausgerichtet → die Null-
    // durchgänge (Vielfache von λ/2 = 11·du) liegen exakt auf Stützpunkten.
    const wavePts: Vec2[] = [];
    for (let u = uStart; u <= uEnd + 1e-9; u += du) {
      wavePts.push(toWorld(u, vBase + waveAt(u)));
    }
    for (const run of clipPolylineToPolygon(wavePts, poly)) runs.push(run);
  }
  return runs;
}

// ── Random-Vektor-Schraffur (deterministisch) ────────────────────────────────

/**
 * Deterministischer 32-bit-PRNG (mulberry32). Gleicher Seed ⇒ gleiche Folge —
 * KEIN `Math.random()`: die Random-Schraffur muss über Re-Renders/Print
 * reproduzierbar sein (sonst flackert der Splitt und der Druck ist nicht
 * deterministisch).
 */
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
 * Faltet mehrere Fließkomma-Kennwerte zu einem stabilen 32-bit-Seed. Die Werte
 * werden gequantelt (·1000, gerundet), damit numerisches Rauschen den Seed nicht
 * verschiebt — gleiche Fläche/gleiche Hatch-Parameter ⇒ gleicher Seed ⇒ gleiche
 * Streuung.
 */
function hashSeed(...vals: number[]): number {
  let h = 0x811c9dc5;
  for (const v of vals) {
    const q = Math.round(v * 1000) | 0;
    h ^= q & 0xffff;
    h = Math.imul(h, 0x01000193);
    h ^= (q >>> 16) & 0xffff;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministischer Hash EINER Modellraum-Zelle (`ix`,`iy` = absolute Zell-Indizes
 * `floor(x/cell)`/`floor(y/cell)`) plus `seed`. Ergebnis ist ein 32-bit-Seed für
 * {@link mulberry32}. Zentraler Baustein der modellraum-stabilen Streuung: der
 * Zell-Inhalt hängt NUR an den absoluten Zell-Indizes + Seed — NICHT an der
 * Bounding-Box der Fläche. Dadurch bleibt ein Strich beim Vergrößern/Verschieben
 * der Fläche an derselben Zelle „verankert".
 */
function hashCell(ix: number, iy: number, seed: number): number {
  let h = (0x811c9dc5 ^ (seed | 0)) >>> 0;
  h = Math.imul(h ^ (ix | 0), 0x01000193);
  h = Math.imul(h ^ (iy | 0), 0x01000193);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

/**
 * Streut kurze Striche gleichmäßig-zufällig (aber DETERMINISTISCH) über ein
 * Polygon — MODELLRAUM-STABIL: Der Modellraum wird in ein regelmäßiges Gitter der
 * Zellgröße `cell` gekachelt (absolutes Gitter, Ursprung = Modell-Ursprung). Über
 * die Zellen, die die Polygon-Bounding-Box überdecken, wird iteriert (nur aus
 * Performance-Gründen); PRO Zelle liefert {@link hashCell}(ix,iy,seed) einen festen
 * PRNG, aus dem Lage (innerhalb der Zelle), Orientierung (um `baseAngleRad` ± π)
 * und Länge folgen. Jeder Strich wird aufs Polygon geclippt
 * ({@link clipSegmentToPolygon}, konkav-fähig).
 *
 * Folge: Beim Vergrößern der Fläche bleiben bestehende Striche STEHEN (gleiche
 * Zelle ⇒ gleicher Strich), am Rand kommen neue dazu; die Dichte (Striche pro
 * Fläche) bleibt konstant; beim Verschieben wandert nichts. „Neu würfeln" (neuer
 * `seed`) verschiebt das ganze Feld. Einheiten-agnostisch (Aufrufer gibt `cell`/
 * `strokeLen` in Modell-Metern bzw. Papier-mm). Ausgabe = 2-Punkt-Läufe.
 */
export function scatterStrokes(
  poly: Vec2[],
  cell: number,
  baseAngleRad: number,
  seed: number,
  strokeLen: number,
  lenMin?: number,
  lenMax?: number,
): HatchRun[] {
  if (poly.length < 3 || cell <= 1e-9 || strokeLen <= 1e-9) return [];
  const bb = bbox(poly);
  if (!(bb.maxX > bb.minX) || !(bb.maxY > bb.minY)) return [];

  // Absolute Zell-Indizes, die die Bounding-Box überdecken (Modell-Ursprung als
  // Gitter-Anker → verschiebe-invariant).
  let eff = cell;
  let ix0 = Math.floor(bb.minX / eff);
  let ix1 = Math.floor(bb.maxX / eff);
  let iy0 = Math.floor(bb.minY / eff);
  let iy1 = Math.floor(bb.maxY / eff);
  // Sicherheits-Cap gegen pathologisch große Flächen / winzige Zellen: Zellgröße
  // gröber machen, bis die Zellzahl unter dem Limit liegt (uniform, nur grober).
  const MAX_CELLS = 250000;
  let cells = (ix1 - ix0 + 1) * (iy1 - iy0 + 1);
  if (cells > MAX_CELLS) {
    eff = cell * Math.sqrt(cells / MAX_CELLS);
    ix0 = Math.floor(bb.minX / eff);
    ix1 = Math.floor(bb.maxX / eff);
    iy0 = Math.floor(bb.minY / eff);
    iy1 = Math.floor(bb.maxY / eff);
  }

  // Explizite Längen-Spanne (falls gesetzt) validieren; sonst die scale-abhängige
  // Variation (±40 % um `strokeLen`) beibehalten.
  const hasRange =
    lenMin != null && lenMax != null && lenMin > 1e-9 && lenMax >= lenMin;

  const runs: HatchRun[] = [];
  for (let iy = iy0; iy <= iy1; iy++) {
    for (let ix = ix0; ix <= ix1; ix++) {
      const rnd = mulberry32(hashCell(ix, iy, seed));
      // Strich-Mittelpunkt innerhalb der Zelle (absolutes Gitter).
      const cx = (ix + rnd()) * eff;
      const cy = (iy + rnd()) * eff;
      // Orientierung frei (± π um die Basisrichtung).
      const ang = baseAngleRad + (rnd() * 2 - 1) * Math.PI;
      // Länge: explizite Spanne [lenMin,lenMax] oder Default (±40 % um strokeLen).
      const len = hasRange
        ? lenMin! + rnd() * (lenMax! - lenMin!)
        : strokeLen * (0.6 + 0.8 * rnd());
      const half = len * 0.5;
      const dx = Math.cos(ang) * half;
      const dy = Math.sin(ang) * half;
      const a: Vec2 = { x: cx - dx, y: cy - dy };
      const b: Vec2 = { x: cx + dx, y: cy + dy };
      for (const seg of clipSegmentToPolygon(a, b, poly)) runs.push([seg.a, seg.b]);
    }
  }
  return runs;
}

/**
 * Random-Vektor-Schraffur eines Polygons in Modell-Metern (Kies/Splitt). Dichte
 * und Strichlänge sind — wie die Parallelschar — an die Kachelgröße (`8·scale` px)
 * gekoppelt, damit `scale`/`density` die Streudichte steuern. Die Streuung ist
 * MODELLRAUM-STABIL (siehe {@link scatterStrokes}): der Seed hängt NUR an den
 * Muster-Parametern (Winkel/Scale/Dichte) plus dem expliziten `hatch.seed` — NICHT
 * an der Bounding-Box. Dadurch verankern sich die Striche im Modellraum; beim
 * Vergrößern der Fläche bleiben sie stehen und die Dichte bleibt konstant.
 */
export function buildRandomHatchRuns(poly: Vec2[], hatch: HatchRender, scale?: number): HatchRun[] {
  const s = scale ?? (hatch.scale > 1e-6 ? hatch.scale : 1);
  // Dichte: Multiplikator auf den Grundabstand (>1 = dichter → kleinere Zelle).
  // Fehlt/ungültig ⇒ 1 ⇒ heutiges Verhalten.
  const density = hatch.density != null && hatch.density > 1e-6 ? hatch.density : 1;
  const cell = (8 * s * PX_TO_M) / density; // Meter, wie der Parallel-Schar-Abstand
  const strokeLen = cell * 1.1; // Default-Strich ~ Kachelmaß (wenn keine Längenspanne)
  // Fester Seed NUR aus Muster-Parametern + explizitem `hatch.seed` (KEINE bbox):
  // „Neu würfeln" (neuer seed) ⇒ anderes Feld, aber gleicher seed + gleiche
  // Muster-Parameter ⇒ identisches, modellraum-verankertes Feld über alle
  // Renderpfade — unabhängig von Lage/Größe der Fläche.
  const seed = hashSeed(hatch.angle, s, density, hatch.seed ?? 0);
  const base = toModelAngleRad(hatch.angle);
  // Explizite Längenspanne (mm-Papier → Modell-Meter, wie das Dash-Muster).
  const lenMin = hatch.lengthMin != null ? hatch.lengthMin * DASH_MM_TO_M : undefined;
  const lenMax = hatch.lengthMax != null ? hatch.lengthMax * DASH_MM_TO_M : undefined;
  return scatterStrokes(poly, cell, base, seed, strokeLen, lenMin, lenMax);
}

// ── Zickzack-/Wellen-Linie ───────────────────────────────────────────────────

/**
 * Tesselliert die Strecke [a,b] zu einem Zickzack (Dreieckswelle) mit `amplitude`
 * (Ausschlag quer, Einheit wie a/b) und `wavelength` (Periodenlänge längs). Rein
 * geometrisch, einheiten-agnostisch: der Aufrufer übergibt amplitude/wavelength
 * in der Zielkoordinaten-Einheit. Die Auslenkung folgt dem Muster [0,+A,0,−A] je
 * Viertel-Wellenlänge; Start liegt auf der Achse, das Ende exakt auf `b`.
 */
export function zigzagPoints(a: Vec2, b: Vec2, amplitude: number, wavelength: number): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  if (L < 1e-12 || wavelength <= 1e-9 || amplitude <= 0) return [a, b];
  const ux = dx / L;
  const uy = dy / L;
  const nx = -uy; // linke Normale (Ausschlagachse)
  const ny = ux;
  const quarter = wavelength / 4;
  const steps = Math.max(1, Math.round(L / quarter));
  const tri = [0, 1, 0, -1];
  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = Math.min(L, i * quarter);
    const off = amplitude * tri[i % 4];
    pts.push({ x: a.x + ux * t + nx * off, y: a.y + uy * t + ny * off });
  }
  const last = pts[pts.length - 1];
  if (Math.abs(last.x - b.x) > 1e-9 || Math.abs(last.y - b.y) > 1e-9) {
    pts.push({ x: b.x, y: b.y });
  }
  return pts;
}

/**
 * Kachelt ein frei gezeichnetes Motiv (offene Polylinie in einer Einheitszelle)
 * entlang der Strecke [a,b] und liefert die zusammenhängende Polylinie. Rein
 * geometrisch/einheiten-agnostisch (die Verallgemeinerung von {@link zigzagPoints}):
 *  • `motif.points` sind die Stützpunkte der Zelle; `x` läuft 0..`motif.length`
 *    ENTLANG der Linie (= Wiederhollänge), `y` = Versatz quer zur Linie (linke
 *    Normale `n = (-u.y, u.x)`).
 *  • `scale` skaliert Punkte UND Länge in die Zielkoordinaten-Einheit (z. B.
 *    Papier-mm → Modell-Meter via `DASH_MM_TO_M`); der Print-SVG-Pfad übergibt 1.
 * Das Motiv wird alle `length·scale` wiederholt; am Segment-Ende exakt bei `L`
 * geclippt (letztes Segment interpoliert), sodass die Linie nicht über `b`
 * hinausläuft. Degeneriert (leeres Motiv, Länge 0, Nullstrecke) → `[a, b]`.
 */
export function motifPoints(
  a: Vec2,
  b: Vec2,
  motif: { points: Vec2[]; length: number },
  scale = 1,
): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L = Math.hypot(dx, dy);
  const cell = motif.length * scale;
  if (L < 1e-12 || cell <= 1e-9 || motif.points.length < 2) return [a, b];
  const ux = dx / L;
  const uy = dy / L;
  const nx = -uy; // linke Normale (Ausschlagachse)
  const ny = ux;
  const toWorld = (ax: number, off: number): Vec2 => ({
    x: a.x + ux * ax + nx * off,
    y: a.y + uy * ax + ny * off,
  });

  const out: Vec2[] = [];
  const reps = Math.ceil(L / cell) + 1;
  let last: { ax: number; off: number } | null = null;
  for (let r = 0; r < reps; r++) {
    const base = r * cell;
    for (let i = 0; i < motif.points.length; i++) {
      const p = motif.points[i];
      const ax = base + p.x * scale;
      const off = p.y * scale;
      // Naht-Duplikat (Zellenende r == Zellenanfang r+1) überspringen.
      if (last && Math.abs(ax - last.ax) < 1e-9 && Math.abs(off - last.off) < 1e-9) {
        continue;
      }
      if (ax > L + 1e-9) {
        // Letztes Segment am Segmentende clippen: last→p bei ax = L interpolieren.
        if (last && ax > last.ax + 1e-12 && L - last.ax > 1e-9) {
          const tt = (L - last.ax) / (ax - last.ax);
          out.push(toWorld(L, last.off + (off - last.off) * tt));
        }
        return out.length >= 2 ? out : [a, b];
      }
      out.push(toWorld(ax, off));
      last = { ax, off };
    }
  }
  return out.length >= 2 ? out : [a, b];
}

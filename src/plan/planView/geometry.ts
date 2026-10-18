// Reine Geometrie-/Massstabs-Helfer für PlanView: Modell↔Screen-Abbildung,
// Papier-Massstab-Umrechnung, Punkt-/Polygon-Tests fürs Marquee-Picking.
// Keine JSX, kein Komponenten-/Closure-Zugriff — pure Funktionen + Konstanten.

import type { Vec2 } from "../../model/types";
import type { Primitive } from "../generatePlan";

/** Rechteckiger Ausschnitt in SVG-Benutzerkoordinaten (viewBox-Einheiten). */
export interface ViewBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const PX_PER_M = 90; // viewBox-Einheiten je Meter (Modell → SVG-Benutzerraum)
export const PAD = 60; // Rand in viewBox-Einheiten

/**
 * Modell-Meter → SVG-Benutzerraum (viewBox-Einheiten) mit FIXEM Welt-Ursprung
 * am Modell-Nullpunkt (0,0): `x·PX_PER_M`, Plan-Y zeigt nach oben → SVG-Y nach
 * unten, daher `-y·PX_PER_M`. BEWUSST unabhängig von den Modell-Bounds — so
 * verschiebt sich die Abbildung NICHT, wenn sich Elemente ändern (Verschieben/
 * Löschen). Der sichtbare Ausschnitt (viewBox) bleibt dann stehen; nur manuelles
 * Pan/Zoom/Einpassen ändert ihn. (Inverse: `viewToModel` in `PlanView.tsx`.)
 */
export function toScreen(p: Vec2): Vec2 {
  return { x: p.x * PX_PER_M, y: -p.y * PX_PER_M };
}

/**
 * Zerlegt den Rand eines Polygons in zusammenhängende OFFENE Linienzüge, wobei die
 * Kanten in `noStroke` ausgelassen werden (Kante `i` = pts[i]→pts[i+1]). Genutzt,
 * um die inneren Gehrungs-Stirnkanten an einer Wandecke NICHT zu stricheln (keine
 * 45°-Naht, keine über den Apex schießende Barbe), während die Füllung das volle
 * Polygon bleibt. Jeder Lauf beginnt an einer sichtbaren Kante, deren Vorgänger
 * ausgelassen ist.
 */
export function visibleEdgeRuns(scr: Vec2[], noStroke: number[]): Vec2[][] {
  const n = scr.length;
  const skip = new Set(noStroke.map((i) => ((i % n) + n) % n));
  if (skip.size >= n || n < 2) return [];
  const visible = (i: number) => !skip.has(((i % n) + n) % n);
  const runs: Vec2[][] = [];
  for (let s = 0; s < n; s++) {
    if (!visible(s) || visible(s - 1 + n)) continue; // kein Lauf-Anfang
    const run: Vec2[] = [scr[s]];
    let j = s;
    while (visible(j) && j - s < n) {
      run.push(scr[(j + 1) % n]);
      j++;
    }
    runs.push(run);
  }
  return runs;
}

/**
 * Papier-Massstab (docs/design/plans-output.md §3): Der Plan IST Papier-Space.
 * dpi = 96 (CSS definiert 1 CSS-px = 1/96 inch, UNABHÄNGIG von devicePixelRatio —
 * das gilt genauso auf Retina/HiDPI-Displays und bei OS-Skalierung, da der
 * Browser CSS-px genau dafür physisch konstant hält, egal wie viele Geräte-px
 * dahinterstecken). Strichstärken sind in mm Papier definiert und werden über
 * diese dpi in konstante Bildschirm-Pixel umgerechnet (zusammen mit
 * vector-effect:non-scaling-stroke bleiben sie beim Zoomen papierkonstant).
 */
export const dpi = (): number => 96;
/** mm Papier → Bildschirm-Pixel (für non-scaling-stroke / dasharray). */
export const mmToPx = (mm: number): number => (mm / 25.4) * dpi();

/** Konstante Haarlinien-Breite (Bildschirm-px) im Display-Modus. */
export const HAIRLINE_PX = 1;

/**
 * Print-Strichbreite: eine echte Papier-mm-Breite `mm` in VIEWBOX-EINHEITEN,
 * bezogen auf den (beim Rad-Zoom stabilen) Papier-Massstab-Nenner `n` (1:N).
 *   • Auf Papier 1:N bildet 1 Welt-Meter auf `1000/N` Papier-mm ab, d. h. eine
 *     `mm`-Strichbreite belegt `mm·N/1000` Welt-Meter.
 *   • toScreen bildet 1 Welt-Meter → PX_PER_M viewBox-Einheiten ab, also
 *     `strokeVb = mm·N/1000·PX_PER_M`.
 * Ohne non-scaling-stroke gezeichnet, skaliert dieser Wert MIT der Geometrie:
 * reinzoomen (mehr px je viewBox-Einheit) = dicker, rauszoomen = dünner. Und
 * von 1:10 auf 1:100 (N: 10→100) wird jede Linie bei gleichem Zoom ×10 dicker.
 * Fällt `n` weg (noch nicht gemessen), bleibt es bei einer minimalen sichtbaren
 * Breite (kein „unsichtbar").
 */
export function printStrokeVb(mm: number, n: number): number {
  return Math.max(1e-4, (mm * n) / 1000) * PX_PER_M;
}

/**
 * Effektive meet-Skala (Bildschirm-px je viewBox-Einheit) für einen Ausschnitt.
 * preserveAspectRatio="xMidYMid meet" nimmt die kleinere der beiden Achsen.
 * Liefert null, solange das SVG noch nicht gemessen werden kann.
 */
export function meetScale(vb: ViewBox, el: SVGSVGElement | null): number | null {
  const rect = el?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return Math.min(rect.width / vb.w, rect.height / vb.h);
}

/**
 * LIVE Papier-Massstab 1:N aus dem Ausschnitt (docs/design/plans-output.md §3):
 * 1 m belegt `scale·PX_PER_M` CSS-px; in mm = ·25.4/dpi; auf Papier 1:N sind
 * das 1000/N mm ⇒ N = 1000·dpi / (scale·PX_PER_M·25.4). Letterbox-korrekt, da
 * `scale` die tatsächliche meet-Skala ist.
 */
export function scaleFromView(vb: ViewBox, el: SVGSVGElement | null): number | null {
  const scale = meetScale(vb, el);
  if (scale == null) return null;
  return (1000 * dpi()) / (scale * PX_PER_M * 25.4);
}

/**
 * Ziel-Ausschnitt, der das Modell exakt im Papier-Massstab 1:N abbildet (Inverse
 * von {@link scaleFromView}). Setzt die viewBox auf das Canvas-Seitenverhältnis
 * (kein Letterbox → horizontale wie vertikale Skala = Zielskala) und hält die
 * Bildmitte des bisherigen Ausschnitts. Ohne Messung null (kein Sprung blind).
 */
export function viewForScale(
  n: number,
  prev: ViewBox,
  el: SVGSVGElement | null,
): ViewBox | null {
  const rect = el?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0 || !(n > 0)) return null;
  // Ziel-meet-Skala aus N, dann viewBox = Canvas-px / Skala (beide Achsen).
  const targetScale = (1000 * dpi()) / (n * PX_PER_M * 25.4);
  const w = rect.width / targetScale;
  const h = rect.height / targetScale;
  const cx = prev.x + prev.w / 2;
  const cy = prev.y + prev.h / 2;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/**
 * Ziel-Ausschnitt, der eine bestimmte MODELL-Bildmitte bei einem bestimmten
 * Zoom (`targetPxPerMeter`, Bildschirm-px je Meter) zeigt — die Kamera-Hälfte
 * von {@link viewForScale} (das hält die BISHERIGE Mitte, hier wird eine
 * NEUE gesetzt). Setzt die viewBox auf das Canvas-Seitenverhältnis (kein
 * Letterbox). Für „gespeicherter Ausschnitt merkt sich auch WOHIN man
 * schaut" (`ViewSnapshot.cameraCenter`/`cameraPxPerMeter`). Ohne Messung
 * `null` (kein Sprung blind).
 */
export function viewForCamera(
  centerModel: Vec2,
  targetPxPerMeter: number,
  el: SVGSVGElement | null,
): ViewBox | null {
  const rect = el?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0 || !(targetPxPerMeter > 0)) return null;
  const targetMeetScale = targetPxPerMeter / PX_PER_M;
  const w = rect.width / targetMeetScale;
  const h = rect.height / targetMeetScale;
  const c = toScreen(centerModel);
  return { x: c.x - w / 2, y: c.y - h / 2, w, h };
}

/**
 * Einpass-Ausschnitt für ein Polygon (in Modell-Metern): dessen Bounding-Box
 * → viewBox-Einheiten (über toScreen) mit etwas Rand. Für „auf Auswahl einpassen".
 */
export function fitBoxFor(pts: Vec2[], toScreenFn: (v: Vec2) => Vec2): ViewBox {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of pts) {
    const s = toScreenFn(p);
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x);
    maxY = Math.max(maxY, s.y);
  }
  const w = maxX - minX;
  const h = maxY - minY;
  const margin = Math.max(w, h) * 0.25 + PAD; // etwas Luft um die Auswahl
  return {
    x: minX - margin,
    y: minY - margin,
    w: w + margin * 2,
    h: h + margin * 2,
  };
}

/** Wert auf [lo, hi] begrenzen. */
export function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

/**
 * Punkt-in-Polygon (Ray-Casting, gerade Kreuzungszahl). Arbeitet in beliebigen
 * 2D-Koordinaten — hier in Modell-Metern, damit die Trefferprüfung unabhängig
 * vom Zoom ist. Rand zählt nicht garantiert; für die Wand-Auswahl ausreichend.
 */
export function pointInPolygon(pt: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > pt.y !== yj > pt.y &&
      pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** Abstand Punkt→Strecke (alle in denselben Koordinaten, hier Client-Pixel). */
export function pointSegDistPx(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 1e-9) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

/** Achsenparalleles Rechteck in Modell-Metern (Auswahl-Marquee). */
export interface ModelRect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/**
 * Bestimmt die vom Auswahl-Rechteck getroffenen Wand-IDs nach CAD-Konvention:
 *   • crossing = false (links→rechts): nur Wände, deren Polygone VOLLSTÄNDIG im
 *     Rechteck liegen (jeder Eckpunkt enthalten).
 *   • crossing = true  (rechts→links): zusätzlich Wände, die das Rechteck nur
 *     BERÜHREN/kreuzen (Überlappung der Polygone mit dem Rechteck).
 * Getestet wird je Wand über ALLE ihre Polygon-Bänder; ein Treffer eines Bandes
 * genügt. Liefert eindeutige IDs in Auftreten-Reihenfolge.
 */
export function marqueeHit(
  prims: Primitive[],
  rect: ModelRect,
  crossing: boolean,
): string[] {
  return marqueeHitByField(prims, "wallId", rect, crossing);
}

/**
 * Generische Variante von {@link marqueeHit} für ein beliebiges Polygon-ID-
 * Feld (`ceilingId`/`roomId`/`stairId`/`columnId`/`roofId`/…) — dieselbe
 * window/crossing-Konvention, nur auf ein anderes Element bezogen. Deckt
 * Nutzer-Report: „Auswahlrahmen kann Decken/Räume/Treppen nicht anwählen"
 * (bisher nur Wände über `marqueeHit`, alles andere fehlte komplett).
 */
function marqueeHitByField(
  prims: Primitive[],
  field: "wallId" | "ceilingId" | "roomId" | "stairId" | "columnId" | "roofId",
  rect: ModelRect,
  crossing: boolean,
): string[] {
  const byId = new Map<string, Vec2[][]>();
  for (const p of prims) {
    if (p.kind !== "polygon") continue;
    const id = p[field];
    if (id == null) continue;
    const list = byId.get(id);
    if (list) list.push(p.pts);
    else byId.set(id, [p.pts]);
  }
  const out: string[] = [];
  for (const [id, polys] of byId) {
    const hit = crossing
      ? polys.some((poly) => polyTouchesRect(poly, rect))
      : polys.every((poly) => polyEnclosedByRect(poly, rect));
    if (hit) out.push(id);
  }
  return out;
}

/** Vom Auswahl-Rechteck getroffene Decken-IDs (gleiche Konvention wie {@link marqueeHit}). */
export function marqueeHitCeilings(prims: Primitive[], rect: ModelRect, crossing: boolean): string[] {
  return marqueeHitByField(prims, "ceilingId", rect, crossing);
}

/** Vom Auswahl-Rechteck getroffene Raum-IDs (gleiche Konvention wie {@link marqueeHit}). */
export function marqueeHitRooms(prims: Primitive[], rect: ModelRect, crossing: boolean): string[] {
  return marqueeHitByField(prims, "roomId", rect, crossing);
}

/** Vom Auswahl-Rechteck getroffene Treppen-IDs (gleiche Konvention wie {@link marqueeHit}). */
export function marqueeHitStairs(prims: Primitive[], rect: ModelRect, crossing: boolean): string[] {
  return marqueeHitByField(prims, "stairId", rect, crossing);
}

/**
 * Vom Auswahl-Rechteck getroffene 2D-Zeichenelement-IDs (gleiche window/crossing-
 * Konvention wie {@link marqueeHit}). Sammelt je Drawing2D ALLE seine Punkte aus
 * den Linien-/Polygon-Primitiven; crossing = irgendein Punkt/Kante im Rechteck,
 * window = alle Punkte vollständig eingeschlossen.
 */
/** Punkte auf einem Kreis-/Bogen-Ring (Modell-Meter), für Marquee-Zwecke abgetastet. */
function ringSamplePoints(center: Vec2, r: number, a0?: number, a1?: number): Vec2[] {
  const TAU = Math.PI * 2;
  const full = a0 === undefined || a1 === undefined;
  const start = full ? 0 : a0;
  const sweep = full ? TAU : (((a1 - a0) % TAU) + TAU) % TAU || TAU;
  const steps = full ? 32 : Math.max(4, Math.round((sweep / TAU) * 32));
  const pts: Vec2[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = start + (sweep * i) / steps;
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) });
  }
  return pts;
}

/** Bounding-Box-Eckpunkte eines `drawingText`-Primitivs, analog zur Einzelklick-Bbox in PlanView.tsx. */
function drawingTextBboxPoints(p: Extract<Primitive, { kind: "drawingText" }>): Vec2[] {
  const singleW = Math.max(1, p.text.length) * p.heightM * 0.6;
  const w = p.wrapWidth && p.wrapWidth > 0 ? p.wrapWidth : singleW;
  const lines = p.wrapWidth && p.wrapWidth > 0 ? Math.max(1, Math.ceil(singleW / p.wrapWidth)) : 1;
  const pad = p.heightM * 0.6;
  const minX = p.at.x - pad;
  const maxX = p.at.x + w + pad;
  const minY = p.at.y - lines * p.heightM * 1.25 - pad;
  const maxY = p.at.y + p.heightM * 0.4 + pad;
  return [{ x: minX, y: minY }, { x: maxX, y: minY }, { x: maxX, y: maxY }, { x: minX, y: maxY }];
}

export function marqueeHitDrawings(
  prims: Primitive[],
  rect: ModelRect,
  crossing: boolean,
  /** Zeichnungen, die der Aufrufer selbst prüft (kompakte Unterlage) — hier überspringen. */
  skipIds?: ReadonlyMap<string, unknown>,
): string[] {
  const byDrawing = new Map<string, Vec2[]>();
  const collect = (id: string, pts: Vec2[]) => {
    const list = byDrawing.get(id);
    if (list) list.push(...pts);
    else byDrawing.set(id, [...pts]);
  };
  for (const p of prims) {
    if (skipIds && "drawingId" in p && p.drawingId && skipIds.has(p.drawingId)) continue;
    if (p.kind === "line" && p.drawingId) collect(p.drawingId, [p.a, p.b]);
    else if (p.kind === "polygon" && p.drawingId) collect(p.drawingId, p.pts);
    else if (p.kind === "drawingCircle" && p.drawingId) collect(p.drawingId, ringSamplePoints(p.center, p.r));
    else if (p.kind === "drawingArc" && p.drawingId) collect(p.drawingId, ringSamplePoints(p.center, p.r, p.a0, p.a1));
    else if (p.kind === "drawingText" && p.drawingId) collect(p.drawingId, drawingTextBboxPoints(p));
    else if (p.kind === "drawingImage" && p.drawingId) {
      collect(p.drawingId, [
        p.min,
        { x: p.max.x, y: p.min.y },
        p.max,
        { x: p.min.x, y: p.max.y },
      ]);
    }
  }
  const out: string[] = [];
  for (const [id, pts] of byDrawing) {
    const hit = crossing
      ? polyTouchesRect(pts, rect)
      : polyEnclosedByRect(pts, rect);
    if (hit) out.push(id);
  }
  return out;
}

/** Orientierung des Tripels (a,b,c): >0 CCW, <0 CW, 0 kollinear. */
function cross3(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Liegt p auf der Strecke a-b (bei bereits kollinearen Punkten)? */
function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    Math.min(a.x, b.x) <= p.x &&
    p.x <= Math.max(a.x, b.x) &&
    Math.min(a.y, b.y) <= p.y &&
    p.y <= Math.max(a.y, b.y)
  );
}

/** Schneiden sich die Strecken a-b und c-d (inkl. Berührung)? */
function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const d1 = cross3(c, d, a);
  const d2 = cross3(c, d, b);
  const d3 = cross3(a, b, c);
  const d4 = cross3(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    return true;
  }
  // Kollineare Berührung.
  if (d1 === 0 && onSegment(c, d, a)) return true;
  if (d2 === 0 && onSegment(c, d, b)) return true;
  if (d3 === 0 && onSegment(a, b, c)) return true;
  if (d4 === 0 && onSegment(a, b, d)) return true;
  return false;
}

/** Alle Eckpunkte des Polygons liegen im Rechteck (vollständig eingeschlossen). */
export function polyEnclosedByRect(poly: Vec2[], r: ModelRect): boolean {
  if (poly.length === 0) return false;
  return poly.every(
    (pt) =>
      pt.x >= r.minX && pt.x <= r.maxX && pt.y >= r.minY && pt.y <= r.maxY,
  );
}

/**
 * Polygon und Rechteck überlappen/berühren sich (crossing-Test). Wahr, wenn:
 *   • ein Polygon-Eckpunkt im Rechteck liegt, ODER
 *   • eine Rechteck-Ecke im Polygon liegt, ODER
 *   • eine Polygon-Kante eine Rechteck-Kante schneidet.
 * Deckt damit auch den Fall ab, dass das Rechteck ganz innerhalb der Wand liegt.
 */
export function polyTouchesRect(poly: Vec2[], r: ModelRect): boolean {
  // 1) Polygon-Punkt im Rechteck?
  for (const pt of poly) {
    if (pt.x >= r.minX && pt.x <= r.maxX && pt.y >= r.minY && pt.y <= r.maxY) {
      return true;
    }
  }
  // 2) Rechteck-Ecke im Polygon? (Rechteck ganz in der Wand.)
  const corners: Vec2[] = [
    { x: r.minX, y: r.minY },
    { x: r.maxX, y: r.minY },
    { x: r.maxX, y: r.maxY },
    { x: r.minX, y: r.maxY },
  ];
  for (const c of corners) {
    if (pointInPolygon(c, poly)) return true;
  }
  // 3) Kanten-Schnitt Polygon × Rechteck.
  const rectEdges: [Vec2, Vec2][] = [
    [corners[0], corners[1]],
    [corners[1], corners[2]],
    [corners[2], corners[3]],
    [corners[3], corners[0]],
  ];
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j];
    const b = poly[i];
    for (const [c, d] of rectEdges) {
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

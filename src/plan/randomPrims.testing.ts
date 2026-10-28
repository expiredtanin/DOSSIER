// Testhilfe ([K3d]): deterministische Zufalls-Primitive aller Arten für Gleichheitstests der
// Kern-Verbraucher (Render-Szene, Auswahl, SVG-Export) — Polygone mit allen Schraffur-Arten,
// unterdrückten Kanten, Farben in allen Schreibweisen, verkettete 2D-Zeichenlinien, Zickzack,
// Motiv, Strichmuster (fehlend/null/Liste), Bögen, Kreise, Texte, Bilder, gedimmt/deckend.

import type { HatchRender, Plan, Primitive } from "./generatePlan";
import type { Vec2 } from "../model/types";

export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLORS = ["#1a1a1a", "#fff", "#ff000080", "#abc", "#12345", "none", "", "black", "red", " White ", "rgb(1,2,3)", "#zz0000", "#336699", "transparent"];
const CLS = ["wall", "door-leaf", "door-swing", "wall-axis", "context-line", "draw2d", "window-glass", "stair-line"];
const PATTERNS: HatchRender["pattern"][] = ["diagonal", "crosshatch", "insulation", "custom", "solid", "none"];

export function randomPrims(seed: number, n: number, span = 20): Primitive[] {
  const r = rng(seed);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(r() * a.length)];
  const pt = (): Vec2 => ({ x: (r() - 0.5) * span, y: (r() - 0.5) * span });
  const dash = (): number[] | null | undefined => {
    const k = r();
    return k < 0.4 ? undefined : k < 0.6 ? null : k < 0.7 ? [] : [0.5 + r(), 0.2 + r(), ...(r() < 0.3 ? [0.1] : [])];
  };
  const greyed = (): boolean | undefined => (r() < 0.6 ? undefined : r() < 0.5);
  const hatch = (): HatchRender => {
    const h: HatchRender = {
      pattern: pick(PATTERNS),
      scale: r() < 0.1 ? 0 : 0.5 + r() * 2,
      angle: Math.floor(r() * 180),
      color: pick(COLORS),
      lineWeight: r() < 0.2 ? 0 : 0.05 + r() * 0.3,
      dash: r() < 0.6 ? null : [0.5 + r(), 0.3],
    };
    if (r() < 0.2) h.kind = pick(["vector", "image", "gradient"] as const);
    if (r() < 0.2) h.lines = "random";
    if (r() < 0.3) h.origin = pt();
    if (h.pattern === "custom") h.motif = { points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.3 }, { x: 1, y: 0 }], length: 1 };
    return h;
  };
  const ring = (): Vec2[] => {
    const c = pt();
    const k = 3 + Math.floor(r() * 5);
    const rad = 0.3 + r() * 3;
    const out: Vec2[] = [];
    for (let i = 0; i < k; i++) {
      const a = (i / k) * Math.PI * 2;
      out.push({ x: c.x + Math.cos(a) * rad * (0.6 + r() * 0.4), y: c.y + Math.sin(a) * rad * (0.6 + r() * 0.4) });
    }
    return out;
  };
  const out: Primitive[] = [];
  const ids = ["d1", "d2", "d3", ""];
  let last: Vec2 | null = null;
  while (out.length < n) {
    const k = r();
    if (k < 0.25) {
      const pts = ring();
      const p: Primitive = {
        kind: "polygon",
        pts: r() < 0.05 ? pts.slice(0, 2) : pts,
        fill: pick(COLORS),
        stroke: pick(COLORS),
        strokeWidthMm: r() < 0.1 ? 0 : 0.1 + r() * 0.5,
        hatch: hatch(),
      };
      if (r() < 0.4) delete (p as { hatch?: HatchRender }).hatch;
      const g = greyed();
      if (g !== undefined) p.greyed = g;
      if (r() < 0.2) p.opacity = r();
      if (r() < 0.4) p.noStrokeEdges = Array.from({ length: Math.floor(r() * pts.length) }, () => Math.floor(r() * pts.length * 2) - 1);
      if (r() < 0.3) p.wallId = `w${Math.floor(r() * 5)}`;
      else if (r() < 0.3) p.roomId = `r${Math.floor(r() * 5)}`;
      else if (r() < 0.2) p.drawingId = pick(ids);
      if (r() < 0.1) p.stairId = "s1";
      out.push(p);
    } else if (k < 0.7) {
      // Linien, oft als Zug (Ende = nächster Anfang).
      const a: Vec2 = last && r() < 0.6 ? { ...last } : pt();
      const b: Vec2 = { x: a.x + (r() - 0.5) * 3, y: a.y + (r() - 0.5) * 3 };
      const p: Primitive = { kind: "line", a, b, cls: pick(CLS), weightMm: r() < 0.5 ? 0.25 : 0.18 };
      const d = dash();
      if (d !== undefined) p.dash = d;
      if (r() < 0.5) p.color = pick(COLORS);
      if (r() < 0.6) p.drawingId = pick(ids);
      else if (r() < 0.3) p.openingId = "o1";
      if (r() < 0.05) p.zigzag = { amplitude: 0.5 + r(), wavelength: 2 + r() * 3 };
      else if (r() < 0.05) p.motif = { points: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 0 }], length: 1 + r() };
      const g = greyed();
      if (g !== undefined) p.greyed = g;
      out.push(p);
      last = b;
    } else if (k < 0.78) {
      const c = pt();
      const rad = 0.5 + r();
      const a0 = r() * 6;
      const a1 = a0 + r() * 3;
      const p: Primitive = {
        kind: "arc",
        center: c,
        from: { x: c.x + rad * Math.cos(a0), y: c.y + rad * Math.sin(a0) },
        to: { x: c.x + rad * Math.cos(a1), y: c.y + rad * Math.sin(a1) },
        r: rad,
        cls: pick(CLS),
        weightMm: 0.18,
      };
      const d = dash();
      if (d !== undefined) p.dash = d;
      if (r() < 0.5) p.openingId = "o2";
      const g = greyed();
      if (g !== undefined) p.greyed = g;
      out.push(p);
    } else if (k < 0.86) {
      const circle = r() < 0.5;
      const c = pt();
      const g = greyed();
      const d = dash();
      if (circle) {
        const p: Primitive = { kind: "drawingCircle", center: c, r: 0.2 + r() * 2, fill: pick(COLORS), stroke: pick(COLORS), weightMm: 0.25 };
        if (d !== undefined) p.dash = d;
        if (g !== undefined) p.greyed = g;
        if (r() < 0.7) p.drawingId = pick(ids);
        out.push(p);
      } else {
        const p: Primitive = { kind: "drawingArc", center: c, r: 0.2 + r() * 2, a0: (r() - 0.5) * 10, a1: (r() - 0.5) * 10, stroke: pick(COLORS), weightMm: 0.25 };
        if (d !== undefined) p.dash = d;
        if (g !== undefined) p.greyed = g;
        if (r() < 0.7) p.drawingId = pick(ids);
        out.push(p);
      }
    } else if (k < 0.92) {
      const g = greyed();
      if (r() < 0.5) {
        const p = {
          kind: "text",
          at: pt(),
          doc: { version: 1, paragraphs: [{ align: "center", runs: [{ text: `Raum ${out.length}`, marks: {} }] }] },
          extraLines: r() < 0.5 ? [{ text: "12.5 m²", align: "center" }] : [],
          basePt: 8 + Math.floor(r() * 6),
          color: pick(COLORS),
          roomId: "r1",
        } as unknown as Primitive;
        if (g !== undefined) (p as { greyed?: boolean }).greyed = g;
        out.push(p);
      } else {
        const p: Primitive = { kind: "drawingText", at: pt(), text: `T ${out.length}\nzwei`, heightM: 0.2 + r(), angle: r() < 0.5 ? 0 : r(), color: pick(COLORS), drawingId: pick(ids) };
        if (r() < 0.3) p.wrapWidth = 1 + r() * 2;
        if (g !== undefined) p.greyed = g;
        out.push(p);
      }
    } else if (k < 0.95) {
      const a = pt();
      out.push({ kind: "drawingImage", min: a, max: { x: a.x + 1, y: a.y + 1 }, src: "data:image/png;base64,AA", opacity: r(), drawingId: pick(ids) });
    } else if (k < 0.97) {
      out.push({ kind: "drawingTextPath", pathPts: [pt(), pt()], text: "Pfad", heightM: 0.3, color: "#000", drawingId: "d1" });
    } else {
      // Exakte Wiederholung des letzten Polygons mit unterdrückten Kanten (Naht über Grenzen).
      const sq: Vec2[] = [pt()];
      sq.push({ x: sq[0].x + 1, y: sq[0].y }, { x: sq[0].x + 1, y: sq[0].y + 1 }, { x: sq[0].x, y: sq[0].y + 1 });
      const sq2 = [sq[1], { x: sq[1].x + 1, y: sq[1].y }, { x: sq[1].x + 1, y: sq[2].y }, sq[2]];
      out.push({ kind: "polygon", pts: sq, fill: "#eee", stroke: "#000", strokeWidthMm: 0.35, noStrokeEdges: [1], wallId: "wx" } as Primitive);
      out.push({ kind: "polygon", pts: sq2, fill: "#eee", stroke: "#000", strokeWidthMm: 0.35, noStrokeEdges: [3], wallId: "wy" } as Primitive);
    }
  }
  return out;
}

export function planOf(primitives: Primitive[], greyedRanges?: Array<[number, number]>): Plan {
  return { primitives, bounds: { minX: -10, minY: -10, maxX: 10, maxY: 10 }, ...(greyedRanges ? { greyedRanges } : {}) };
}

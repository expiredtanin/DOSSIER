// Plan → SVG-TEXT ohne DOM (für `dossier-cli` und Referenzbild-Tests, lessons-bimcraft [4]/[17]).
// Der Druck-Export (`planToPrintSvg`) baut ein DOM-Element für svg2pdf; dieser Serializer ist
// die schlanke, headless Variante: Koordinaten in Metern (Y nach oben → SVG gespiegelt),
// Strichstärken aus Papier-mm über den Massstab umgerechnet. Schraffur-Muster werden nicht
// ausgebreitet (nur Grundfüllung), Bilder fehlen — gedacht für Kontrolle und Diffs, nicht für Druck.

import type { Plan, Primitive } from "../plan/generatePlan";
import { plainText } from "../text/richText";

export interface SvgStringOptions {
  /** Massstab-Nenner N (1:N) — bestimmt die Umrechnung Papier-mm → Meter. Default 100. */
  scaleDenominator?: number;
  /** Rand um den Planinhalt in Metern. Default 0.5. */
  marginM?: number;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: number): string => (Number.isFinite(v) ? String(Math.round(v * 1e5) / 1e5) : "0");

export function planToSvgString(plan: Plan, opts: SvgStringOptions = {}): string {
  const n = opts.scaleDenominator ?? 100;
  const margin = opts.marginM ?? 0.5;
  const mmToM = n / 1000; // 1 mm Papier = n/1000 m Modell
  const b = plan.bounds;
  const x0 = b.minX - margin;
  const w = b.maxX - b.minX + 2 * margin;
  const h = b.maxY - b.minY + 2 * margin;
  // Y spiegeln: svgY = (maxY + margin) − y
  const top = b.maxY + margin;
  const X = (x: number): string => num(x);
  const Y = (y: number): string => num(top - y);
  const dashAttr = (d: number[] | null | undefined): string =>
    d && d.length ? ` stroke-dasharray="${d.map((v) => num(v * mmToM)).join(" ")}"` : "";
  const op = (p: { opacity?: number; greyed?: boolean }): string =>
    p.greyed ? ' opacity="0.35"' : p.opacity !== undefined && p.opacity < 1 ? ` opacity="${num(p.opacity)}"` : "";

  const out: string[] = [];
  for (const p of plan.primitives as Primitive[]) {
    switch (p.kind) {
      case "polygon": {
        if (p.pts.length < 3) break;
        const pts = p.pts.map((q) => `${X(q.x)},${Y(q.y)}`).join(" ");
        out.push(
          `<polygon points="${pts}" fill="${esc(p.fill)}" stroke="${esc(p.stroke)}" stroke-width="${num(p.strokeWidthMm * mmToM)}" stroke-linejoin="round"${op(p)}/>`,
        );
        break;
      }
      case "line":
        out.push(
          `<line x1="${X(p.a.x)}" y1="${Y(p.a.y)}" x2="${X(p.b.x)}" y2="${Y(p.b.y)}" stroke="${esc(p.color ?? "#000")}" stroke-width="${num(p.weightMm * mmToM)}"${dashAttr(p.dash)}${op(p)}/>`,
        );
        break;
      case "arc": {
        // Bogen von `from` nach `to` um `center`, gegen den Uhrzeigersinn im Modell.
        const a0 = Math.atan2(p.from.y - p.center.y, p.from.x - p.center.x);
        let sweep = Math.atan2(p.to.y - p.center.y, p.to.x - p.center.x) - a0;
        while (sweep < 0) sweep += Math.PI * 2;
        out.push(
          `<path d="M ${X(p.from.x)} ${Y(p.from.y)} A ${num(p.r)} ${num(p.r)} 0 ${sweep > Math.PI ? 1 : 0} 0 ${X(p.to.x)} ${Y(p.to.y)}" fill="none" stroke="#000" stroke-width="${num(p.weightMm * mmToM)}"${dashAttr(p.dash)}${op(p)}/>`,
        );
        break;
      }
      case "drawingCircle":
        out.push(
          `<circle cx="${X(p.center.x)}" cy="${Y(p.center.y)}" r="${num(p.r)}" fill="${esc(p.fill)}" stroke="${esc(p.stroke)}" stroke-width="${num(p.weightMm * mmToM)}"${dashAttr(p.dash)}${op(p)}/>`,
        );
        break;
      case "drawingArc": {
        const sx = p.center.x + p.r * Math.cos(p.a0);
        const sy = p.center.y + p.r * Math.sin(p.a0);
        const ex = p.center.x + p.r * Math.cos(p.a1);
        const ey = p.center.y + p.r * Math.sin(p.a1);
        let sweep = p.a1 - p.a0;
        while (sweep < 0) sweep += Math.PI * 2;
        out.push(
          `<path d="M ${X(sx)} ${Y(sy)} A ${num(p.r)} ${num(p.r)} 0 ${sweep > Math.PI ? 1 : 0} 0 ${X(ex)} ${Y(ey)}" fill="none" stroke="${esc(p.stroke)}" stroke-width="${num(p.weightMm * mmToM)}"${dashAttr(p.dash)}${op(p)}/>`,
        );
        break;
      }
      case "drawingText":
        out.push(
          `<text x="${X(p.at.x)}" y="${Y(p.at.y)}" font-size="${num(p.heightM)}" fill="${esc(p.color)}" font-family="sans-serif" transform="rotate(${num(-(p.angle * 180) / Math.PI)} ${X(p.at.x)} ${Y(p.at.y)})"${op(p)}>${esc(p.text)}</text>`,
        );
        break;
      case "text": {
        const size = (p.basePt * 0.3528) * mmToM; // pt → mm Papier → m Modell
        const lines = [plainText(p.doc), ...p.extraLines.map((l) => l.text)].filter((s) => s);
        lines.forEach((ln, i) =>
          out.push(
            `<text x="${X(p.at.x)}" y="${num(top - p.at.y + i * size * 1.2)}" font-size="${num(size)}" fill="${esc(p.color)}" font-family="sans-serif" text-anchor="middle"${op(p)}>${esc(ln)}</text>`,
          ),
        );
        break;
      }
      default:
        break; // Bilder, Textpfade: im headless SVG nicht dargestellt
    }
  }
  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(x0)} 0 ${num(w)} ${num(h)}" width="${num(w * 1000 / n)}mm" height="${num(h * 1000 / n)}mm">\n` +
    `<rect x="${num(x0)}" y="0" width="${num(w)}" height="${num(h)}" fill="#ffffff"/>\n` +
    out.join("\n") +
    `\n</svg>\n`
  );
}

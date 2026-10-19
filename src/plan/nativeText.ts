/**
 * Texte für die NATIVE 2D-Engine (Vektor-Text in Rust, src-tauri/render2d/src/vtext.rs).
 *
 * Einfache, einzeilige `drawingText`-Primitive (auch gedrehte) zeichnet die native
 * Fläche; alles Reichere (Textfelder mit `doc`, Spaltenumbruch, Mehrzeiler) bleibt
 * im SVG-Overlay. Die Webview schickt nur DELTAS: je Text eine Signatur, nur neue
 * oder geänderte Texte gehen über die Schnittstelle.
 */

import type { Primitive } from './generatePlan';

type DrawingText = Extract<Primitive, { kind: 'drawingText' }>;

/** Zeichnet die native Fläche diesen Text (statt des SVG-Overlays)? */
export function isGpuText(p: Primitive): p is DrawingText {
  return (
    p.kind === 'drawingText' &&
    !!p.drawingId &&
    !p.doc &&
    !p.wrapWidth &&
    p.text.length > 0 &&
    !p.text.includes('\n')
  );
}

/** CSS-Farbe (#rgb, #rrggbb, rgb()/rgba()) → [r,g,b,a] in 0..1; sonst Schwarz. */
export function cssColorToRgba(css: string, alpha = 1): [number, number, number, number] {
  const s = css.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) {
    const h = m[1];
    return [parseInt(h[0] + h[0], 16) / 255, parseInt(h[1] + h[1], 16) / 255, parseInt(h[2] + h[2], 16) / 255, alpha];
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    const a = m[2] ? parseInt(m[2], 16) / 255 : 1;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, alpha * a];
  }
  m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (m) {
    const a = m[4] ? (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])) : 1;
    return [parseFloat(m[1]) / 255, parseFloat(m[2]) / 255, parseFloat(m[3]) / 255, alpha * a];
  }
  return [0, 0, 0, alpha];
}

/** Bildschirm-Einheiten je Meter (== PX_PER_M in PlanView/toScreen). */
const PX_PER_M = 90;

export interface NativeTextEntry {
  id: number;
  x: number;
  y: number;
  size: number;
  angle: number;
  color: [number, number, number, number];
  text: string;
}

interface Known {
  id: number;
  sig: string;
}

/** Verwaltet die IDs/Signaturen der bereits an Rust geschickten Texte. */
export class NativeTextSync {
  private known = new Map<string, Known>();
  private nextId = 1;
  private sigCache = new WeakMap<Primitive, string>();

  /** Rust hat alles vergessen (z. B. neue Fläche): beim nächsten Delta alles neu senden. */
  reset(): void {
    this.known.clear();
  }

  /**
   * Delta gegenüber dem zuletzt gesendeten Stand. `excludeDrawingId`: Text, der
   * gerade im Editor liegt (wird nicht nativ gezeichnet).
   */
  delta(prims: readonly Primitive[], excludeDrawingId?: string | null): { upsert: NativeTextEntry[]; remove: number[] } {
    const upsert: NativeTextEntry[] = [];
    const seen = new Set<string>();
    for (const p of prims) {
      if (!isGpuText(p)) continue;
      const key = p.drawingId!;
      if (key === excludeDrawingId) continue;
      seen.add(key);
      let sig = this.sigCache.get(p);
      if (sig === undefined) {
        sig = `${p.at.x}|${p.at.y}|${p.heightM}|${p.angle}|${p.color}|${p.greyed ? 1 : 0}|${p.text}`;
        this.sigCache.set(p, sig);
      }
      const k = this.known.get(key);
      if (k && k.sig === sig) continue;
      const id = k?.id ?? this.nextId++;
      this.known.set(key, { id, sig });
      upsert.push({
        id,
        x: p.at.x * PX_PER_M,
        y: -p.at.y * PX_PER_M,
        size: p.heightM * PX_PER_M,
        angle: -p.angle,
        color: cssColorToRgba(p.color, p.greyed ? 0.45 : 1),
        text: p.text,
      });
    }
    const remove: number[] = [];
    for (const [key, k] of this.known) {
      if (!seen.has(key)) {
        remove.push(k.id);
        this.known.delete(key);
      }
    }
    return { upsert, remove };
  }
}

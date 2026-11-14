// Ziehen aus einer Palette in den Plan ([253]): die Plan-Ansicht meldet sich als Ablageziel an, die Palette
// (Zeigerdruck auf ein Objekt) füttert Bildschirmpunkte hinein. Kein HTML5-Drag&Drop: Zeiger-Capture am
// Paletten-Element, Koordinaten über die bestehende Bildschirm→Modell-Umrechnung der Plan-Ansicht — so
// funktioniert es auch mit nativer Renderfläche (die Ereignisse liegen immer auf dem SVG-Overlay).
// Der Befehl (z. B. `libobj`) läuft schon seit dem Zeigerdruck; Vorschau und Einfügepunkt sind ein normales
// Move/Click der Befehls-Engine, Fang und R/M gelten wie dort.

import type { Vec2 } from "../model/types";
import type { ToolMods } from "../tools/types";

export interface PlanDropTarget {
  /** Liegt der Bildschirmpunkt auf der Zeichenfläche (und nicht auf Panel/Menü darüber)? */
  hit(clientX: number, clientY: number): boolean;
  /** Roher Modellpunkt (Meter) unter dem Bildschirmpunkt. */
  modelAt(clientX: number, clientY: number): Vec2;
  pxPerMeter(): number;
  /** Vorschau nachführen (wie Zeiger-Hover im Befehl). */
  move(model: Vec2, mods: ToolMods): void;
  /** Loslassen: Punkt setzen (wie Klick im Befehl). */
  drop(model: Vec2, mods: ToolMods): void;
  /** Befehl abbrechen. */
  cancel(): void;
}

const targets: PlanDropTarget[] = [];

/** Meldet ein Ablageziel an (die jüngste Anmeldung gilt); der Rückgabewert meldet genau dieses ab. */
export function registerPlanDropTarget(t: PlanDropTarget): () => void {
  targets.push(t);
  return () => {
    const i = targets.lastIndexOf(t);
    if (i >= 0) targets.splice(i, 1);
  };
}

export function currentPlanDropTarget(): PlanDropTarget | null {
  return targets.length ? targets[targets.length - 1] : null;
}

/** Ab dieser Bildschirmdistanz (px) gilt Zeigerdruck + Bewegen als Ziehen, nicht als Klick. */
export const DRAG_THRESHOLD_PX = 5;

export type PaletteDragEnd = "click" | "dropped" | "cancelled" | "idle";

/** Zustandsautomat eines Ziehvorgangs: idle → armed (Druck) → dragging (Schwelle überschritten). */
export function createPaletteDrag(target: () => PlanDropTarget | null) {
  let phase: "idle" | "armed" | "dragging" = "idle";
  let sx = 0;
  let sy = 0;
  return {
    dragging: () => phase === "dragging",
    active: () => phase !== "idle",
    down(x: number, y: number): void {
      phase = "armed";
      sx = x;
      sy = y;
    },
    move(x: number, y: number, mods: ToolMods): void {
      if (phase === "idle") return;
      if (phase === "armed") {
        if (Math.hypot(x - sx, y - sy) < DRAG_THRESHOLD_PX) return;
        phase = "dragging";
      }
      const t = target();
      if (t && t.hit(x, y)) t.move(t.modelAt(x, y), mods);
    },
    up(x: number, y: number, mods: ToolMods): PaletteDragEnd {
      const was = phase;
      phase = "idle";
      if (was === "idle") return "idle";
      if (was === "armed") return "click";
      const t = target();
      if (t && t.hit(x, y)) {
        t.drop(t.modelAt(x, y), mods);
        return "dropped";
      }
      t?.cancel();
      return "cancelled";
    },
    /** Esc / Zeiger-Abbruch: ein laufendes Ziehen bricht den Befehl ab; ohne Ziehen bleibt er dem Befehlsfeld. */
    abort(): void {
      const was = phase;
      phase = "idle";
      if (was === "dragging") target()?.cancel();
    },
  };
}

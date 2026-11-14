// Plan-Ansicht als Ablageziel für das Ziehen aus Paletten ([253], `state/planDropTarget.ts`): meldet sich an,
// solange Werkzeug-Eingabe aktiv ist. Rechnet Bildschirmpunkte über die vorhandene Umrechnung (`rawModelAt`)
// und reicht Bewegen/Loslassen an dieselben `toolHandlers` wie ein Zeiger auf dem SVG-Overlay.

import { useEffect, useRef } from "react";
import type { Vec2 } from "../../../model/types";
import type { ToolHandlers, ToolMods } from "../../../tools/types";
import { registerPlanDropTarget } from "../../../state/planDropTarget";

export function usePlanDropTarget(inp: {
  enabled: boolean;
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
  toolHandlers: ToolHandlers | undefined;
  rawModelAt: (clientX: number, clientY: number) => Vec2;
  currentPxPerMeter: () => number;
}): void {
  // Frischer Spiegel: Funktionen und Handler ändern sich je Render, die Anmeldung bleibt stabil.
  const latest = useRef(inp);
  latest.current = inp;
  const enabled = inp.enabled && !!inp.toolHandlers;
  useEffect(() => {
    if (!enabled) return;
    return registerPlanDropTarget({
      hit: (x, y) => {
        const root = latest.current.svgRef.current?.parentElement;
        const el = document.elementFromPoint(x, y);
        return !!root && !!el && root.contains(el);
      },
      modelAt: (x, y) => latest.current.rawModelAt(x, y),
      pxPerMeter: () => latest.current.currentPxPerMeter(),
      move: (m: Vec2, mods: ToolMods) => latest.current.toolHandlers?.onToolMove(m, latest.current.currentPxPerMeter(), mods),
      drop: (m: Vec2, mods: ToolMods) => latest.current.toolHandlers?.onToolClick(m, latest.current.currentPxPerMeter(), mods),
      cancel: () => latest.current.toolHandlers?.onToolCommit(),
    });
  }, [enabled]);
}

// Panel-Tab-Drag — die Steuerung für „Tab greifen → Reorder / Andocken / Lösen".
//
// Eine Geste beginnt am TAB selbst (pointerdown). Unter dem Schwellwert (~5 px)
// gilt sie als Klick (Tab aktivieren); darüber wird sie zum Ziehen. Während des
// Ziehens folgt ein kleines Geist-Etikett dem Cursor, und gültige Ablageziele
// werden hervorgehoben:
//   • über einer Tab-Leiste (links/rechts) → REORDER bzw. Verschieben an den
//     ermittelten Einfügeindex (Caret zwischen den Tabs);
//   • über einer Rand-Andock-Zone (links/rechts) → in dieses Dock andocken;
//   • sonst über der Arbeitsfläche → an der Cursorposition LÖSEN (schweben).
//
// Die Auflösung läuft rein über DOM-Datenattribute, die TabStrip/Dock setzen:
//   data-tabstrip="<dock>" + data-group-index  an der Tab-Leiste einer Gruppe,
//   data-tab-index="<i>"                        an jedem Tab-Knopf,
//   data-group-body + data-dock + data-group-index  am Körper einer Gruppe,
//   data-drop-zone="<dock>"                     an den Rand-Andock-Zonen.
// So braucht der Drag-Controller keine Refs der einzelnen Tabs und bleibt vom
// konkreten Layout entkoppelt.
//
// Ablage-Semantik:
//   • über einer Tab-Leiste  → in DIESE Gruppe einreihen (Stapel zusammenlegen),
//   • über einem Gruppen-Körper (obere/untere Hälfte) → NEUE Gruppe darüber/-unter,
//   • über einer Rand-Zone   → neue Gruppe ans Ende des Docks,
//   • sonst                  → lösen (schweben).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useCallback, useRef, useState } from "react";
import type { DockId } from "./types";
import { getPanel } from "./registry";
import { t } from "../i18n";

/** Pixel-Schwelle, ab der ein pointerdown auf einem Tab zum Ziehen wird. */
const DRAG_THRESHOLD = 5;
/** Standardgröße eines neu gelösten (schwebenden) Panels in CSS-Pixeln. */
export const DEFAULT_FLOAT_W = 300;
export const DEFAULT_FLOAT_H = 360;

/** Laufender Drag-Zustand (für Geist + Hervorhebung). */
interface DragState {
  panelId: string;
  /** Aktuelle Cursorposition (Geist folgt). */
  x: number;
  y: number;
  /** Aktuell überfahrenes Ziel (für Hervorhebung). */
  hover: HoverTarget;
}

/** Was gerade überfahren wird (für Caret/Zonen-Hervorhebung). */
type HoverTarget =
  | {
      kind: "tabstrip";
      dock: DockId;
      group: number;
      index: number;
      caretX: number;
      stripTop: number;
      stripHeight: number;
    }
  | {
      kind: "split";
      dock: DockId;
      /** Einfügeposition der neuen Gruppe (0..groups.length). */
      at: number;
      /** Y-Position der horizontalen Caret-Linie + horizontale Ausdehnung. */
      lineY: number;
      lineLeft: number;
      lineWidth: number;
    }
  | { kind: "zone"; dock: DockId }
  | { kind: "none" };

/** Was App zum Abschluss einer Drag-Geste umsetzt. */
export interface PanelDragCallbacks {
  /** Tab unter Schwelle losgelassen → als Klick: Tab aktivieren. */
  onActivate: (panelId: string) => void;
  /** Über einer Tab-Leiste losgelassen → in diese Gruppe einreihen (am Index). */
  onJoinGroup: (panelId: string, dock: DockId, group: number, index?: number) => void;
  /** Über einem Gruppen-Körper / einer Rand-Zone → neue Gruppe an `at`. */
  onNewGroup: (panelId: string, dock: DockId, at: number) => void;
  /** Über der Arbeitsfläche losgelassen → an Position lösen (schweben). */
  onDropFloat: (panelId: string, x: number, y: number) => void;
}

/**
 * Ermittelt das überfahrene Ziel an (clientX, clientY): zuerst eine Tab-Leiste
 * (einreihen), dann ein Gruppen-Körper (neue Gruppe ober-/unterhalb), dann eine
 * Rand-Andock-Zone, sonst nichts (= später lösen). Liest die Datenattribute der
 * unter dem Cursor liegenden Elemente.
 */
function resolveHover(clientX: number, clientY: number): HoverTarget {
  const stack = document.elementsFromPoint(clientX, clientY);

  // 1) Tab-Leiste? Einfügeindex aus den Tab-Mittelpunkten bestimmen.
  const strip = stack.find((el) =>
    (el as HTMLElement).dataset?.tabstrip !== undefined,
  ) as HTMLElement | undefined;
  if (strip) {
    const dock = strip.dataset.tabstrip as DockId;
    const group = Number(strip.dataset.groupIndex ?? 0);
    const tabs = Array.from(
      strip.querySelectorAll<HTMLElement>("[data-tab-index]"),
    );
    const stripRect = strip.getBoundingClientRect();
    let index = tabs.length;
    let caretX = stripRect.left + 4;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      const mid = r.left + r.width / 2;
      if (clientX < mid) {
        index = i;
        caretX = r.left - 2;
        break;
      }
      caretX = r.right + 2;
    }
    return {
      kind: "tabstrip",
      dock,
      group,
      index,
      caretX,
      stripTop: stripRect.top,
      stripHeight: stripRect.height,
    };
  }

  // 2) Gruppen-Körper? Obere Hälfte → neue Gruppe DARÜBER (at = gi), untere
  //    Hälfte → DARUNTER (at = gi + 1). Caret-Linie an der jeweiligen Kante.
  const body = stack.find((el) =>
    (el as HTMLElement).dataset?.groupBody !== undefined,
  ) as HTMLElement | undefined;
  if (body) {
    const dock = body.dataset.dock as DockId;
    const gi = Number(body.dataset.groupIndex ?? 0);
    const r = body.getBoundingClientRect();
    const below = clientY > r.top + r.height / 2;
    return {
      kind: "split",
      dock,
      at: below ? gi + 1 : gi,
      lineY: below ? r.bottom : r.top,
      lineLeft: r.left,
      lineWidth: r.width,
    };
  }

  // 3) Rand-Andock-Zone?
  const zone = stack.find((el) =>
    (el as HTMLElement).dataset?.dropZone !== undefined,
  ) as HTMLElement | undefined;
  if (zone) {
    return { kind: "zone", dock: zone.dataset.dropZone as DockId };
  }

  // 4) Sonst: lösen (schweben).
  return { kind: "none" };
}

/**
 * Drag-Controller. Liefert:
 *   • startTabDrag — pointerdown-Handler, den TabStrip an jeden Tab hängt;
 *   • drag         — der laufende Zustand (null = nichts) für das Overlay;
 *   • dropDockHint — der aktuell hervorzuhebende Dock (für Zonen/Strip), oder null.
 */
export function usePanelDrag(cb: PanelDragCallbacks) {
  const [drag, setDrag] = useState<DragState | null>(null);
  // Mutable Mitschrift der Geste (Listener lesen daraus, ohne Re-Renders).
  const ref = useRef<{
    panelId: string;
    startX: number;
    startY: number;
    active: boolean;
    hover: HoverTarget;
  } | null>(null);

  const startTabDrag = useCallback(
    (panelId: string, e: React.PointerEvent) => {
      // Nur primäre Taste / Touch.
      if (e.button !== 0 && e.pointerType === "mouse") return;
      const startX = e.clientX;
      const startY = e.clientY;
      ref.current = { panelId, startX, startY, active: false, hover: { kind: "none" } };

      const move = (ev: PointerEvent) => {
        const s = ref.current;
        if (!s) return;
        if (!s.active) {
          const moved =
            Math.abs(ev.clientX - s.startX) + Math.abs(ev.clientY - s.startY);
          if (moved < DRAG_THRESHOLD) return;
          s.active = true; // Schwelle überschritten → echtes Ziehen.
        }
        const hover = resolveHover(ev.clientX, ev.clientY);
        s.hover = hover;
        setDrag({ panelId: s.panelId, x: ev.clientX, y: ev.clientY, hover });
      };

      const up = (ev: PointerEvent) => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        const s = ref.current;
        ref.current = null;
        setDrag(null);
        if (!s) return;
        if (!s.active) {
          // Unter der Schwelle: als Klick werten (Tab aktivieren).
          cb.onActivate(s.panelId);
          return;
        }
        const hover = resolveHover(ev.clientX, ev.clientY);
        if (hover.kind === "tabstrip") {
          cb.onJoinGroup(s.panelId, hover.dock, hover.group, hover.index);
        } else if (hover.kind === "split") {
          cb.onNewGroup(s.panelId, hover.dock, hover.at);
        } else if (hover.kind === "zone") {
          // Rand-Zone → neue Gruppe ans Ende (at sehr groß, Helfer klemmt).
          cb.onNewGroup(s.panelId, hover.dock, Number.MAX_SAFE_INTEGER);
        } else {
          // Lösen: Geist mittig über dem Cursor platzieren.
          cb.onDropFloat(
            s.panelId,
            Math.round(ev.clientX - DEFAULT_FLOAT_W / 2),
            Math.round(ev.clientY - 12),
          );
        }
      };

      const cancel = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        window.removeEventListener("pointercancel", cancel);
        ref.current = null;
        setDrag(null);
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    },
    [cb],
  );

  return { drag, startTabDrag };
}

/**
 * Drag-Overlay: rendert während eines aktiven Tab-Ziehens den Geist am Cursor
 * und das Einfüge-Caret in der überfahrenen Tab-Leiste. Die Rand-Andock-Zonen
 * selbst rendert der Host (App), damit sie auch beim Verschieben eines
 * schwebenden Fensters dieselben Trefferflächen bilden. Liegt über allem;
 * reagiert nicht auf Zeiger (pointer-events: none), damit die Trefferprüfung
 * weiter die darunterliegenden Tab-Leisten/Zonen erreicht.
 */
export function DragOverlay({ drag }: { drag: ReturnType<typeof usePanelDrag>["drag"] }) {
  if (!drag) return null;
  const def = getPanel(drag.panelId);
  const label = def ? t(def.title) : drag.panelId;
  const hover = drag.hover;

  return (
    <div className="drag-overlay" aria-hidden>
      {/* Einfüge-Caret in der überfahrenen Tab-Leiste (vertikal). */}
      {hover.kind === "tabstrip" && (
        <div
          className="tab-caret"
          style={{
            left: `${hover.caretX}px`,
            top: `${hover.stripTop}px`,
            height: `${hover.stripHeight}px`,
          }}
        />
      )}

      {/* Neue-Gruppe-Caret am oberen/unteren Rand eines Gruppen-Körpers
          (horizontal). */}
      {hover.kind === "split" && (
        <div
          className="group-caret"
          style={{
            left: `${hover.lineLeft}px`,
            top: `${hover.lineY}px`,
            width: `${hover.lineWidth}px`,
          }}
        />
      )}

      {/* Geist-Etikett am Cursor. */}
      <div
        className="drag-ghost"
        style={{ left: `${drag.x + 12}px`, top: `${drag.y + 8}px` }}
      >
        {label}
      </div>
    </div>
  );
}

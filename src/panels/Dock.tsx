// Dock — eine angedockte Spalte (links oder rechts) mit GESTAPELTEN Gruppen.
//
// Ein Dock hält eine Liste vertikal gestapelter Gruppen (DockState.groups). Jede
// Gruppe ist ein eigener Tab-Stapel (TabStrip + aktives Panel im PanelFrame) und
// trägt ein Höhen-Gewicht; zwischen den Gruppen sitzt ein Splitter, der die
// Gewichte der Nachbarn verschiebt. So entsteht das Vectorworks-Bild (z. B.
// links Werkzeuge OBEN, Attribute UNTEN gleichzeitig).
//
// Jede Gruppe rendert ihren PanelFrame in einem EIGENEN Host-Provider, damit der
// Darstellungsmodus-Umschalter dem aktiven Tab DIESER Gruppe folgt. Den Provider
// baut der Host (App) und reicht ihn als `buildHost(activeTab)` herein — das Dock
// bleibt so vom konkreten Host-Modell entkoppelt.
//
// Breite ist per Ziehgriff an der INNEREN Kante veränderbar (rechte Kante beim
// linken Dock, linke Kante beim rechten Dock); `dock.size` ist die Quelle der
// Wahrheit, `onResize(size)` meldet jede Änderung zurück. Die Gruppen-Höhen
// meldet `onResizeGroups(weights)`.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useCallback, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { PanelFrame } from "./PanelFrame";
import { TabStrip } from "./TabStrip";
import { getPanel } from "./registry";
import { PanelHostContext } from "./types";
import type {
  DisplayMode,
  DockId,
  DockState,
  PanelContext,
  PanelHost,
} from "./types";
import { t } from "../i18n";

/** Untere/obere Grenze der Dock-Breite in CSS-Pixeln (Voreinstellung). */
const DEFAULT_MIN_WIDTH = 200;
const DEFAULT_MAX_WIDTH = 480;
/** Mindest-Pixelhöhe, die eine Gruppe beim Splitter-Ziehen behält. */
const MIN_GROUP_PX = 70;

export interface DockProps {
  /** Welches Dock: bestimmt Rand + Seite des Ziehgriffs. */
  side: DockId;
  /** Zustand dieses Docks (Gruppen + Breite). */
  dock: DockState;
  /**
   * Beginn einer Tab-Geste (pointerdown auf einem Tab) — an die TabStrip
   * weitergereicht. Der Drag-Controller klärt Klick (aktivieren) vs. Ziehen
   * (Reorder/Andocken/Lösen/Stapeln).
   */
  onStartTabDrag: (panelId: string, e: React.PointerEvent) => void;
  /** Breite geändert — liefert die neue (bereits geklemmte) Breite in px. */
  onResize: (size: number) => void;
  /** Gruppen-Höhen geändert — liefert die neue Gewichts-Liste (so lang wie groups). */
  onResizeGroups: (weights: number[]) => void;
  /**
   * Baut den Host-Context-Wert für eine Gruppe (passend zu ihrem aktiven Tab).
   * App reicht hier `hostWithMode(...)` herein; das Dock wickelt jede Gruppe in
   * einen eigenen <PanelHostContext.Provider>.
   */
  buildHost: (activeTab: string | null) => PanelHost;
  /** Generischer Kontext, den der PanelFrame an `def.render` weiterreicht. */
  ctx?: PanelContext;
  /** Aktueller Darstellungsmodus zur aktiven Tab-ID einer Gruppe. */
  displayModeFor: (activeTab: string | null) => DisplayMode;
  /** Setter des Darstellungsmodus zur aktiven Tab-ID einer Gruppe. */
  onDisplayModeChange: (activeTab: string | null, mode: DisplayMode) => void;
  /** Minimale Breite in px (Voreinstellung 200). */
  minWidth?: number;
  /** Maximale Breite in px (Voreinstellung 480). */
  maxWidth?: number;
}

/** Begrenzt eine Breite auf [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Eine angedockte Spalte mit gestapelten Gruppen. Rendert je Gruppe TabStrip +
 * aktives Panel (im eigenen Host-Provider) und erlaubt das Verändern von Breite
 * (innere Kante) und Gruppen-Höhen (Splitter zwischen Gruppen).
 */
export function Dock({
  side,
  dock,
  onStartTabDrag,
  onResize,
  onResizeGroups,
  buildHost,
  ctx,
  displayModeFor,
  onDisplayModeChange,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
}: DockProps) {
  // Wurzelelement, um die Breite während des Ziehens aus clientX zu berechnen.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Container der Gruppen (für die Gesamthöhe beim Gruppen-Splitter).
  const stackRef = useRef<HTMLDivElement | null>(null);
  // Breite während des aktiven Ziehens; null = nicht im Ziehen (dock.size gilt).
  const [dragWidth, setDragWidth] = useState<number | null>(null);

  const onResizeStart = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Nur primäre Taste / Berührung; Griff fängt den Zeiger ein, damit das
      // Ziehen auch außerhalb des Elements weiterläuft.
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);

      const move = (ev: PointerEvent) => {
        const root = rootRef.current;
        if (!root) return;
        const rect = root.getBoundingClientRect();
        // Linkes Dock wächst nach rechts (Zeiger − linke Kante);
        // rechtes Dock wächst nach links (rechte Kante − Zeiger).
        const raw =
          side === "left" ? ev.clientX - rect.left : rect.right - ev.clientX;
        const next = clamp(Math.round(raw), minWidth, maxWidth);
        setDragWidth(next);
        onResize(next);
      };

      const up = (ev: PointerEvent) => {
        setDragWidth(null);
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        if (handle.hasPointerCapture(ev.pointerId)) {
          handle.releasePointerCapture(ev.pointerId);
        }
      };

      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    },
    [side, minWidth, maxWidth, onResize],
  );

  // Splitter zwischen Gruppe `index` und `index+1`: verschiebt Gewicht zwischen
  // den beiden Nachbarn. Umgerechnet wird der Pixel-Versatz über die Gesamthöhe
  // des Stapels in einen Gewichts-Anteil (Summe der Gewichte bleibt erhalten).
  const onGroupResizeStart = useCallback(
    (index: number, e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);

      const stack = stackRef.current;
      const totalPx = stack ? stack.getBoundingClientRect().height : 0;
      const weights = dock.groups.map((g) => g.weight);
      const sumW = weights.reduce((s, w) => s + w, 0) || 1;
      const startY = e.clientY;
      const wA = weights[index];
      const wB = weights[index + 1];
      // Pixel ↔ Gewicht: ein Pixel entspricht sumW/totalPx an Gewicht.
      const perPx = totalPx > 0 ? sumW / totalPx : 0;
      const minW = MIN_GROUP_PX * perPx;

      const move = (ev: PointerEvent) => {
        if (perPx === 0) return;
        const dW = (ev.clientY - startY) * perPx;
        // A wächst nach unten, B schrumpft; beide bleiben über dem Minimum.
        let nextA = wA + dW;
        let nextB = wB - dW;
        const pair = wA + wB;
        nextA = clamp(nextA, minW, pair - minW);
        nextB = pair - nextA;
        const out = [...weights];
        out[index] = nextA;
        out[index + 1] = nextB;
        onResizeGroups(out);
      };

      const up = (ev: PointerEvent) => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        if (handle.hasPointerCapture(ev.pointerId)) {
          handle.releasePointerCapture(ev.pointerId);
        }
      };

      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    },
    [dock.groups, onResizeGroups],
  );

  const width = dragWidth ?? dock.size;
  // Breite als CSS-Variable; styles.css liest --dock-w für flex-basis/width.
  const style = { "--dock-w": `${width}px` } as CSSProperties;

  return (
    <aside
      ref={rootRef}
      className={`dock dock-${side}${dragWidth !== null ? " resizing" : ""}`}
      style={style}
    >
      <div className="dock-stack" ref={stackRef}>
        {dock.groups.map((group, gi) => {
          const def = group.activeTab ? getPanel(group.activeTab) : undefined;
          const groupStyle = { flexGrow: group.weight } as CSSProperties;
          return [
            <section
              key={`g${gi}`}
              className="dock-group"
              style={groupStyle}
              // Datenattribute für die Drag-Auflösung: über dem Körper einer
              // Gruppe entsteht beim Ablegen eine NEUE Gruppe darüber/darunter.
              data-group-body=""
              data-dock={side}
              data-group-index={gi}
            >
              <TabStrip
                side={side}
                groupIndex={gi}
                group={group}
                onStartDrag={onStartTabDrag}
              />
              {def ? (
                <PanelHostContext.Provider value={buildHost(group.activeTab)}>
                  <PanelFrame
                    def={def}
                    ctx={ctx}
                    displayMode={displayModeFor(group.activeTab)}
                    onDisplayModeChange={(m) =>
                      onDisplayModeChange(group.activeTab, m)
                    }
                  />
                </PanelHostContext.Provider>
              ) : (
                <div className="panel-frame panel-frame-empty" />
              )}
            </section>,
            // Splitter zwischen dieser und der nächsten Gruppe.
            gi < dock.groups.length - 1 ? (
              <div
                key={`s${gi}`}
                className="dock-group-resize"
                role="separator"
                aria-orientation="horizontal"
                aria-label={t("dock.resize")}
                onPointerDown={(e) => onGroupResizeStart(gi, e)}
              />
            ) : null,
          ];
        })}
      </div>

      {/* Ziehgriff an der inneren Kante (rechts bei links, links bei rechts). */}
      <div
        className="dock-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t("dock.resize")}
        onPointerDown={onResizeStart}
      />
    </aside>
  );
}

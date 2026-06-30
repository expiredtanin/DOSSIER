// Schwebendes Panel — ein frei positioniertes, dunkles Fenster über der Mitte.
//
// Rendert denselben Panel-Inhalt wie ein Dock (über Registry + PanelFrame, inkl.
// Darstellungsmodus-Dropdown für Ebenen-Panels), aber in einem eigenen Fenster
// mit Titelleiste (zum Verschieben), Andock-/Schließen-Knopf und einem
// Greifer unten rechts zum Ändern der Größe. Ein Klick irgendwo im Fenster holt
// es nach vorne (z-Index).
//
// Verschieben/Größe ändern laufen über POINTER-Events mit Pointer-Capture, damit
// die Geste auch außerhalb des Fensters weiterläuft. Während des Ziehens der
// Titelleiste meldet `onTitleDrag` jede Cursorposition an den Host (App), der
// daraus eine mögliche Andock-Geste an einer Rand-Zone ableitet; beim Loslassen
// entscheidet `onTitleDrop`, ob das Fenster schwebend bleibt (verschoben) oder
// in ein Dock wandert.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useCallback, useRef } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { PanelFrame } from "./PanelFrame";
import { getPanel } from "./registry";
import type { DisplayMode, FloatingPanel as FloatingPanelState, PanelContext } from "./types";
import { t } from "../i18n";

/** Mindestgröße eines schwebenden Fensters in CSS-Pixeln. */
const MIN_W = 220;
const MIN_H = 160;

export interface FloatingPanelProps {
  /** Zustand (Position/Größe/z) dieses schwebenden Panels. */
  panel: FloatingPanelState;
  /** Generischer Kontext für den Panel-Inhalt (an def.render). */
  ctx?: PanelContext;
  /** Aktueller Darstellungsmodus (für Panels mit hasDisplayMode). */
  displayMode?: DisplayMode;
  /** Setter des Darstellungsmodus (zeigt den Umschalter in der Kopfzeile). */
  onDisplayModeChange?: (mode: DisplayMode) => void;
  /** Holt das Fenster nach vorne (z-Index) — bei Klick/Geste-Beginn. */
  onFocus: (panelId: string) => void;
  /** Verschiebt das Fenster (Position-Patch). */
  onMove: (panelId: string, x: number, y: number) => void;
  /** Ändert die Größe (w/h-Patch). */
  onResize: (panelId: string, w: number, h: number) => void;
  /** Dockt das Fenster wieder an (Standard-Andockziel des Redock-Knopfs). */
  onRedock: (panelId: string) => void;
  /** Schließt das Fenster (entfernt es ganz). */
  onClose: (panelId: string) => void;
  /**
   * Während des Titel-Ziehens: meldet die aktuelle Cursorposition (clientX/Y) an
   * den Host. Der Host hebt mögliche Rand-Andock-Zonen hervor.
   */
  onTitleDrag?: (panelId: string, clientX: number, clientY: number) => void;
  /**
   * Beim Loslassen der Titelleiste über einer Andock-Zone: meldet die finale
   * Cursorposition. Liefert `true`, wenn der Host das Fenster angedockt hat (dann
   * unterbleibt das reine Verschieben). Sonst bleibt das Fenster schwebend.
   */
  onTitleDrop?: (panelId: string, clientX: number, clientY: number) => boolean;
}

/**
 * Ein einzelnes schwebendes Panel-Fenster. Titelleiste = verschieben (+ Andocken
 * über Rand-Zonen), Greifer unten rechts = Größe ändern, Andock-/Schließen-Knopf
 * in der Titelleiste.
 */
export function FloatingPanel({
  panel,
  ctx,
  displayMode,
  onDisplayModeChange,
  onFocus,
  onMove,
  onResize,
  onRedock,
  onClose,
  onTitleDrag,
  onTitleDrop,
}: FloatingPanelProps) {
  const def = getPanel(panel.panelId);
  // Verschiebe-Offset (Cursor − linke/obere Kante) für ein ruckelfreies Greifen.
  const dragOffset = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  const onTitlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Knöpfe in der Titelleiste nicht als Verschiebe-Start werten.
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      onFocus(panel.panelId);
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      dragOffset.current = {
        dx: e.clientX - panel.x,
        dy: e.clientY - panel.y,
      };

      const move = (ev: PointerEvent) => {
        const x = ev.clientX - dragOffset.current.dx;
        const y = ev.clientY - dragOffset.current.dy;
        onMove(panel.panelId, x, y);
        onTitleDrag?.(panel.panelId, ev.clientX, ev.clientY);
      };
      const up = (ev: PointerEvent) => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.removeEventListener("pointercancel", up);
        if (handle.hasPointerCapture(ev.pointerId)) {
          handle.releasePointerCapture(ev.pointerId);
        }
        // Über einer Rand-Zone? Dann dockt der Host an; sonst bleibt es schweben.
        onTitleDrop?.(panel.panelId, ev.clientX, ev.clientY);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
      handle.addEventListener("pointercancel", up);
    },
    [panel.panelId, panel.x, panel.y, onFocus, onMove, onTitleDrag, onTitleDrop],
  );

  const onResizePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.stopPropagation();
      onFocus(panel.panelId);
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startY = e.clientY;
      const startW = panel.w;
      const startH = panel.h;

      const move = (ev: PointerEvent) => {
        const w = Math.max(MIN_W, Math.round(startW + (ev.clientX - startX)));
        const h = Math.max(MIN_H, Math.round(startH + (ev.clientY - startY)));
        onResize(panel.panelId, w, h);
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
    [panel.panelId, panel.w, panel.h, onFocus, onResize],
  );

  const style: CSSProperties = {
    left: `${panel.x}px`,
    top: `${panel.y}px`,
    width: `${panel.w}px`,
    height: `${panel.h}px`,
    zIndex: 500 + panel.z,
  };

  const title = def ? t(def.title) : panel.panelId;

  return (
    <section
      className="floating-panel"
      style={style}
      onPointerDownCapture={() => onFocus(panel.panelId)}
      role="dialog"
      aria-label={title}
    >
      <div className="floating-titlebar" onPointerDown={onTitlePointerDown}>
        <span className="floating-title">{title}</span>
        <div className="floating-actions">
          <button
            type="button"
            className="floating-btn"
            title={t("dock.redock")}
            aria-label={t("dock.redock")}
            onClick={() => onRedock(panel.panelId)}
          >
            ⤣
          </button>
          <button
            type="button"
            className="floating-btn"
            title={t("dock.close")}
            aria-label={t("dock.close")}
            onClick={() => onClose(panel.panelId)}
          >
            ×
          </button>
        </div>
      </div>

      {def ? (
        <PanelFrame
          def={def}
          ctx={ctx}
          displayMode={displayMode}
          onDisplayModeChange={onDisplayModeChange}
        />
      ) : (
        <div className="panel-frame panel-frame-empty" />
      )}

      {/* Greifer unten rechts (Größe ändern). */}
      <div
        className="floating-resize"
        role="separator"
        aria-label={t("dock.resizePanel")}
        title={t("dock.resizePanel")}
        onPointerDown={onResizePointerDown}
      />
    </section>
  );
}

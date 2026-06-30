// Generisches, wiederverwendbares Kontextmenü — 1:1 nach DOSSIER
// (docs/design/context-menu.md, Quelle src/components/ContextMenu.jsx).
//
// Reine Darstellung + Callbacks: der Aufrufer hält die offene Position (x/y in
// Viewport-Pixeln), die Item-Liste und reagiert über `onClose`. Das Menü selbst
// kümmert sich nur um Positionierung (Fixed + Rand-Clamp), das Schließen
// (Außenklick · Escape · erneuter Rechtsklick · Scroll · nach Item-Klick) und
// die Darstellung der Items (Icon, Shortcut, danger, divider, disabled).
//
// Gerendert über ein Portal in <body>, damit es über allem liegt und nicht vom
// overflow/transform eines Panels abgeschnitten wird (z-index ~300, unter
// Modals). Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/**
 * Ein Eintrag im Kontextmenü. Ein reiner Trenner setzt nur `divider: true`
 * (alle anderen Felder werden dann ignoriert). Sonst ist `label` Pflicht und
 * `onClick` die ausgelöste Aktion.
 */
export interface ContextMenuItem {
  /** Sichtbarer Text (deutsch). Bei `divider` ungenutzt. */
  label?: string;
  /** Optionales Icon (z. B. Material-Symbol-Name oder eigener Knoten). */
  icon?: ReactNode;
  /** Aktion beim Klick. Wird nur ausgeführt, wenn nicht `disabled`. */
  onClick?: () => void;
  /** Ausgegraut, nicht klickbar. */
  disabled?: boolean;
  /** Rote Schrift (destruktive Aktion, z. B. Löschen). */
  danger?: boolean;
  /** Optionales Tastenkürzel rechtsbündig (nur Anzeige). */
  shortcut?: string;
  /**
   * Optionaler Tooltip (title) — vor allem, um bei `disabled` den Grund zu
   * nennen (z. B. „keine Auswahl"). Reine Anzeige.
   */
  title?: string;
  /** Reiner Trenner (1px Linie); ignoriert alle anderen Felder. */
  divider?: boolean;
}

export interface ContextMenuProps {
  /** Ankerposition in Viewport-Pixeln (clientX). */
  x: number;
  /** Ankerposition in Viewport-Pixeln (clientY). */
  y: number;
  /** Die Einträge in Anzeigereihenfolge. */
  items: ContextMenuItem[];
  /** Schließen-Callback (Außenklick · Esc · Scroll · nach Item-Klick). */
  onClose: () => void;
  /** Optionaler Titel oben (caps, gedämpft) — z. B. Ebenenname/-code. */
  title?: string;
}

/** Rand-Abstand zum Viewport beim Clampen (px). */
const EDGE_PAD = 4;

/**
 * Material-Symbols-Icon (DOSSIER nutzt die Icon-Font). Fällt auf reinen Text
 * zurück; ist die Font nicht geladen, bleibt der Slot via min-width leer
 * ausgerichtet, sodass die Labels trotzdem fluchten.
 */
export function MenuIcon({ name }: { name: string }) {
  return (
    <span className="material-symbols-outlined ctx-icon" aria-hidden="true">
      {name}
    </span>
  );
}

export function ContextMenu({ x, y, items, onClose, title }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Tatsächliche Position nach dem Clampen an die Viewport-Ränder. Bis das Menü
  // gemessen ist, am Anker zeigen (kein Sprung — useLayoutEffect korrigiert vor
  // dem Paint).
  const [pos, setPos] = useState({ x, y });

  // Nach dem Mount messen und so verschieben, dass das Menü vollständig im
  // Viewport bleibt (rechter/unterer Rand → nach links/oben klappen).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let nx = x;
    let ny = y;
    if (nx + rect.width > vw - EDGE_PAD) nx = vw - rect.width - EDGE_PAD;
    if (ny + rect.height > vh - EDGE_PAD) ny = vh - rect.height - EDGE_PAD;
    if (nx < EDGE_PAD) nx = EDGE_PAD;
    if (ny < EDGE_PAD) ny = EDGE_PAD;
    setPos({ x: nx, y: ny });
  }, [x, y, items]);

  // Schließen bei: Klick/Rechtsklick außerhalb · Escape · Scroll · Resize.
  // pointerdown (capture) fängt auch den Beginn eines erneuten Rechtsklicks.
  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onScrollOrResize = () => onClose();
    // capture: vor anderen Handlern; passive scroll reicht (wir reagieren nur).
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [onClose]);

  const onItemClick = (item: ContextMenuItem) => {
    if (item.disabled || item.divider) return;
    item.onClick?.();
    onClose(); // Auto-Close nach Item-Klick.
  };

  const menu = (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      style={{ left: pos.x, top: pos.y }}
      // Eigenen Rechtsklick abfangen, damit kein Browser-Menü erscheint.
      onContextMenu={(e) => e.preventDefault()}
    >
      {title && <div className="ctx-title">{title}</div>}
      {items.map((item, i) =>
        item.divider ? (
          <div key={`div-${i}`} className="ctx-divider" role="separator" />
        ) : (
          <button
            key={`item-${i}`}
            type="button"
            role="menuitem"
            className={`ctx-item${item.danger ? " danger" : ""}`}
            disabled={item.disabled}
            title={item.title}
            onClick={() => onItemClick(item)}
          >
            {item.icon !== undefined && (
              <span className="ctx-item-icon">{item.icon}</span>
            )}
            <span className="ctx-item-label">{item.label}</span>
            {item.shortcut && (
              <span className="ctx-item-shortcut">{item.shortcut}</span>
            )}
          </button>
        ),
      )}
    </div>
  );

  return createPortal(menu, document.body);
}

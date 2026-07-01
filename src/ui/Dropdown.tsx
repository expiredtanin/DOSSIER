// Eigene, themebare Dropdown-Komponente im Stil des Kontextmenüs (ContextMenu).
//
// Ersetzt die nativen <select>-Dropdowns der Oberleiste, deren geöffnete
// Optionsliste vom Betriebssystem gerendert (blau, eckig, nicht themebar) wird.
// Das Popover hier ist dasselbe dunkle, abgerundete Popover wie das
// Kontextmenü: gleiche Tokens (Schatten, Radius, Akzent-Hover), Tastatur
// (↑/↓/Enter/Esc), Klick-außerhalb schließt, aktive Option markiert.
//
// Zwei Verwendungsarten:
//  • Wert-Auswahl wie <select>: `options` + `value` + `onChange` (Häkchen an
//    der aktiven Option).
//  • Aktions-Menü wie ein Trigger-Dropdown: `items` (mit Trennern/danger/
//    disabled, analog ContextMenu-Items). Der Trigger zeigt dann `value`-Label
//    bzw. den festen `placeholder`.
//
// Reine Darstellung + Callbacks; voll gesteuert. Identifier englisch, UI-Text
// kommt als Props (i18n) herein (CONVENTIONS.md).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";

/** Eine wählbare Option (Wert-Auswahl-Modus, analog <option>). */
export interface DropdownOption {
  value: string;
  label: string;
  /** Ausgegraut, nicht wählbar. */
  disabled?: boolean;
}

/**
 * Ein Eintrag im Aktions-Modus (analog ContextMenuItem). Ein reiner Trenner
 * setzt nur `divider: true`. Sonst ist `label` Pflicht und `onSelect` die
 * Aktion.
 */
export interface DropdownItem {
  /** Sichtbarer Text. Bei `divider` ungenutzt. */
  label?: string;
  /** Aktion bei Auswahl. Nur ausgeführt, wenn nicht `disabled`. */
  onSelect?: () => void;
  /** Ausgegraut, nicht klickbar. */
  disabled?: boolean;
  /** Rote Schrift (destruktive Aktion). */
  danger?: boolean;
  /** Als aktiv markiert (Häkchen). */
  active?: boolean;
  /** Reiner Trenner (1px Linie); ignoriert alle anderen Felder. */
  divider?: boolean;
}

export interface DropdownProps {
  /**
   * Wert-Auswahl-Modus: aktueller Wert + Optionsliste. Genau einer von
   * `options`/`items` wird angegeben.
   */
  options?: DropdownOption[];
  /** Aktueller Wert (Wert-Auswahl-Modus) — bestimmt Trigger-Label + Häkchen. */
  value?: string;
  /** Wertwechsel-Callback (Wert-Auswahl-Modus). */
  onChange?: (value: string) => void;

  /** Aktions-Modus: Liste aus Einträgen/Trennern (statt `options`). */
  items?: DropdownItem[];
  /**
   * Festes Trigger-Label (Aktions-Modus, da es keinen „Wert" gibt). Im
   * Wert-Auswahl-Modus ungenutzt — dort zeigt der Trigger das Options-Label.
   */
  placeholder?: string;

  /** Tooltip/aria-label des Triggers. */
  title?: string;
  /** Trigger ausgegraut, nicht klickbar. */
  disabled?: boolean;
  /** Mindestbreite des Triggers (px) — analog <select>-Breiten. */
  width?: number;
  /** Optionale Zusatzklasse am Trigger (z. B. monospace beim Massstab). */
  triggerClassName?: string;
  /** Optionaler Inhalt rechts im Trigger statt des Chevrons (selten). */
  triggerSuffix?: ReactNode;
}

/** Rand-Abstand zum Viewport beim Clampen (px). */
const EDGE_PAD = 4;

/** Kleines Chevron (Aufklapp-Pfeil) im Trigger. */
function Chevron() {
  return (
    <svg
      className="tb-dd-chevron"
      width="9"
      height="6"
      viewBox="0 0 10 6"
      aria-hidden="true"
    >
      <path d="M0 0l5 6 5-6z" fill="currentColor" />
    </svg>
  );
}

/** Häkchen vor der aktiven Option. */
function Check() {
  return (
    <svg
      className="tb-dd-check"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
    >
      <path
        d="M2.5 6.2 L4.7 8.6 L9.5 3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Dropdown({
  options,
  value,
  onChange,
  items,
  placeholder,
  title,
  disabled = false,
  width,
  triggerClassName,
  triggerSuffix,
}: DropdownProps) {
  const [open, setOpen] = useState(false);
  // Popover-Position (fixed), aus dem Trigger-Rect berechnet — die Oberleiste
  // hat overflow:hidden und würde ein absolut positioniertes Popover
  // abschneiden (gleiche Technik wie CameraMenu/ContextMenu).
  const [pos, setPos] = useState({ left: 0, top: 0, minWidth: 0 });
  // Tastatur-Fokus (Index in der gerenderten Zeilenliste).
  const [activeIdx, setActiveIdx] = useState(-1);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Einheitliche Zeilenliste: im Wert-Modus aus `options`, im Aktions-Modus aus
  // `items`. So teilen beide Modi dieselbe Render-/Tastatur-Logik.
  const rows: DropdownItem[] = items
    ? items
    : (options ?? []).map((o) => ({
        label: o.label,
        disabled: o.disabled,
        active: o.value === value,
        onSelect: () => onChange?.(o.value),
      }));

  // Trigger-Label: Wert-Modus → Label der aktiven Option; sonst `placeholder`.
  const current = options?.find((o) => o.value === value);
  const triggerLabel = current?.label ?? placeholder ?? "";

  // Index der ersten auswählbaren Zeile (für Tastatur-Start).
  const firstSelectable = rows.findIndex((r) => !r.divider && !r.disabled);

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ left: r.left, top: r.bottom + 4, minWidth: r.width });
  };

  const openMenu = () => {
    if (disabled) return;
    place();
    // Tastatur-Fokus auf die aktive bzw. erste auswählbare Zeile setzen.
    const activeRow = rows.findIndex((r) => r.active && !r.disabled);
    setActiveIdx(activeRow >= 0 ? activeRow : firstSelectable);
    setOpen(true);
  };

  const close = () => {
    setOpen(false);
    setActiveIdx(-1);
  };

  const selectRow = (row: DropdownItem) => {
    if (row.disabled || row.divider) return;
    row.onSelect?.();
    close();
  };

  // Nach dem Öffnen: Position vor dem Paint an die Viewport-Ränder clampen.
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos((p) => {
      let left = p.left;
      let top = p.top;
      if (left + rect.width > vw - EDGE_PAD) left = vw - rect.width - EDGE_PAD;
      if (top + rect.height > vh - EDGE_PAD) {
        // Nach oben klappen, wenn unten kein Platz ist.
        const r = btnRef.current?.getBoundingClientRect();
        top = r ? r.top - rect.height - 4 : vh - rect.height - EDGE_PAD;
      }
      if (left < EDGE_PAD) left = EDGE_PAD;
      if (top < EDGE_PAD) top = EDGE_PAD;
      return { ...p, left, top };
    });
  }, [open]);

  // Schließen bei: Außenklick · Scroll · Resize. (Esc + Pfeile laufen über den
  // Keydown-Handler unten, der nur bei offenem Menü aktiv ist.)
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const tgt = e.target as Node;
      if (
        menuRef.current?.contains(tgt) ||
        btnRef.current?.contains(tgt)
      ) {
        return;
      }
      close();
    };
    const onScrollOrResize = () => close();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
    };
  }, [open]);

  // Tastatur: ↑/↓ bewegt den Fokus über auswählbare Zeilen (Trenner/disabled
  // überspringen), Enter wählt, Esc schließt.
  const step = (dir: 1 | -1) => {
    if (rows.length === 0) return;
    let i = activeIdx;
    for (let n = 0; n < rows.length; n++) {
      i = (i + dir + rows.length) % rows.length;
      const row = rows[i];
      if (row && !row.divider && !row.disabled) {
        setActiveIdx(i);
        return;
      }
    }
  };

  const onTriggerKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      step(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      step(-1);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const row = rows[activeIdx];
      if (row) selectRow(row);
    }
  };

  const menu = open ? (
    <div
      ref={menuRef}
      className="ctx-menu tb-dd-menu"
      role="listbox"
      style={{ left: pos.left, top: pos.top, minWidth: pos.minWidth }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {rows.map((row, i) =>
        row.divider ? (
          <div key={`div-${i}`} className="ctx-divider" role="separator" />
        ) : (
          <button
            key={`row-${i}`}
            type="button"
            role="option"
            aria-selected={!!row.active}
            className={`ctx-item tb-dd-item${row.danger ? " danger" : ""}${
              i === activeIdx ? " is-active" : ""
            }`}
            disabled={row.disabled}
            onMouseEnter={() => !row.disabled && setActiveIdx(i)}
            onClick={() => selectRow(row)}
          >
            <span className="tb-dd-check-slot">{row.active && <Check />}</span>
            <span className="ctx-item-label">{row.label}</span>
          </button>
        ),
      )}
    </div>
  ) : null;

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`tb-dd-trigger${open ? " active" : ""}${
          triggerClassName ? ` ${triggerClassName}` : ""
        }`}
        style={width ? { minWidth: width } : undefined}
        disabled={disabled}
        title={title}
        aria-label={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="tb-dd-trigger-label">{triggerLabel}</span>
        {triggerSuffix ?? <Chevron />}
      </button>
      {menu && createPortal(menu, document.body)}
    </>
  );
}

// Farbfeld mit Stift-Kopplung (ArchiCAD-Stiftsatz-Muster, `model/penSets.ts`)
// — die EINE gemeinsame Komponente für ComponentsTab, den Ebenen-Editor
// (App.tsx) und das Attribut-Panel. Redesign nach Nutzer-Feedback (Runde 2):
// die sichtbare Zeile ist wieder NUR der Swatch (wie der einfache `ColorField`
// zuvor) — ein kleines Nummer-Badge in der Ecke zeigt, ob ein Stift aktiv ist.
// Klick öffnet EIN Popover mit Kopfzeile [Frei/Stift-Umschalter] [getipptes
// Feld — Stiftnummer bzw. #Hex] und darunter dem passenden Raster (Stifte des
// aktiven Stiftsatzes bzw. feste Palette + „andere Farbe…"-Fallback). Ein
// Stift trägt Farbe UND Strichstärke zusammen — `showWeight` blendet die
// Stärke-Info-Zeile ein, wenn der Aufrufer ein gekoppeltes Strichstärke-Feld
// hat (Wand/Decke/Stütze/Drawing2D/Ebene; s. `model/penSets.ts`::
// bakeElementColorAndWeight).

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { BuiltinPaletteBanks, ColorPen, CustomPalette, PenStyle } from "../model/types";
import { Swatch } from "./ColorSwatchCell";
import { FreeColorPicker } from "./FreeColorPicker";
import { Segmented } from "./resourceManager/fields";
import { t } from "../i18n";

const EDGE_PAD = 4;
const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

function normalizeHex(v: string): string {
  const hex = v.startsWith("#") ? v.slice(1) : v;
  return `#${hex.toLowerCase()}`;
}

export interface PenColorFieldProps {
  /** Anzeigefarbe — bereits aufgelöst (Stift-Farbe, falls `penId` gesetzt). */
  color: string;
  penId: string | undefined;
  pens: ColorPen[];
  /** Stile (Farbe+Stärke) des AKTIVEN Stiftsatzes — für das Stift-Raster + die Stärke-Anzeige. */
  activeStyles: Record<string, PenStyle> | undefined;
  onColorChange: (hex: string) => void;
  /** `undefined` = zurück auf „Frei"; sonst die neue Stift-Nummer. */
  onPenChange: (penId: string | undefined) => void;
  /** Zeigt bei Stift-Modus eine Zeile „Stärke: x,xx mm" (nur wenn der Aufrufer ein gekoppeltes Strichstärke-Feld hat). */
  showWeight?: boolean;
  /**
   * Sperrt den Swatch (kein Popover, kein Klick) — für Attribut-Zeilen mit
   * Quellen-Dropdown (Vordergrund/Hintergrund im Attribut-Panel), die nur bei
   * „eigener Wert" editierbar sind (analog `ColorField.disabled`).
   */
  disabled?: boolean;
  /** Eigene Paletten + Bank-Sichtbarkeit fürs „Frei"-Raster (s. `FreeColorPicker`). */
  customPalettes?: CustomPalette[];
  builtinBanks?: BuiltinPaletteBanks;
  /** Legt die aktuelle Farbe in einer eigenen Palette ab („+"-Zelle im Raster). */
  onSaveColor?: (paletteId: string, hex: string) => void;
}

export function PenColorField({
  color,
  penId,
  pens,
  activeStyles,
  onColorChange,
  onPenChange,
  showWeight,
  disabled,
  customPalettes,
  builtinBanks,
  onSaveColor,
}: PenColorFieldProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  // Tipp-Puffer fürs Hex-Feld — erlaubt unvollständige Zwischenzustände beim
  // Tippen (z. B. "#3f"), ohne dass der kontrollierte Wert sie sofort verwirft.
  const [hexDraft, setHexDraft] = useState(color);
  // Direkt-Edit des Badges (Nutzer-Wunsch): Klick auf das Nummer-Badge ODER
  // den Swatch selbst — nur im Stift-Modus — springt sofort in ein kleines
  // Inline-Zahlenfeld, ohne erst das ganze Popover öffnen zu müssen.
  const [badgeEditing, setBadgeEditing] = useState(false);
  const [badgeDraft, setBadgeDraft] = useState("");
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const badgeInputRef = useRef<HTMLInputElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const openPopover = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 4 });
    setHexDraft(color);
    setOpen(true);
  };
  const close = () => setOpen(false);

  // Nach dem Öffnen: an den Viewport-Rand clampen (gleiche Technik wie Dropdown.tsx).
  useLayoutEffect(() => {
    if (!open) return;
    const el = popRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    setPos((p) => {
      let left = p.left;
      let top = p.top;
      if (left + rect.width > vw - EDGE_PAD) left = vw - rect.width - EDGE_PAD;
      if (top + rect.height > vh - EDGE_PAD) {
        const r = btnRef.current?.getBoundingClientRect();
        top = r ? r.top - rect.height - 4 : vh - rect.height - EDGE_PAD;
      }
      if (left < EDGE_PAD) left = EDGE_PAD;
      if (top < EDGE_PAD) top = EDGE_PAD;
      return { left, top };
    });
  }, [open]);

  // Aussenklick/Scroll/Resize schliesst (gleiche Technik wie Dropdown.tsx).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const tgt = e.target as Node;
      if (popRef.current?.contains(tgt) || btnRef.current?.contains(tgt)) return;
      close();
    };
    // Scrollt der Nutzer INNERHALB des Popovers (langes Paletten-Raster, z. B.
    // RAL mit 168 Farben), darf das Popover NICHT schliessen — der Listener
    // läuft in der Capture-Phase und sieht sonst auch das Scrollen des eigenen
    // Rasters (Nutzer-Report: „bei RAL lässt es sich nicht scrollen").
    // Geschlossen wird nur bei Scrollen AUSSERHALB (Plan/Panel bewegt sich weg
    // unter dem Popover) und bei Resize.
    const onScroll = (e: Event) => {
      const tgt = e.target as Node | null;
      if (tgt && popRef.current?.contains(tgt)) return;
      close();
    };
    const onResize = () => close();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);

  const weight = penId !== undefined ? activeStyles?.[penId]?.weight : undefined;
  const isPen = penId !== undefined;

  const commitHex = (raw: string) => {
    setHexDraft(raw);
    if (HEX_RE.test(raw)) onColorChange(normalizeHex(raw));
  };
  const pickFree = (hex: string) => {
    setHexDraft(hex);
    onColorChange(hex);
  };

  const startBadgeEdit = (e: MouseEvent) => {
    if (disabled || !isPen) return;
    e.stopPropagation();
    if (open) close();
    setBadgeDraft(penId ?? "1");
    setBadgeEditing(true);
  };
  const commitBadge = () => {
    const digits = badgeDraft.replace(/[^0-9]/g, "");
    onPenChange(digits === "" ? "1" : digits);
    setBadgeEditing(false);
  };

  // Nach dem Umschalten in den Edit-Modus: Fokus + Textauswahl, damit sofort
  // überschrieben werden kann (wie ein Doppelklick-Rename).
  useEffect(() => {
    if (!badgeEditing) return;
    badgeInputRef.current?.focus();
    badgeInputRef.current?.select();
  }, [badgeEditing]);

  return (
    <div className="pen-color-field">
      <span className="pen-color-swatch-wrap">
        <button
          ref={btnRef}
          type="button"
          className={`pen-color-swatch${disabled ? " pen-color-swatch-disabled" : ""}`}
          style={{ background: color }}
          title={isPen ? `${t("pen.numberHint")}: ${penId}` : color}
          disabled={disabled}
          onClick={() => (open ? close() : openPopover())}
        />
        {isPen &&
          (badgeEditing ? (
            <input
              ref={badgeInputRef}
              type="text"
              inputMode="numeric"
              className="pen-color-badge pen-color-badge-input"
              value={badgeDraft}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setBadgeDraft(e.target.value.replace(/[^0-9]/g, ""))}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitBadge();
                else if (e.key === "Escape") setBadgeEditing(false);
              }}
              onBlur={commitBadge}
            />
          ) : (
            <button
              type="button"
              className="pen-color-badge"
              title={t("pen.numberHint")}
              disabled={disabled}
              onClick={startBadgeEdit}
            >
              {penId}
            </button>
          ))}
      </span>
      {showWeight && isPen && (
        <span className="pen-color-weight-hint">
          {t("pen.weightHint", { weight: (weight ?? 0).toFixed(2) })}
        </span>
      )}
      {open &&
        createPortal(
          <div ref={popRef} className="ctx-menu pen-color-popover" style={{ left: pos.left, top: pos.top }}>
            <div className="pen-color-header">
              <Segmented
                value={isPen ? "pen" : "free"}
                onChange={(v) => onPenChange(v === "pen" ? (penId ?? "1") : undefined)}
                options={[
                  { value: "free", label: t("pen.free") },
                  { value: "pen", label: t("pen.byPen") },
                ]}
              />
              {isPen ? (
                <input
                  type="text"
                  inputMode="numeric"
                  className="pen-color-input"
                  value={penId}
                  title={t("pen.numberHint")}
                  onChange={(e) => {
                    const digits = e.target.value.replace(/[^0-9]/g, "");
                    onPenChange(digits === "" ? "1" : digits);
                  }}
                />
              ) : (
                <input
                  type="text"
                  className="pen-color-input mono"
                  value={hexDraft}
                  title={t("pen.hexHint")}
                  placeholder="#rrggbb"
                  onChange={(e) => commitHex(e.target.value)}
                  onBlur={() => setHexDraft(color)}
                />
              )}
            </div>
            {isPen ? (
              <div className="pen-color-grid">
                {pens.map((p) => (
                  <Swatch
                    key={p.id}
                    color={activeStyles?.[p.id]?.color ?? "#9aa0a6"}
                    active={p.id === penId}
                    title={`${p.id} — ${p.name}`}
                    label={p.id}
                    onClick={() => {
                      onPenChange(p.id);
                      close();
                    }}
                  />
                ))}
                {pens.length === 0 && <div className="res-empty">{t("resources.pens.empty")}</div>}
              </div>
            ) : (
              <FreeColorPicker
                color={color}
                onChange={pickFree}
                customPalettes={customPalettes}
                builtinBanks={builtinBanks}
                onSaveColor={onSaveColor}
              />
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}

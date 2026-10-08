// Swatch mit eigenem Popover für die Stift-FARBDEFINITION selbst (Stiftsatz-
// Tab: „welche Farbe HAT Stift Nr. 3"). Anders als `PenColorField` (das einem
// ELEMENT einen Stift zuweist) geht es hier nur um freie Farbwahl — dieselbe
// Popover-Mechanik wie `PenColorField`/`Dropdown.tsx` (eigene Positionierungs-
// /Aussenklick-Logik), aber ohne Frei/Stift-Umschalter.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FreeColorPicker } from "./FreeColorPicker";
import type { BuiltinPaletteBanks, CustomPalette } from "../model/types";

const EDGE_PAD = 4;

export function PenSwatchPicker({
  color,
  onChange,
  customPalettes,
  builtinBanks,
  onSaveColor,
}: {
  color: string;
  onChange: (hex: string) => void;
  customPalettes?: CustomPalette[];
  builtinBanks?: BuiltinPaletteBanks;
  onSaveColor?: (paletteId: string, hex: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const openPopover = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ left: r.left, top: r.bottom + 4 });
    setOpen(true);
  };
  const close = () => setOpen(false);

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

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="pen-color-swatch"
        style={{ background: color }}
        title={color}
        onClick={() => (open ? close() : openPopover())}
      />
      {open &&
        createPortal(
          <div ref={popRef} className="ctx-menu pen-color-popover" style={{ left: pos.left, top: pos.top }}>
            <FreeColorPicker
              color={color}
              onChange={onChange}
              customPalettes={customPalettes}
              builtinBanks={builtinBanks}
              onSaveColor={onSaveColor}
            />
          </div>,
          document.body,
        )}
    </>
  );
}

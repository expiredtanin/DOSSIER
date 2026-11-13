// Hilfslinien des Layout-Blatts ([208]): Liste mit Position, Löschen und Anlegen per Zahl. Dazu ziehen aus dem Lineal
// (LayoutSheet) und Doppelklick auf eine Linie. Die Linien hängen am Masterlayout, nur am Bildschirm sichtbar.

import { useEffect, useRef, useState } from "react";
import type { LayoutGuide } from "../model/types";
import { t } from "../i18n";

export function SheetGuidesHud({
  guides,
  onAdd,
  onMove,
  onRemove,
  onClear,
  onClose,
}: {
  guides: LayoutGuide[];
  onAdd: (axis: "x" | "y", posMm: number) => void;
  onMove: (index: number, posMm: number) => void;
  onRemove: (index: number) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const [axis, setAxis] = useState<"x" | "y">("x");
  const [pos, setPos] = useState("");
  // [249] Beim Öffnen ins Positionsfeld (Linie per Zahl anlegen), Esc schliesst, Fokus kehrt zum Knopf zurück (LayoutSheet).
  const posRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    posRef.current?.focus({ preventScroll: true });
  }, []);
  const add = () => {
    const n = parseFloat(pos.replace(",", "."));
    if (!Number.isFinite(n)) return;
    onAdd(axis, n);
    setPos("");
  };
  return (
    <div
      className="layout-sheet-hud layout-sheet-guides"
      data-sheet-ui
      data-testid="guides-hud"
      role="group"
      aria-label={t("sheetGuides.title")}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="layout-sheet-hud-title" style={{ display: "flex", justifyContent: "space-between" }}>
        <span>{t("sheetGuides.title")}</span>
        <button className="nav-add" data-testid="guides-close" onClick={onClose} title={t("sheetGuides.close")} aria-label={t("sheetGuides.close")}>×</button>
      </div>
      <div className="layout-sheet-hud-size">{t("sheetGuides.hint")}</div>
      <div className="layout-sheet-hud-row">
        <select className="res-input" data-testid="guide-axis" aria-label={t("sheetGuides.axis")} value={axis} onChange={(e) => setAxis(e.target.value as "x" | "y")}>
          <option value="x">{t("sheetGuides.vertical")}</option>
          <option value="y">{t("sheetGuides.horizontal")}</option>
        </select>
        <input
          type="text"
          inputMode="decimal"
          className="res-input mono num"
          data-testid="guide-pos"
          ref={posRef}
          aria-label={t("sheetGuides.position")}
          placeholder="mm"
          value={pos}
          onChange={(e) => setPos(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <button className="nav-add" data-testid="guide-add" onClick={add} aria-label={t("sheetGuides.add")} title={t("sheetGuides.add")}>＋</button>
      </div>
      {guides.map((g, i) => (
        <div key={`${g.axis}-${g.posMm}-${i}`} className="layout-sheet-hud-row" data-guide-row>
          <span>{g.axis === "x" ? t("sheetGuides.vertical") : t("sheetGuides.horizontal")}</span>
          <span className="layout-sheet-hud-scale">
            <input
              type="number"
              step={1}
              className="res-input mono num"
              defaultValue={g.posMm}
              aria-label={t("sheetGuides.rowPosition", { axis: g.axis === "x" ? t("sheetGuides.vertical") : t("sheetGuides.horizontal") })}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur(); // übernimmt den Wert (onBlur)
              }}
              onBlur={(e) => {
                const n = parseFloat(e.target.value);
                if (Number.isFinite(n) && n !== g.posMm) onMove(i, n);
              }}
            />
            <button className="nav-add" data-guide-remove title={t("sheetGuides.remove")} aria-label={t("sheetGuides.remove")} onClick={() => onRemove(i)}>
              <span className="material-symbols-outlined" aria-hidden="true">delete</span>
            </button>
          </span>
        </div>
      ))}
      {guides.length > 0 && (
        <div className="layout-sheet-hud-actions">
          <button className="nav-add" data-testid="guides-clear" onClick={onClear}>{t("sheetGuides.clear")}</button>
        </div>
      )}
    </div>
  );
}

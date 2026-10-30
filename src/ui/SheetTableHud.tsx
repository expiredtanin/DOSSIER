// Eigenschaften der gewählten Blatt-Tabelle ([111]): Quelle, Spaltenwahl, Schrift/Textstil, Zeilenhöhe, Linien,
// Rahmen (Position/Breite/Höhe), Fortsetzung in einem weiteren Rahmen. Reine Eingabe-Hülle: jede Änderung geht als
// Teil-Patch an `onPatch` (ein Undo-Schritt je Änderung, gleiche Eingaben fassen sich zusammen).

import type { LayoutTable, LayoutTableSource, Project } from "../model/types";
import { t } from "../i18n";
import { tableCatalog, tableSourceLabel, TABLE_SOURCES } from "../core";
import type { TableOut } from "../core";

type Patch = Partial<Omit<LayoutTable, "id">>;

function NumberField({ label, value, onChange, min = 0, step = 1, placeholder }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; min?: number; step?: number; placeholder?: string }) {
  return (
    <label className="layout-sheet-hud-row">
      <span>{label}</span>
      <input
        type="number"
        className="res-input mono num"
        min={min}
        step={step}
        value={value ?? ""}
        placeholder={placeholder}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(undefined);
          const v = parseFloat(raw);
          if (Number.isFinite(v) && v >= min) onChange(v);
        }}
      />
    </label>
  );
}

export function SheetTableHud({
  project,
  table,
  others,
  out,
  onPatch,
  onRemove,
}: {
  project: Project;
  table: LayoutTable;
  /** Die übrigen Tabellen des Blatts (Auswahl der Fortsetzung). */
  others: readonly LayoutTable[];
  out: TableOut | undefined;
  onPatch: (patch: Patch) => void;
  onRemove: () => void;
}) {
  const cat = tableCatalog(project).sources[table.source] ?? [];
  const selected = table.columns ?? cat.filter((c) => c.default).map((c) => c.id);
  const toggle = (id: string) => {
    const next = selected.includes(id) ? selected.filter((x) => x !== id) : cat.map((c) => c.id).filter((x) => x === id || selected.includes(x));
    if (next.length > 0) onPatch({ columns: next });
  };
  const styles = project.textStyles ?? [];
  const sel = (v: string | undefined) => v ?? "";
  return (
    <div className="layout-sheet-hud layout-sheet-hud-table" data-sheet-ui data-table-hud>
      <div className="layout-sheet-hud-title">{t("sheetTable.title")}</div>
      <label className="layout-sheet-hud-row">
        <span>{t("sheetTable.source")}</span>
        <select className="res-select" value={table.source} onChange={(e) => onPatch({ source: e.target.value as LayoutTableSource, columns: undefined, filter: undefined })} disabled={!!table.continues}>
          {TABLE_SOURCES.map((s) => (
            <option key={s} value={s}>{tableSourceLabel(s)}</option>
          ))}
        </select>
      </label>
      {table.source === "openings" && (
        <label className="layout-sheet-hud-row">
          <span>{t("sheetTable.filter")}</span>
          <select className="res-select" value={sel(table.filter)} onChange={(e) => onPatch({ filter: e.target.value || undefined })} disabled={!!table.continues}>
            <option value="">{t("sheetTable.filter.all")}</option>
            <option value="window">{t("sheetTable.filter.window")}</option>
            <option value="door">{t("sheetTable.filter.door")}</option>
          </select>
        </label>
      )}
      <div className="layout-sheet-hud-block">
        <span>{t("sheetTable.columns")}</span>
        <div className="layout-sheet-hud-cols" data-table-columns>
          {cat.map((c) => (
            <label key={c.id}>
              <input type="checkbox" checked={selected.includes(c.id)} disabled={!!table.continues} onChange={() => toggle(c.id)} data-table-col={c.id} />
              {t(c.key)}
            </label>
          ))}
        </div>
      </div>
      <label className="layout-sheet-hud-row">
        <span>{t("sheetTable.textStyle")}</span>
        <select className="res-select" value={sel(table.textStyleId)} onChange={(e) => onPatch({ textStyleId: e.target.value || undefined })}>
          <option value="">{t("sheetTable.textStyle.none")}</option>
          {styles.map((s) => (
            <option key={s.id} value={s.id}>{s.label}</option>
          ))}
        </select>
      </label>
      <NumberField label={t("sheetTable.fontSize")} value={table.fontSizePt} min={3} step={0.5} placeholder="8" onChange={(v) => onPatch({ fontSizePt: v })} />
      <NumberField label={t("sheetTable.rowHeight")} value={table.rowHeightMm} min={1} step={0.5} onChange={(v) => onPatch({ rowHeightMm: v })} />
      <label className="layout-sheet-hud-row">
        <span>{t("sheetTable.borders")}</span>
        <select className="res-select" value={table.borders ?? "grid"} onChange={(e) => onPatch({ borders: e.target.value })}>
          {["grid", "rows", "outer", "none"].map((b) => (
            <option key={b} value={b}>{t(`sheetTable.borders.${b}`)}</option>
          ))}
        </select>
      </label>
      <label className="layout-sheet-hud-row">
        <span>{t("sheetTable.header")}</span>
        <input type="checkbox" checked={table.header ?? true} onChange={(e) => onPatch({ header: e.target.checked })} />
      </label>
      <NumberField label="X [mm]" value={table.xMm} step={1} min={-10000} onChange={(v) => v !== undefined && onPatch({ xMm: v })} />
      <NumberField label="Y [mm]" value={table.yMm} step={1} min={-10000} onChange={(v) => v !== undefined && onPatch({ yMm: v })} />
      <NumberField label={t("sheetTable.width")} value={table.widthMm} min={10} onChange={(v) => v !== undefined && onPatch({ widthMm: v })} />
      <NumberField label={t("sheetTable.height")} value={table.heightMm} min={5} placeholder={t("sheetTable.height.all")} onChange={(v) => onPatch({ heightMm: v })} />
      <label className="layout-sheet-hud-row">
        <span>{t("sheetTable.continues")}</span>
        <select className="res-select" value={sel(table.continues)} onChange={(e) => onPatch({ continues: e.target.value || undefined })}>
          <option value="">{t("sheetTable.continues.none")}</option>
          {others.map((o) => (
            <option key={o.id} value={o.id}>{tableSourceLabel(o.source)} · {Math.round(o.xMm)}/{Math.round(o.yMm)}</option>
          ))}
        </select>
      </label>
      {out && out.hidden > 0 && (
        <div className="layout-sheet-hud-size" style={{ color: "#b45309" }} data-table-hidden>
          {t("sheetTable.hidden", { n: out.hidden })}
        </div>
      )}
      {out && <div className="layout-sheet-hud-size">{t("sheetTable.rows", { shown: out.shown, total: out.total })}</div>}
      <div className="layout-sheet-hud-actions">
        <button className="nav-add" onClick={onRemove} title={t("sheetTable.remove")} data-table-remove>
          <span className="material-symbols-outlined" aria-hidden="true">delete</span>
        </button>
      </div>
    </div>
  );
}

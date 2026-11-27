// [333] Objekt-Info eines offenen Layout-Blatts ohne Auswahl (wie InDesign: ohne Auswahl die Eigenschaften des Dokuments):
// Name, Plannummer, Revision, Format und Ausrichtung (nur ohne Master — sonst gibt der Master die Grösse), Masterlayout,
// dazu Blattgrösse und Inhalt (Ansichten, Tabellen). Jede Änderung ein Undo-Schritt.

import type { Layout, LayoutOrientation, LayoutPaperFormat } from "../../model/types";
import { useStore } from "../../state/appStore";
import { t } from "../../i18n";
import { patchItem } from "../../core";
import { Dropdown } from "../../ui/Dropdown";
import { effectiveSheetSizeMm, findMaster } from "../../model/layoutModel";

const PAPERS: LayoutPaperFormat[] = ["a0", "a1", "a2", "a3", "a4", "a5", "a6", "b0", "b1", "b2", "b3", "b4", "b5", "b6"];

function TextField({ label, value, onCommit, testId }: { label: string; value: string; onCommit: (v: string) => void; testId?: string }) {
  return (
    <label className="objinfo-field">
      <span className="objinfo-flabel">{label}</span>
      <input
        className="objinfo-text"
        type="text"
        defaultValue={value}
        key={value}
        data-testid={testId}
        onBlur={(e) => {
          const v = e.target.value.trim();
          if (v !== value) onCommit(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

export function SheetSection({ layoutId }: { layoutId: string }) {
  const project = useStore((s) => s.project);
  const applyChange = useStore((s) => s.applyChange);
  const layout = (project.layouts ?? []).find((l) => l.id === layoutId);
  if (!layout) return null;
  const set = (patch: Partial<Layout>) => applyChange((p) => patchItem(p, "layouts", layout.id, patch));
  const master = findMaster(project, layout);
  const size = effectiveSheetSizeMm(master ?? layout);
  const masters = project.masterLayouts ?? [];
  return (
    <div className="objinfo-panel" data-testid="sheet-section">
      <div className="objinfo-head">
        <span className="objinfo-kind">{t("objinfo.sheet.kind")}</span>
      </div>
      <TextField label={t("objinfo.sheet.name")} value={layout.name} testId="sheet-name" onCommit={(v) => v && set({ name: v })} />
      <TextField label={t("objinfo.sheet.number")} value={layout.planNumber ?? ""} onCommit={(v) => set({ planNumber: v || undefined })} />
      <TextField label={t("objinfo.sheet.revision")} value={layout.revision ?? ""} onCommit={(v) => set({ revision: v || undefined })} />
      <div className="objinfo-section-label">{t("objinfo.sheet.paper")}</div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("layouts.master")}</span>
        <Dropdown
          value={layout.masterId ?? ""}
          onChange={(v) => set({ masterId: v || undefined })}
          options={[{ value: "", label: t("layouts.noMaster") }, ...masters.map((m) => ({ value: m.id, label: m.name }))]}
          title={t("layouts.master")}
          width={150}
        />
      </div>
      {!master && (
        <>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("layouts.paper")}</span>
            <Dropdown
              value={layout.paper}
              onChange={(v) => set({ paper: v as LayoutPaperFormat, customWidthMm: undefined, customHeightMm: undefined })}
              options={PAPERS.map((v) => ({ value: v, label: v.toUpperCase() }))}
              title={t("layouts.paper")}
              width={150}
            />
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("layouts.orientation")}</span>
            <Dropdown
              value={layout.orientation}
              onChange={(v) => set({ orientation: v as LayoutOrientation })}
              options={[
                { value: "portrait", label: t("layouts.portrait") },
                { value: "landscape", label: t("layouts.landscape") },
              ]}
              title={t("layouts.orientation")}
              width={150}
            />
          </div>
        </>
      )}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.sheet.size")}</span>
        <span className="objinfo-fval">{`${Math.round(size.w)} × ${Math.round(size.h)} mm`}</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.sheet.content")}</span>
        <span className="objinfo-fval">
          {t("objinfo.sheet.contentCount", { views: layout.viewports.length, tables: (layout.tables ?? []).length })}
        </span>
      </div>
      <div className="objinfo-muted">{t("objinfo.sheet.hint")}</div>
    </div>
  );
}

// Abschnitt „Publikation" im Layouts-Panel ([79]): benannte Sätze aus Layouts (und gespeicherten Ansichten)
// mit Ausgabe-Einstellungen; ein Klick erzeugt alle Dateien. Darunter das Publikationsprotokoll.
// Reine Verdrahtung über den Host; Logik in `export/publishSet.ts`, `state/publishActions.ts`.

import { useState } from "react";
import { usePanelHost } from "./host";
import type { LayoutPaperFormat, PublishSet } from "../model/types";
import { PAPER_FORMATS } from "../model/layoutModel";
import { DEFAULT_NAME_PATTERN } from "../export/publishSet";
import { t } from "../i18n";

const FORMATS = ["pdf-multi", "pdf-single", "dxf", "dwg"] as const;
const LOG_SHOWN = 5;

function toggle(list: readonly string[], id: string, on: boolean): string[] {
  return on ? (list.includes(id) ? [...list] : [...list, id]) : list.filter((x) => x !== id);
}

function SetEditor({ set }: { set: PublishSet }) {
  const host = usePanelHost();
  const project = host.project;
  const patch = (p: Partial<Omit<PublishSet, "id">>) => host.onPatchPublishSet(set.id, p);
  const layouts = project.layouts ?? [];
  const snapshots = project.viewSnapshots ?? [];
  const format = set.format ?? "pdf-multi";
  const pdf = format === "pdf-multi" || format === "pdf-single";
  return (
    <div style={{ padding: "4px 10px 8px", display: "grid", gap: 5, fontSize: 12 }} data-publish-editor>
      <label style={{ display: "grid", gap: 2 }}>
        <span>{t("publish.name")}</span>
        <input className="res-input" value={set.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>
      <label style={{ display: "grid", gap: 2 }}>
        <span>{t("publish.format")}</span>
        <select className="res-select" value={format} onChange={(e) => patch({ format: e.target.value })}>
          {FORMATS.map((f) => (
            <option key={f} value={f}>
              {t(`publish.format.${f}`)}
            </option>
          ))}
        </select>
      </label>
      <div>
        <div>{t("publish.sheets")}</div>
        {layouts.length === 0 && <div style={{ color: "var(--muted)" }}>{t("layouts.tree.empty")}</div>}
        {layouts.map((l) => (
          <label key={l.id} style={{ display: "flex", gap: 5, alignItems: "center" }}>
            <input type="checkbox" checked={set.layoutIds.includes(l.id)} onChange={(e) => patch({ layoutIds: toggle(set.layoutIds, l.id, e.target.checked) })} />
            <span>{l.name}</span>
          </label>
        ))}
      </div>
      {pdf && snapshots.length > 0 && (
        <div>
          <div>{t("publish.views")}</div>
          {snapshots.map((v) => (
            <label key={v.id} style={{ display: "flex", gap: 5, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={(set.snapshotIds ?? []).includes(v.id)}
                onChange={(e) => patch({ snapshotIds: toggle(set.snapshotIds ?? [], v.id, e.target.checked) })}
              />
              <span>{v.name}</span>
            </label>
          ))}
        </div>
      )}
      <label style={{ display: "grid", gap: 2 }}>
        <span>{t("publish.pattern")}</span>
        <input
          className="res-input mono"
          value={set.namePattern ?? ""}
          placeholder={format === "pdf-single" ? DEFAULT_NAME_PATTERN : "{Satz}"}
          onChange={(e) => patch({ namePattern: e.target.value || undefined })}
        />
      </label>
      <div style={{ color: "var(--muted)" }}>{t("publish.pattern.hint")}</div>
      {pdf && (
        <div style={{ display: "flex", gap: 8 }}>
          <label style={{ display: "grid", gap: 2, flex: 1 }}>
            <span>{t("publish.paper")}</span>
            <select
              className="res-select"
              value={set.paperOverride ?? ""}
              onChange={(e) => patch({ paperOverride: (e.target.value || undefined) as LayoutPaperFormat | undefined })}
            >
              <option value="">{t("publish.keep")}</option>
              {PAPER_FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 2, flex: 1 }}>
            <span>{t("publish.scale")}</span>
            <input
              type="number"
              className="res-input mono num"
              min={1}
              placeholder={t("publish.keep")}
              value={set.scaleOverride ?? ""}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                patch({ scaleOverride: Number.isFinite(v) && v > 0 ? v : undefined });
              }}
            />
          </label>
        </div>
      )}
      <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
        <input type="checkbox" checked={set.includeRevision ?? true} onChange={(e) => patch({ includeRevision: e.target.checked })} />
        <span>{t("publish.includeRevision")}</span>
      </label>
      <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
        <input type="checkbox" checked={set.bumpRevision ?? false} onChange={(e) => patch({ bumpRevision: e.target.checked })} />
        <span>{t("publish.bumpRevision")}</span>
      </label>
      {pdf && (
        <label style={{ display: "flex", gap: 5, alignItems: "center" }}>
          <input type="checkbox" checked={set.pdfLayers ?? true} onChange={(e) => patch({ pdfLayers: e.target.checked })} />
          <span>{t("publish.pdfLayers")}</span>
        </label>
      )}
    </div>
  );
}

export function PublishSection() {
  const host = usePanelHost();
  const project = host.project;
  const sets = project.publishSets ?? [];
  const log = (project.publishLog ?? []).slice(-LOG_SHOWN).reverse();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <section data-publish-section>
      <header className="nav-group-head" style={{ marginTop: 6 }}>
        <span className="nav-group-title">{t("publish.title")}</span>
        <span className="nav-group-actions">
          <button className="nav-add" style={{ padding: "1px 5px" }} title={t("publish.add")} data-publish-add onClick={() => setOpen(host.onAddPublishSet())}>
            ＋
          </button>
        </span>
      </header>
      <label style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 10px", fontSize: 12 }}>
        <span>{t("publish.projectNumber")}</span>
        <input
          className="res-input mono"
          style={{ flex: 1 }}
          value={project.projectNumber ?? ""}
          onChange={(e) => host.onSetProjectNumber(e.target.value)}
        />
      </label>
      {sets.length === 0 && <div style={{ padding: "4px 10px 8px", fontSize: 12, color: "var(--muted)" }}>{t("publish.none")}</div>}
      {sets.map((s) => (
        <div key={s.id} data-publish-set={s.id}>
          <div className={`nav-row${open === s.id ? " active" : ""}`} style={{ display: "flex", alignItems: "center", gap: 4, paddingLeft: 10 }} onClick={() => setOpen(open === s.id ? null : s.id)}>
            <span className="nav-label" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {s.name}
              <span style={{ color: "var(--muted)", marginLeft: 6 }}>{s.layoutIds.length}</span>
            </span>
            <button
              className="nav-add"
              style={{ padding: "1px 6px", flex: "0 0 auto", whiteSpace: "nowrap" }}
              title={t("publish.run")}
              data-publish-run
              onClick={(e) => {
                e.stopPropagation();
                host.onPublishSet(s.id);
              }}
            >
              {t("publish.run")}
            </button>
            <button
              className="nav-add"
              style={{ padding: "1px 5px", flex: "0 0 auto" }}
              title={t("publish.delete")}
              onClick={(e) => {
                e.stopPropagation();
                host.onDeletePublishSet(s.id);
              }}
            >
              ✕
            </button>
          </div>
          {open === s.id && <SetEditor set={s} />}
        </div>
      ))}
      {log.length > 0 && (
        <div style={{ padding: "4px 10px 8px", fontSize: 11 }} data-publish-log>
          <div style={{ fontWeight: 600 }}>{t("publish.log")}</div>
          {log.map((e) => (
            <div key={e.id} style={{ color: "var(--muted)" }} title={e.sheets.map((s) => `${s.number} ${s.name} ${s.revision}`.trim()).join("\n")}>
              {e.date.slice(0, 16).replace("T", " ")} · {e.setName} · {e.sheets.length} {t("publish.sheetsShort")}
              {e.sheets.some((s) => s.revision) ? ` · ${t("layouts.revision.short")} ${[...new Set(e.sheets.map((s) => s.revision).filter(Boolean))].join("/")}` : ""}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// Kennzahlenleiste [62] und Raumprogramm-Editor [61] im Flächenbilanz-Panel.
//
//  • Leiste: GF, aGF, GV, AZ, ÜZ (live aus `computeKennzahlen`), darunter je Geschoss GF/aGF.
//  • Parzellenfläche: Eingabefeld → `Project.parcelArea` (leer/0 = aus der Parzellengrenze, sonst nicht gesetzt).
//  • Raumprogramm: Soll-Zeilen (Name, Fläche je Raum, Anzahl) bearbeiten; der Status je Zeile
//    kommt aus `checkRoomProgram`.
// Änderungen laufen über `setProject` mit coalesceKey, damit Tippen einen Undo-Schritt ergibt.

import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { usePanelHost } from "./host";
import { useStore } from "../state/appStore";
import { checkRoomProgram, computeKennzahlen, polygonArea } from "../core";
import type { Project, RoomProgramRow } from "../model/types";
import { RoomProgramImportButton } from "../ui/RoomProgramImportDialog";

type ProgramStatus = ReturnType<typeof checkRoomProgram>["rows"][number]["status"];

const STATUS_KEY: Record<ProgramStatus, TranslationKey> = {
  ok: "program.status.ok",
  "zu klein": "program.status.tooSmall",
  "zu gross": "program.status.tooLarge",
  fehlt: "program.status.missing",
  "zu wenige": "program.status.tooFew",
  "zu viele": "program.status.tooMany",
};

/** Übersetzter Status einer Raumprogramm-Zeile (auch für den Menü-Toast). */
export function programStatusLabel(status: ProgramStatus): string {
  return t(STATUS_KEY[status]);
}

/** Zahl aus einer Eingabe (Komma oder Punkt); leer/ungültig → null. */
function parseNum(text: string): number | null {
  const v = Number(text.trim().replace(",", "."));
  return text.trim() !== "" && Number.isFinite(v) ? v : null;
}

const fmt = (n: number, d = 1) => n.toLocaleString("de-CH", { minimumFractionDigits: d, maximumFractionDigits: d });

export function KennzahlenSection() {
  const host = usePanelHost();
  const setProject = useStore((s) => s.setProject);
  const notify = useStore((s) => s.notify);
  const project = host.project;
  const k = computeKennzahlen(project);
  const prog = checkRoomProgram(project);
  const rows = project.roomProgram ?? [];

  const setParcel = (text: string) => {
    const v = parseNum(text);
    setProject((p: Project) => {
      const { parcelArea: _old, ...rest } = p;
      return v !== null && v > 0 ? { ...rest, parcelArea: v } : rest;
    }, "parcelArea");
  };
  const patchRow = (i: number, patch: Partial<RoomProgramRow>, field: string) =>
    setProject(
      (p: Project) => ({ ...p, roomProgram: (p.roomProgram ?? []).map((r, j) => (j === i ? { ...r, ...patch } : r)) }),
      `roomProgram:${i}:${field}`,
    );
  const addRow = () => setProject((p: Project) => ({ ...p, roomProgram: [...(p.roomProgram ?? []), { name: "", area: 20, count: 1 }] }));
  const removeRow = (i: number) =>
    setProject((p: Project) => {
      const next = (p.roomProgram ?? []).filter((_, j) => j !== i);
      const { roomProgram: _old, ...rest } = p;
      return next.length > 0 ? { ...rest, roomProgram: next } : rest;
    });

  const tiles: { label: string; value: string; title: TranslationKey }[] = [
    { label: "GF", value: `${fmt(k.gf)} m²`, title: "kennzahlen.gf" },
    { label: "aGF", value: `${fmt(k.agf)} m²`, title: "kennzahlen.agf" },
    { label: "GV", value: `${fmt(k.gv, 0)} m³`, title: "kennzahlen.gv" },
    { label: "AZ", value: k.az === null ? "–" : fmt(k.az, 2), title: "kennzahlen.az" },
    { label: "ÜZ", value: k.uez === null ? "–" : fmt(k.uez, 2), title: "kennzahlen.uez" },
  ];

  return (
    <div className="kz-section">
      <div className="kz-bar">
        {tiles.map((tile) => (
          <div key={tile.label} className="kz-tile" title={t(tile.title)}>
            <span className="kz-tile-label">{tile.label}</span>
            <span className="kz-tile-value">{tile.value}</span>
          </div>
        ))}
      </div>

      <label className="kz-parcel">
        <span>{t("kennzahlen.parcelArea")}</span>
        <input
          type="number"
          min={0}
          step={1}
          className="kz-input kz-num"
          value={project.parcelArea !== undefined ? String(project.parcelArea) : ""}
          placeholder={project.siteRules?.parcel && project.siteRules.parcel.length >= 3 ? fmt(polygonArea(project.siteRules.parcel)) : "–"}
          title={t("kennzahlen.parcelArea.hint")}
          onChange={(e) => setParcel(e.target.value)}
        />
        <span>m²</span>
      </label>

      {k.levels.length > 0 && (
        <div className="balance-table">
          {k.levels.map((l) => (
            <div key={l.levelId} className="balance-row">
              <span className="balance-name">{l.name}</span>
              <span className="balance-count">aGF {fmt(l.agf)}</span>
              <span className="balance-area">GF {fmt(l.gf)} m²</span>
            </div>
          ))}
        </div>
      )}

      <div className="balance-section-label">{t("program.title")}</div>
      {rows.length > 0 && (
        <div className="kz-program">
          <div className="kz-program-row kz-program-head">
            <span>{t("program.name")}</span>
            <span>{t("program.area")}</span>
            <span>{t("program.count")}</span>
            <span>{t("program.field.group")}</span>
            <span>{t("program.status")}</span>
            <span />
          </div>
          {rows.map((row, i) => {
            const res = prog.rows[i];
            return (
              <div key={i} className="kz-program-row">
                <input
                  type="text"
                  className="kz-input"
                  value={row.name}
                  placeholder={t("program.namePlaceholder")}
                  onChange={(e) => patchRow(i, { name: e.target.value }, "name")}
                />
                <input
                  type="number"
                  className="kz-input kz-num"
                  min={0}
                  step={0.5}
                  value={row.area}
                  onChange={(e) => {
                    const v = parseNum(e.target.value);
                    if (v !== null && v >= 0) patchRow(i, { area: v }, "area");
                  }}
                />
                <input
                  type="number"
                  className="kz-input kz-num"
                  min={1}
                  step={1}
                  value={row.count ?? 1}
                  onChange={(e) => {
                    const v = parseNum(e.target.value);
                    if (v !== null && v >= 1) patchRow(i, { count: Math.round(v) }, "count");
                  }}
                />
                <input
                  type="text"
                  className="kz-input"
                  value={row.group ?? ""}
                  onChange={(e) => patchRow(i, { group: e.target.value === "" ? undefined : e.target.value }, "group")}
                />
                <span
                  className={"kz-status" + (res?.status === "ok" ? " ok" : " bad")}
                  title={res ? t("program.actual", { count: res.count, area: fmt(res.area) }) : undefined}
                >
                  {res ? programStatusLabel(res.status) : ""}
                </span>
                <button type="button" className="site-remove" title={t("program.remove")} aria-label={t("program.remove")} onClick={() => removeRow(i)}>
                  ×
                </button>
              </div>
            );
          })}
        </div>
      )}
      <div className="kz-program-actions">
        <button type="button" className="kz-add" onClick={addRow}>
          {t("program.add")}
        </button>
        <RoomProgramImportButton project={project} onApply={(fn) => setProject(fn)} notify={notify} />
      </div>
      {rows.length > 0 && prog.extra.length > 0 && (
        <div className="kz-extra" title={prog.extra.map((r) => r.name).join(", ")}>
          {t("program.extra", { n: prog.extra.length })}
        </div>
      )}
    </div>
  );
}

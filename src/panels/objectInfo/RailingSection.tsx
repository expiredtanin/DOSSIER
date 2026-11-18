// Abschnitt „Geländer" der Objekt-Info ([279]): Art (Stäbe, Glas, Brüstung, Lochblech), Höhe (Vorgabe 1.00 m nach
// SIA 358), Fusshöhe über dem Geschoss (z. B. auf einer Balkonplatte), Handlauf, Stababstand/-querschnitt, Dicke und
// Bauteil der Brüstung. Kennzahlen (Länge, Stäbe, Pfosten) rechnet der Kern (`analysis/railingInfo.ts`). Jede Änderung
// ist ein Undo-Schritt (der Kern prüft die Op); bei mehreren gewählten Geländern wirken die Felder auf alle.
//
// Gerufen von `ObjectInfoPanel`.

import { useMemo } from "react";
import type { Railing, RailingKind } from "../../model/types";
import { useStore } from "../../state/appStore";
import { t, type TranslationKey } from "../../i18n";
import { patchItem } from "../../core";
import { Dropdown } from "../../ui/Dropdown";
import { railingInfo } from "../../analysis/railingInfo";
import { DimensionField } from "./fields";

const KINDS: RailingKind[] = ["bars", "glass", "solid", "perforated"];
/** Vorgabe des Handlaufs je Art, wenn nichts angegeben ist (Kern `railing::has_handrail`). */
const handrailDefault = (kind: RailingKind): boolean => kind === "bars" || kind === "glass";

export function RailingSection({ ids }: { ids: readonly string[] }) {
  const project = useStore((st) => st.project);
  const applyChange = useStore((s) => s.applyChange);
  const list = (project.railings ?? []).filter((x) => ids.includes(x.id));
  const rail = list[0];
  const info = useMemo(() => (rail ? railingInfo(project, rail.id) : null), [project, rail]);
  if (!rail) return <div className="objinfo-panel"><div className="objinfo-empty">{t("objinfo.empty")}</div></div>;
  const locked = !!rail.locked;
  const set = (patch: Partial<Railing>, all = false) =>
    applyChange((p) => (all ? list : [rail]).filter((x) => !x.locked).flatMap((x) => patchItem(p, "railings", x.id, patch)));
  const level = project.drawingLevels.find((l) => l.id === rail.floorId);
  const handrail = rail.handrail ?? handrailDefault(rail.kind);
  const bars = rail.kind === "bars";
  const panel = rail.kind === "glass" || rail.kind === "solid" || rail.kind === "perforated";
  const dflt = rail.kind === "glass" ? 0.02 : rail.kind === "solid" ? 0.15 : 0.004;
  return (
    <div className="objinfo-panel objinfo-railing">
      <div className="objinfo-head">
        <span className="objinfo-kind">{list.length > 1 ? t("objinfo.railing.many", { n: list.length }) : t("objinfo.kind.railing")}</span>
      </div>
      <div className="objinfo-section-label">{t("objinfo.railing.section")}</div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.railing.kind")}</span>
        <Dropdown
          value={rail.kind}
          onChange={(v) => set({ kind: v as RailingKind }, true)}
          options={KINDS.map((v) => ({ value: v, label: t(`objinfo.railing.kind.${v}` as TranslationKey) }))}
          title={t("objinfo.railing.kind")}
          width={150}
        />
      </div>
      <div title={t("objinfo.railing.heightHint")}>
        <DimensionField label={t("objinfo.railing.height")} value={rail.height} min={0.1} onCommit={(v) => set({ height: v }, true)} />
      </div>
      <div title={t("objinfo.railing.baseOffsetHint")}>
        <DimensionField label={t("objinfo.railing.baseOffset")} value={rail.baseOffset ?? 0} min={-Infinity} onCommit={(v) => set({ baseOffset: v === 0 ? undefined : v }, true)} />
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.railing.handrail")}</span>
        <input type="checkbox" checked={handrail} disabled={locked} onChange={(e) => set({ handrail: e.target.checked }, true)} data-testid="railing-handrail" />
      </div>
      {handrail && <DimensionField label={t("objinfo.railing.handrailSize")} value={rail.handrailSize ?? 0.04} min={0.02} onCommit={(v) => set({ handrailSize: v })} />}
      {bars && <DimensionField label={t("objinfo.railing.barSpacing")} value={rail.barSpacing ?? 0.12} min={0.03} onCommit={(v) => set({ barSpacing: v })} />}
      {bars && <DimensionField label={t("objinfo.railing.barSize")} value={rail.barSize ?? 0.014} min={0.004} onCommit={(v) => set({ barSize: v })} />}
      {panel && <DimensionField label={t("objinfo.railing.thickness")} value={rail.thickness ?? dflt} min={0.002} onCommit={(v) => set({ thickness: v })} />}
      {rail.kind === "solid" && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.railing.component")}</span>
          <Dropdown
            value={rail.componentId ?? ""}
            onChange={(v) => set({ componentId: v || undefined })}
            options={[{ value: "", label: t("objinfo.railing.componentNone") }, ...project.components.map((c) => ({ value: c.id, label: c.name }))]}
            title={t("objinfo.railing.component")}
            width={150}
          />
        </div>
      )}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.railing.closed")}</span>
        <input type="checkbox" checked={rail.closed === true} disabled={locked || rail.points.length < 3} onChange={(e) => set({ closed: e.target.checked || undefined })} data-testid="railing-closed" />
      </div>
      {info && (
        <>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.railing.length")}</span>
            <span className="objinfo-fval" data-testid="railing-length">{info.length.toFixed(2)} m</span>
          </div>
          {bars && (
            <div className="objinfo-field">
              <span className="objinfo-flabel">{t("objinfo.railing.counts")}</span>
              <span className="objinfo-fval">{info.bars} / {info.posts}</span>
            </div>
          )}
        </>
      )}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.column.floor")}</span>
        <span className="objinfo-fval">{level?.name ?? rail.floorId}</span>
      </div>
      {locked && <div className="objinfo-muted">{t("objinfo.railing.locked")}</div>}
    </div>
  );
}

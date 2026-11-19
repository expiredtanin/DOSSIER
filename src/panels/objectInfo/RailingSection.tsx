// Abschnitt „Geländer" der Objekt-Info ([279]): Art (Stäbe, Glas, Brüstung, Lochblech), Höhe (Vorgabe 1.00 m nach
// SIA 358), Fusshöhe über dem Geschoss (z. B. auf einer Balkonplatte), Handlauf, Stababstand/-querschnitt, Dicke und
// Bauteil der Brüstung. [291] Aufbau je Feld: Pfosten (an/aus, grösster Abstand, Querschnitt), Handlauf (Profil, Höhe),
// Zwischenholme, Füllung je Feld; Bindung an Treppe (Seite) oder Deckenkante (Kante, Anzahl, Abstand) und „Lösen“ (die
// aufgelöste Achse wird zur freien Polylinie). Kennzahlen (Länge, Felder, Stäbe, Pfosten) rechnet der Kern
// (`analysis/railingInfo.ts`). Jede Änderung ist ein Undo-Schritt (der Kern prüft die Op); bei mehreren gewählten
// Geländern wirken die Felder auf alle.
//
// Gerufen von `ObjectInfoPanel`.

import { useMemo, useState } from "react";
import type { Railing, RailingField, RailingKind, RailingProfile, RailingSide } from "../../model/types";
import { useStore } from "../../state/appStore";
import { t, type TranslationKey } from "../../i18n";
import { patchItem } from "../../core";
import { Dropdown } from "../../ui/Dropdown";
import { railingInfo } from "../../analysis/railingInfo";
import { DimensionField } from "./fields";

const KINDS: RailingKind[] = ["bars", "glass", "solid", "perforated"];
/** Vorgabe des Handlaufs je Art, wenn nichts angegeben ist (Kern `railing::has_handrail`). */
const handrailDefault = (kind: RailingKind): boolean => kind === "bars" || kind === "glass";
/** [291] Vorgabe der Pfosten je Art (Kern `railing::has_posts`). */
const postsDefault = (kind: RailingKind): boolean => kind === "bars";
const PROFILES: RailingProfile[] = ["rect", "round"];
const SIDES: RailingSide[] = ["left", "right"];

export function RailingSection({ ids }: { ids: readonly string[] }) {
  const project = useStore((st) => st.project);
  const applyChange = useStore((s) => s.applyChange);
  const list = (project.railings ?? []).filter((x) => ids.includes(x.id));
  const rail = list[0];
  const info = useMemo(() => (rail ? railingInfo(project, rail.id) : null), [project, rail]);
  const [fieldNo, setFieldNo] = useState(0);
  if (!rail) return <div className="objinfo-panel"><div className="objinfo-empty">{t("objinfo.empty")}</div></div>;
  const locked = !!rail.locked;
  const set = (patch: Partial<Railing>, all = false) =>
    applyChange((p) => (all ? list : [rail]).filter((x) => !x.locked).flatMap((x) => patchItem(p, "railings", x.id, patch)));
  const level = project.drawingLevels.find((l) => l.id === rail.floorId);
  const handrail = rail.handrail ?? handrailDefault(rail.kind);
  const bars = rail.kind === "bars";
  const panel = rail.kind === "glass" || rail.kind === "solid" || rail.kind === "perforated";
  const dflt = rail.kind === "glass" ? 0.02 : rail.kind === "solid" ? 0.15 : 0.004;
  const posts = rail.posts ?? postsDefault(rail.kind);
  const stair = rail.stairId ? (project.stairs ?? []).find((x) => x.id === rail.stairId) : undefined;
  const ceiling = rail.ceilingId ? (project.ceilings ?? []).find((x) => x.id === rail.ceilingId) : undefined;
  const fieldKind = (rail.fields ?? []).find((f) => f.index === fieldNo)?.kind ?? "";
  const setFieldKind = (k: string) => {
    const rest: RailingField[] = (rail.fields ?? []).filter((f) => f.index !== fieldNo);
    const next = k ? [...rest, { index: fieldNo, kind: k as RailingKind }].sort((a, b) => a.index - b.index) : rest;
    set({ fields: next.length ? next : undefined });
  };
  // Lösen: die aufgelöste Achse (Kern) bleibt als freie Polylinie; ohne Kern-Achse die gespeicherten Punkte.
  const unbind = () => {
    const axis = info?.axis.map(([x, y]) => ({ x, y }));
    const closed = axis && axis.length >= 4 && Math.hypot(axis[0].x - axis[axis.length - 1].x, axis[0].y - axis[axis.length - 1].y) < 1e-6;
    set({
      stairId: undefined, stairSide: undefined, ceilingId: undefined, edgeIndex: undefined, edgeCount: undefined, edgeInset: undefined,
      ...(axis && axis.length >= 2 ? { points: closed ? axis.slice(0, -1) : axis, closed: closed || undefined } : {}),
    });
  };
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
      {handrail && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.railing.handrailProfile")}</span>
          <Dropdown
            value={rail.handrailProfile ?? "rect"}
            onChange={(v) => set({ handrailProfile: v === "rect" ? undefined : (v as RailingProfile) }, true)}
            options={PROFILES.map((v) => ({ value: v, label: t(`objinfo.railing.profile.${v}` as TranslationKey) }))}
            title={t("objinfo.railing.handrailProfile")}
            width={150}
          />
        </div>
      )}
      {handrail && <DimensionField label={t("objinfo.railing.handrailHeight")} value={rail.handrailHeight ?? rail.height} min={0.1} onCommit={(v) => set({ handrailHeight: Math.abs(v - rail.height) < 1e-9 ? undefined : v }, true)} />}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.railing.posts")}</span>
        <input type="checkbox" checked={posts} disabled={locked} onChange={(e) => set({ posts: e.target.checked }, true)} data-testid="railing-posts" />
      </div>
      {posts && <DimensionField label={t("objinfo.railing.postSpacing")} value={rail.postSpacing ?? 1.2} min={0.2} onCommit={(v) => set({ postSpacing: v }, true)} />}
      {posts && <DimensionField label={t("objinfo.railing.postSize")} value={rail.postSize ?? 0.03} min={0.01} onCommit={(v) => set({ postSize: v }, true)} />}
      <DimensionField label={t("objinfo.railing.midRails")} value={rail.midRails ?? 0} min={0} unit="" step={1} digits={0} onCommit={(v) => set({ midRails: Math.round(v) > 0 ? Math.min(20, Math.round(v)) : undefined }, true)} />
      <DimensionField label={t("objinfo.railing.fieldNo")} value={fieldNo} min={0} unit="" step={1} digits={0} onCommit={(v) => setFieldNo(Math.max(0, Math.round(v)))} />
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.railing.fieldKind")}</span>
        <Dropdown
          value={fieldKind}
          onChange={setFieldKind}
          options={[{ value: "", label: t("objinfo.railing.fieldKindDefault") }, ...KINDS.map((v) => ({ value: v, label: t(`objinfo.railing.kind.${v}` as TranslationKey) }))]}
          title={t("objinfo.railing.fieldKind")}
          width={150}
        />
      </div>
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
      {(rail.stairId || rail.ceilingId) && <div className="objinfo-section-label">{t("objinfo.railing.bound")}</div>}
      {rail.stairId && (
        <>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.railing.bound.stair")}</span>
            <span className="objinfo-fval" data-testid="railing-bound">{stair ? stair.id : t("objinfo.railing.boundMissing")}</span>
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.railing.stairSide")}</span>
            <Dropdown
              value={rail.stairSide ?? "left"}
              onChange={(v) => set({ stairSide: v as RailingSide })}
              options={SIDES.map((v) => ({ value: v, label: t(`objinfo.railing.side.${v}` as TranslationKey) }))}
              title={t("objinfo.railing.stairSide")}
              width={150}
            />
          </div>
        </>
      )}
      {rail.ceilingId && (
        <>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.railing.bound.edge")}</span>
            <span className="objinfo-fval" data-testid="railing-bound">{ceiling ? ceiling.id : t("objinfo.railing.boundMissing")}</span>
          </div>
          <DimensionField label={t("objinfo.railing.edgeIndex")} value={rail.edgeIndex ?? 0} min={0} unit="" step={1} digits={0} onCommit={(v) => set({ edgeIndex: Math.max(0, Math.round(v)) })} />
          <DimensionField label={t("objinfo.railing.edgeCount")} value={rail.edgeCount ?? 1} min={1} unit="" step={1} digits={0} onCommit={(v) => set({ edgeCount: Math.round(v) > 1 ? Math.round(v) : undefined })} />
          <DimensionField label={t("objinfo.railing.edgeInset")} value={rail.edgeInset ?? 0.05} min={-1} onCommit={(v) => set({ edgeInset: v })} />
        </>
      )}
      {(rail.stairId || rail.ceilingId) && (
        <button type="button" className="objinfo-btn" disabled={locked} onClick={unbind} title={t("objinfo.railing.unbindHint")} data-testid="railing-unbind">
          {t("objinfo.railing.unbind")}
        </button>
      )}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.railing.closed")}</span>
        <input type="checkbox" checked={rail.closed === true} disabled={locked || rail.points.length < 3 || !!rail.stairId || !!rail.ceilingId} onChange={(e) => set({ closed: e.target.checked || undefined })} data-testid="railing-closed" />
      </div>
      {info && (
        <>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.railing.length")}</span>
            <span className="objinfo-fval" data-testid="railing-length">{info.length.toFixed(2)} m</span>
          </div>
          {(bars || posts) && (
            <div className="objinfo-field">
              <span className="objinfo-flabel">{t("objinfo.railing.counts")}</span>
              <span className="objinfo-fval">{info.bars} / {info.posts}</span>
            </div>
          )}
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.railing.fields")}</span>
            <span className="objinfo-fval" data-testid="railing-fields">{info.fields}</span>
          </div>
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

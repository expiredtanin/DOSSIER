// Ressourcen-Tab „Modelldarstellung" ([173]): eigene Stufen der Darstellung anlegen, duplizieren, umbenennen,
// löschen und je Bauteilart einstellen (jede Option „wie Basis" oder ein Wert). Die eingebauten Stufen
// grob/mittel/fein stehen oben (nur lesend, duplizierbar); darunter die mitgelieferten Vorlagen, die dem Projekt
// fehlen (Kern `standards.rs::model_views`; „+" übernimmt sie mit Standard-Kennung). Logik und Ops: `state/modelViews.ts`; Handler aus
// der App, ein Aufruf = ein Undo-Schritt. Wirkung und Rangfolge: Kern `plan/model_view.rs`.

import { useEffect, useMemo, useRef, useState } from "react";
import type { ModelViewOption, Project } from "../../model/types";
import type { DetailLevel } from "../../model/viewTypes";
import { t } from "../../i18n";
import { standardModelViews } from "../../core";
import type { TranslationKey } from "../../i18n/de";
import {
  BUILTIN_MODEL_VIEWS,
  fieldValue,
  isBuiltinModelView,
  MODEL_VIEW_FIELDS,
  parseFieldValue,
  type ModelViewField,
  type ModelViewSection,
} from "../../state/modelViews";
import { DeleteButton, FieldRow } from "./fields";

export interface ModelViewHandlers {
  onAddModelView?: () => void;
  /** Kopie (auch einer eingebauten Stufe: wird zur eigenen mit deren Basis). */
  onDuplicateModelView?: (id: string) => void;
  /** Vorlage aus der Bibliothek ins Projekt übernehmen (Standard-Kennung bleibt). */
  onAdoptModelView?: (mv: ModelViewOption) => void;
  onRenameModelView?: (id: string, name: string) => void;
  onDeleteModelView?: (id: string) => void;
  /** `null` = Detailgrad der Ansicht. */
  onSetModelViewBase?: (id: string, base: DetailLevel | null) => void;
  /** `null` = „wie Basis". */
  onSetModelViewOption?: (id: string, section: ModelViewSection, key: string, value: string | number | boolean | null) => void;
}

const SECTIONS: ModelViewSection[] = ["doors", "windows", "stairs", "walls", "slabs", "roofs", "columns", "elevation", "site", "sectionMarks", "roomStamps", "dimensions"];

/** Anzeige eines Auswahlwerts (Zahlen mit Einheit, Rest übersetzt). */
function valueLabel(f: ModelViewField, v: string | number): string {
  if (typeof v === "number") return f.key === "swingAngle" ? `${v}°` : `${v} mm`;
  return t(`resources.modelViews.val.${v}` as TranslationKey);
}

function OptionRow({ mv, f, h }: { mv: ModelViewOption; f: ModelViewField; h: ModelViewHandlers }) {
  const label = t(`resources.modelViews.opt.${f.section}.${f.key}` as TranslationKey);
  const values: (string | number)[] = f.values === "bool" ? ["true", "false"] : f.values === "number" ? [] : [...f.values];
  return (
    <FieldRow label={label}>
      <select
        className="res-input"
        aria-label={label}
        title={f.detailChoice ? t("resources.modelViews.tip.sectionDetail") : undefined}
        data-testid={`model-view-opt-${f.section}-${f.key}`}
        value={fieldValue(mv, f)}
        disabled={!h.onSetModelViewOption}
        onChange={(e) => {
          const v = parseFieldValue(f, e.target.value);
          h.onSetModelViewOption?.(mv.id, f.section, f.key, v === undefined ? null : (v as string | number | boolean));
        }}
      >
        <option value="">{t(f.detailChoice ? "resources.modelViews.asDetail" : "resources.modelViews.asBase")}</option>
        {values.map((v) => (
          <option key={String(v)} value={String(v)}>
            {f.values === "bool"
              ? t(
                  f.detailChoice
                    ? v === "true" ? "resources.modelViews.detail.full" : "resources.modelViews.detail.simple"
                    : v === "true" ? "resources.modelViews.on" : "resources.modelViews.off",
                )
              : valueLabel(f, v)}
          </option>
        ))}
      </select>
    </FieldRow>
  );
}

function ModelViewDetail({ mv, h }: { mv: ModelViewOption; h: ModelViewHandlers }) {
  return (
    <div className="res-detail" data-testid="model-view-detail">
      <FieldRow label={t("resources.modelViews.name")}>
        <input
          className="res-input"
          aria-label={t("resources.modelViews.name")}
          value={mv.name}
          readOnly={!h.onRenameModelView}
          onChange={(e) => h.onRenameModelView?.(mv.id, e.target.value)}
        />
      </FieldRow>
      <FieldRow label={t("resources.modelViews.base")}>
        <select
          className="res-input"
          aria-label={t("resources.modelViews.base")}
          disabled={!h.onSetModelViewBase}
          value={mv.baseDetail ?? ""}
          onChange={(e) => h.onSetModelViewBase?.(mv.id, e.target.value === "" ? null : (e.target.value as DetailLevel))}
        >
          <option value="">{t("resources.modelViews.base.view")}</option>
          {BUILTIN_MODEL_VIEWS.map((d) => (
            <option key={d} value={d}>
              {t(`topbar.detail.${d}`)}
            </option>
          ))}
        </select>
      </FieldRow>
      {SECTIONS.map((s) => (
        <div key={s} className="res-mv-section" data-testid={`model-view-section-${s}`}>
          <div className="res-hint">{t(`resources.modelViews.section.${s}`)}</div>
          {s === "roomStamps" && <div className="res-hint">{t("resources.modelViews.stampHint")}</div>}
          {MODEL_VIEW_FIELDS.filter((f) => f.section === s).map((f) => (
            <OptionRow key={f.key} mv={mv} f={f} h={h} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function ModelViewsTab({ project, handlers }: { project: Project; handlers: ModelViewHandlers }) {
  const list = project.modelViewOptions ?? [];
  // [173] Mitgelieferte Stufen, die dem Projekt fehlen (nur lesend; übernehmen = ins Projekt kopieren).
  const library = useMemo(() => standardModelViews(project), [project]);
  const [selectedId, setSelectedId] = useState<string>("mittel");
  // Neue bzw. duplizierte Stufe gleich auswählen (die Liste wächst um sie).
  const prevIds = useRef(list.map((m) => m.id));
  useEffect(() => {
    const added = list.find((m) => !prevIds.current.includes(m.id));
    prevIds.current = list.map((m) => m.id);
    if (added) setSelectedId(added.id);
  }, [list]);
  const selected = list.find((x) => x.id === selectedId);
  const template = selected ? undefined : library.find((x) => x.id === selectedId);
  const activeId = selected ? selected.id : template ? template.id : isBuiltinModelView(selectedId) ? selectedId : "mittel";
  const row = (id: string, name: string, own: boolean) => (
    <div
      key={id}
      role="button"
      tabIndex={0}
      data-testid="model-view-row"
      className={`res-md-row${activeId === id ? " active" : ""}`}
      style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
      onClick={() => setSelectedId(id)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") setSelectedId(id);
      }}
    >
      <span className="res-md-row-name" style={{ flex: 1, opacity: own ? 1 : 0.75 }}>
        {name}
      </span>
      <button
        type="button"
        className="res-layer-btn"
        title={t("resources.modelViews.duplicate")}
        data-testid="model-view-duplicate"
        onClick={(e) => {
          e.stopPropagation();
          handlers.onDuplicateModelView?.(id);
        }}
      >
        ⧉
      </button>
      {own && <DeleteButton title={t("resources.modelViews.delete")} onClick={() => handlers.onDeleteModelView?.(id)} />}
    </div>
  );
  return (
    <div className="res-tab">
      <div className="res-hint">{t("resources.modelViews.hint")}</div>
      <div className="res-md">
        <div className="res-md-list">
          {BUILTIN_MODEL_VIEWS.map((d) => row(d, t(`topbar.detail.${d}`), false))}
          {list.map((m) => row(m.id, m.name, true))}
          {library.length > 0 && <div className="res-hint">{t("resources.modelViews.library")}</div>}
          {library.map((m) => (
            <div
              key={m.id}
              role="button"
              tabIndex={0}
              data-testid="model-view-template"
              className={`res-md-row${activeId === m.id ? " active" : ""}`}
              style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}
              onClick={() => setSelectedId(m.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") setSelectedId(m.id);
              }}
            >
              <span className="res-md-row-name" style={{ flex: 1, opacity: 0.75 }}>
                {m.name}
              </span>
              <button
                type="button"
                className="res-layer-btn"
                title={t("resources.modelViews.adopt")}
                data-testid="model-view-adopt"
                disabled={!handlers.onAdoptModelView}
                onClick={(e) => {
                  e.stopPropagation();
                  handlers.onAdoptModelView?.(m);
                }}
              >
                +
              </button>
            </div>
          ))}
          <div className="res-md-listfoot">
            <button className="res-add" data-testid="model-view-add" onClick={() => handlers.onAddModelView?.()} disabled={!handlers.onAddModelView}>
              <span className="res-add-plus">+</span> {t("resources.modelViews.add")}
            </button>
          </div>
        </div>
        <div className="res-md-detail">
          {selected ? (
            <ModelViewDetail key={selected.id} mv={selected} h={handlers} />
          ) : template ? (
            <>
              <div className="res-hint">{t("resources.modelViews.libraryRow")}</div>
              <ModelViewDetail key={template.id} mv={template} h={{}} />
            </>
          ) : (
            <div className="res-md-empty">{t("resources.modelViews.builtin")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

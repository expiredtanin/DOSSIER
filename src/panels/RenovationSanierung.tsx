// [274] Umbau-Panel, Abschnitt „Sanierung“: Typ-Paare Bestandstyp → Sanierungstyp mit Zählern, „Alle Wände vom Typ
// sanieren“ (ein Undo-Schritt), „Sanierungstyp anlegen …“ (Kopie des Bestandstyps) und der Typ-Paar-Editor: Alt und Neu
// nebeneinander, Zuordnung je Schicht (automatisch oder manuell), Bezugsseite, Ergebnis-Streifen mit SIA-Farben.
// Die Regeln (Zuordnung, Teilstücke) rechnet der Kern (`renovation::build_up`); gespeichert wird am Bestandstyp.

import { useState } from "react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { useStore } from "../state/appStore";
import {
  createRenovationTypeOps,
  renovateAllOfTypeOps,
  renovationPair,
  renovationPairs,
  setTypePairOps,
} from "../core";
import type { LayerRenovation, Project, RenovationSide } from "../model/types";
import { RenovationStrip } from "../ui/RenovationStrip";
import { usePanelHostAction } from "./host";

function PairEditor({ project, typeId }: { project: Project; typeId: string }) {
  const applyChange = useStore((s) => s.applyChange);
  const openResources = usePanelHostAction("onOpenResources");
  const wt = project.wallTypes.find((x) => x.id === typeId);
  const pair = renovationPair(project, typeId);
  if (!wt || !pair) return null;
  const oldOv = wt.renovationOld ?? [];
  const newOv = wt.renovationNew ?? [];
  const setOv = (which: "old" | "new", i: number, v: LayerRenovation) => {
    const n = which === "old" ? wt.layers.length : (project.wallTypes.find((x) => x.id === pair.target)?.layers.length ?? 0);
    const cur = [...(which === "old" ? oldOv : newOv)];
    while (cur.length < n) cur.push("auto");
    cur[i] = v;
    applyChange((p) => setTypePairOps(p, typeId, which === "old" ? { old: cur } : { new: cur }));
  };
  const layerRow = (which: "old" | "new", l: (typeof pair.old)[number], i: number) => {
    const ov = (which === "old" ? oldOv : newOv)[i] ?? "auto";
    const choices: LayerRenovation[] = which === "old" ? ["auto", "existing", "demolish"] : ["auto", "existing", "new"];
    return (
      <div className="reno-pair-layer" key={i} data-testid={`reno-pair-${which}-layer`} data-fate={l.fate}>
        <span className="reno-swatch" style={{ background: l.color }} aria-hidden="true" />
        <span className="reno-pair-name" title={l.name}>
          {l.name}
        </span>
        <span className="reno-pair-cm">{(l.thickness * 100).toFixed(1)}</span>
        <select
          value={ov}
          data-testid={`reno-pair-${which}-fate`}
          aria-label={l.name}
          className={`reno-fate is-${l.fate}`}
          onChange={(e) => setOv(which, i, e.target.value as LayerRenovation)}
        >
          {choices.map((c) => (
            <option key={c} value={c}>
              {c === "auto" ? `${t("renovation.fate.auto")} (${t(`renovation.fate.${l.fate}` as TranslationKey)})` : t(`renovation.fate.${c === "existing" ? "kept" : c}` as TranslationKey)}
            </option>
          ))}
        </select>
      </div>
    );
  };
  return (
    <div className="reno-pair-editor" data-testid="reno-pair-editor">
      <label className="reno-field">
        <span>{t("renovation.panel.sanierung.target")}</span>
        <select value={pair.target} data-testid="reno-pair-target" onChange={(e) => applyChange((p) => setTypePairOps(p, typeId, { target: e.target.value, old: null, new: null }))}>
          {project.wallTypes
            .filter((x) => x.id !== typeId)
            .map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
        </select>
      </label>
      <label className="reno-field">
        <span>{t("renovation.panel.sanierung.side")}</span>
        <select value={pair.side} data-testid="reno-pair-side" onChange={(e) => applyChange((p) => setTypePairOps(p, typeId, { side: e.target.value as RenovationSide }))}>
          <option value="inside">{t("renovation.panel.sanierung.side.inside")}</option>
          <option value="outside">{t("renovation.panel.sanierung.side.outside")}</option>
        </select>
      </label>
      <div className="reno-pair-cols">
        <div className="reno-pair-col">
          <div className="reno-head sub">{t("renovation.panel.sanierung.oldLayers")}</div>
          {pair.old.map((l, i) => layerRow("old", l, i))}
        </div>
        <div className="reno-pair-col">
          <div className="reno-head sub">{t("renovation.panel.sanierung.newLayers")}</div>
          {pair.new.map((l, i) => layerRow("new", l, i))}
        </div>
      </div>
      <RenovationStrip pair={pair} width={170} />
      <div className="reno-select-by">
        <button type="button" className="reno-link-btn" data-testid="reno-pair-reset" onClick={() => applyChange((p) => setTypePairOps(p, typeId, { old: null, new: null }))}>
          {t("renovation.panel.sanierung.reset")}
        </button>
        <button type="button" className="reno-link-btn" onClick={() => openResources("wallStyles")}>
          {t("renovation.panel.sanierung.editLayers")}
        </button>
        <button type="button" className="reno-link-btn" data-testid="reno-pair-remove" onClick={() => applyChange((p) => setTypePairOps(p, typeId, { target: null, old: null, new: null, side: null }))}>
          {t("renovation.panel.sanierung.remove")}
        </button>
      </div>
    </div>
  );
}

export function RenovationSanierung({ project }: { project: Project }) {
  const applyChange = useStore((s) => s.applyChange);
  const info = renovationPairs(project);
  const [open, setOpen] = useState<string | null>(null);
  const targets = new Set(info.pairs.map((x) => x.target));
  const candidates = project.wallTypes.filter((x) => !x.renovationTarget && !targets.has(x.id));
  const [pick, setPick] = useState("");
  const pickId = candidates.some((x) => x.id === pick) ? pick : (candidates[0]?.id ?? "");
  return (
    <div className="reno-block" data-testid="reno-sanierung">
      <div className="reno-head">{t("renovation.panel.sanierung.title")}</div>
      <div className="reno-hint" data-testid="reno-sanierung-count">
        {t("renovation.panel.sanierung.count", { n: String(info.renovated) })}
      </div>
      {info.pairs.length === 0 && <div className="reno-hint">{t("renovation.panel.sanierung.empty")}</div>}
      {info.pairs.map((pr) => (
        <div className="reno-pair" key={pr.type} data-testid="reno-pair">
          <div className="reno-pair-title">
            <span>{pr.name}</span>
            <span aria-hidden="true">→</span>
            <span>{pr.targetName ?? pr.target}</span>
          </div>
          <div className="reno-hint">{t("renovation.panel.sanierung.walls", { r: String(pr.renovated), n: String(pr.walls) })}</div>
          <div className="reno-select-by">
            <button
              type="button"
              className="reno-link-btn"
              data-testid="reno-pair-renovate-all"
              disabled={pr.walls === 0 || pr.renovated === pr.walls}
              onClick={() => applyChange((p) => renovateAllOfTypeOps(p, pr.type))}
            >
              {t("renovation.panel.sanierung.renovateAll")}
            </button>
            <button type="button" className="reno-link-btn" data-testid="reno-pair-edit" aria-expanded={open === pr.type} onClick={() => setOpen(open === pr.type ? null : pr.type)}>
              {t("renovation.panel.sanierung.edit")}
            </button>
          </div>
          {open === pr.type && <PairEditor project={project} typeId={pr.type} />}
        </div>
      ))}
      {candidates.length > 0 && (
        <div className="reno-field reno-create">
          <select value={pickId} aria-label={t("renovation.panel.sanierung.createFor")} data-testid="reno-create-type" onChange={(e) => setPick(e.target.value)}>
            {candidates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="reno-add-btn"
            data-testid="reno-create"
            onClick={() => {
              const src = project.wallTypes.find((x) => x.id === pickId);
              if (!src) return;
              applyChange((p) => createRenovationTypeOps(p, pickId, t("renovation.panel.sanierung.newName", { name: src.name })).ops);
              setOpen(pickId);
            }}
          >
            {t("renovation.panel.sanierung.create")}
          </button>
        </div>
      )}
    </div>
  );
}

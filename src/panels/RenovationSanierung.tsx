// [274] Umbau-Panel, Abschnitt „Sanierung“: Typ-Paare Bestandstyp → Sanierungstyp für Wände, Decken und Dächer mit
// Zählern, „Alle … vom Typ sanieren“ (ein Undo-Schritt), „Sanierungstyp anlegen …“ (Kopie des Bestandstyps) und der
// Typ-Paar-Editor: Alt und Neu nebeneinander, Zuordnung je Schicht (automatisch oder manuell), Bezugsseite (Decken:
// unten/oben), Ergebnis-Streifen mit SIA-Farben. Die Regeln (Zuordnung, Teilstücke) rechnet der Kern
// (`renovation::build_up`, für alle drei Bauteilarten dieselbe); gespeichert wird am Bestandstyp.

import { useState } from "react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { useStore } from "../state/appStore";
import {
  RENOVATION_HOSTS,
  createRenovationTypeOps,
  renovateAllOfTypeOps,
  renovationPair,
  renovationPairs,
  renovationTypes,
  setTypePairOps,
} from "../core";
import type { RenovationHost } from "../core";
import type { LayerRenovation, Project, RenovationSide } from "../model/types";
import { RenovationStrip } from "../ui/RenovationStrip";
import { usePanelHostAction } from "./host";

/** Ressourcen-Reiter mit den Schichten je Bauteilart. */
const RESOURCE_TAB = { wall: "wallStyles", ceiling: "ceilingStyles", roof: "roofStyles" } as const;

/** Bezugsseiten-Beschriftung je Bauteilart (Decken: unten/oben). */
const sideKey = (host: RenovationHost, side: "inside" | "outside"): TranslationKey =>
  (host === "wall" ? `renovation.panel.sanierung.side.${side}` : `renovation.panel.sanierung.side.${host}.${side}`) as TranslationKey;

function PairEditor({ project, typeId, host }: { project: Project; typeId: string; host: RenovationHost }) {
  const applyChange = useStore((s) => s.applyChange);
  const openResources = usePanelHostAction("onOpenResources");
  const types = renovationTypes(project, host);
  const wt = types.find((x) => x.id === typeId);
  const pair = renovationPair(project, typeId, undefined, host);
  if (!wt || !pair) return null;
  const oldOv = wt.renovationOld ?? [];
  const newOv = wt.renovationNew ?? [];
  const setOv = (which: "old" | "new", i: number, v: LayerRenovation) => {
    const n = which === "old" ? wt.layers.length : (types.find((x) => x.id === pair.target)?.layers.length ?? 0);
    const cur = [...(which === "old" ? oldOv : newOv)];
    while (cur.length < n) cur.push("auto");
    cur[i] = v;
    applyChange((p) => setTypePairOps(p, typeId, which === "old" ? { old: cur } : { new: cur }, host));
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
        <select value={pair.target} data-testid="reno-pair-target" onChange={(e) => applyChange((p) => setTypePairOps(p, typeId, { target: e.target.value, old: null, new: null }, host))}>
          {types
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
        <select value={pair.side} data-testid="reno-pair-side" onChange={(e) => applyChange((p) => setTypePairOps(p, typeId, { side: e.target.value as RenovationSide }, host))}>
          <option value="inside">{t(sideKey(host, "inside"))}</option>
          <option value="outside">{t(sideKey(host, "outside"))}</option>
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
        <button type="button" className="reno-link-btn" data-testid="reno-pair-reset" onClick={() => applyChange((p) => setTypePairOps(p, typeId, { old: null, new: null }, host))}>
          {t("renovation.panel.sanierung.reset")}
        </button>
        <button type="button" className="reno-link-btn" onClick={() => openResources(RESOURCE_TAB[host])}>
          {t("renovation.panel.sanierung.editLayers")}
        </button>
        <button
          type="button"
          className="reno-link-btn"
          data-testid="reno-pair-remove"
          onClick={() => applyChange((p) => setTypePairOps(p, typeId, { target: null, old: null, new: null, side: null }, host))}
        >
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
  // Bestandstypen ohne Sanierungstyp (und nicht selbst Sanierungstyp) je Bauteilart; Schlüssel `host:id`.
  const candidates = RENOVATION_HOSTS.flatMap((host) => {
    const targets = new Set(info.pairs.filter((x) => x.kind === host).map((x) => x.target));
    return renovationTypes(project, host)
      .filter((x) => !x.renovationTarget && !targets.has(x.id))
      .map((x) => ({ host, id: x.id, name: x.name, key: `${host}:${x.id}` }));
  });
  const [pick, setPick] = useState("");
  const picked = candidates.find((x) => x.key === pick) ?? candidates[0];
  return (
    <div className="reno-block" data-testid="reno-sanierung">
      <div className="reno-head">{t("renovation.panel.sanierung.title")}</div>
      <div className="reno-hint" data-testid="reno-sanierung-count">
        {t("renovation.panel.sanierung.count", { n: String(info.renovated) })}
      </div>
      {info.pairs.length === 0 && <div className="reno-hint">{t("renovation.panel.sanierung.empty")}</div>}
      {RENOVATION_HOSTS.map((host) => {
        const pairs = info.pairs.filter((x) => x.kind === host);
        if (pairs.length === 0) return null;
        return (
          <div key={host} data-testid={`reno-pairs-${host}`}>
            <div className="reno-head sub">{t(`renovation.panel.sanierung.host.${host}` as TranslationKey)}</div>
            {pairs.map((pr) => {
              const key = `${host}:${pr.type}`;
              return (
                <div className="reno-pair" key={key} data-testid="reno-pair" data-kind={host}>
                  <div className="reno-pair-title">
                    <span>{pr.name}</span>
                    <span aria-hidden="true">→</span>
                    <span>{pr.targetName ?? pr.target}</span>
                  </div>
                  <div className="reno-hint">
                    {t((host === "wall" ? "renovation.panel.sanierung.walls" : `renovation.panel.sanierung.${host}s`) as TranslationKey, { r: String(pr.renovated), n: String(pr.elements) })}
                  </div>
                  <div className="reno-select-by">
                    <button
                      type="button"
                      className="reno-link-btn"
                      data-testid="reno-pair-renovate-all"
                      disabled={pr.elements === 0 || pr.renovated === pr.elements}
                      title={pr.elements === 0 ? t("renovation.panel.sanierung.renovateAll.none") : pr.renovated === pr.elements ? t("renovation.panel.sanierung.renovateAll.done") : undefined}
                      onClick={() => applyChange((p) => renovateAllOfTypeOps(p, pr.type, host))}
                    >
                      {t((host === "wall" ? "renovation.panel.sanierung.renovateAll" : `renovation.panel.sanierung.renovateAll.${host}`) as TranslationKey)}
                    </button>
                    <button type="button" className="reno-link-btn" data-testid="reno-pair-edit" aria-expanded={open === key} onClick={() => setOpen(open === key ? null : key)}>
                      {t("renovation.panel.sanierung.edit")}
                    </button>
                  </div>
                  {open === key && <PairEditor project={project} typeId={pr.type} host={host} />}
                </div>
              );
            })}
          </div>
        );
      })}
      {picked && (
        <div className="reno-field reno-create">
          <select value={picked.key} aria-label={t("renovation.panel.sanierung.createFor")} data-testid="reno-create-type" onChange={(e) => setPick(e.target.value)}>
            {RENOVATION_HOSTS.map((host) => {
              const list = candidates.filter((x) => x.host === host);
              return list.length === 0 ? null : (
                <optgroup key={host} label={t(`renovation.panel.sanierung.host.${host}` as TranslationKey)}>
                  {list.map((x) => (
                    <option key={x.key} value={x.key}>
                      {x.name}
                    </option>
                  ))}
                </optgroup>
              );
            })}
          </select>
          <button
            type="button"
            className="reno-add-btn"
            data-testid="reno-create"
            onClick={() => {
              const src = picked;
              applyChange((p) => createRenovationTypeOps(p, src.id, t("renovation.panel.sanierung.newName", { name: src.name }), src.host).ops);
              setOpen(src.key);
            }}
          >
            {t("renovation.panel.sanierung.create")}
          </button>
        </div>
      )}
    </div>
  );
}

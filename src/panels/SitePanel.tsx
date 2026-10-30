// Inhalts-Panel „Gelände & Kontext" — verwaltet die Kontext-Schicht
// (importierte Meshes, Höhenlinien-Sätze, abgeleitetes Gelände-TIN). Daten/
// Handler kommen über usePanelHost (kein Prop-Drilling).
//
// Aufbau:
//   • Aktions-Zeile: „DXF importieren" (öffnet den in App montierten Datei-
//     Dialog) + „Gelände erzeugen" (aus dem gewählten Kontur-Satz).
//   • Liste der Kontext-Objekte: Name + Typ-Badge + „Entfernen".
//   • Schattenstudie (SunStudySection): Schalter, Datum, Zeitregler.
//   • Baurecht (SiteRulesSection): Parzelle, Grenzabstände, Baulinien, Gesamthöhe.
//   • DWG-Hinweis am Fuß.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md). Alle sichtbaren
// Texte über t(...).

import { useMemo, useState } from "react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { usePanelHost } from "./host";
import type { ContextObject } from "../model/types";
import { ContextImportDialog } from "../ui/ContextImportDialog";
import { Dropdown } from "../ui/Dropdown";
import { useStore } from "../state/appStore";
import { isTauriRuntime } from "../native/projectFile";
import { openContextImportWindowNative } from "../native/contextImportWindow";
import { SunStudySection } from "./SunStudySection";
import { SiteRulesSection } from "./SiteRulesSection";
import { PointCloudSection } from "./PointCloudSection";
import { excavationQuantities } from "../core";

/** Typ-spezifisches Badge-Label (i18n-Key) je Kontext-Objekt-Art. */
function typeBadgeKey(obj: ContextObject): TranslationKey {
  switch (obj.type) {
    case "importedMesh":
      return "site.type.mesh";
    case "contourSet":
      return "site.type.contours";
    case "terrainMesh":
      return "site.type.terrain";
    case "image":
      return "site.type.image";
    case "excavation":
      return "site.type.excavation";
  }
}

/** Ebenen-/Gruppenname eines Kontext-Objekts (aus `layer`, sonst Typ-Fallback). */
function layerOf(obj: ContextObject): string {
  if (obj.layer && obj.layer.trim() !== "") return obj.layer;
  switch (obj.type) {
    case "importedMesh":
      return t("site.group.imported");
    case "terrainMesh":
      return t("site.group.terrain");
    case "contourSet":
      return t("site.group.contours");
    case "image":
      return t("site.group.image");
    case "excavation":
      return t("site.group.terrain");
  }
}

/** Zahl-Eingabe für ein Feld eines Kontext-Objekts (leer = Standard, ungültig = keine Änderung). */
function NumField(props: {
  label: string;
  value: number | undefined;
  step: number;
  min?: number;
  placeholder?: string;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <label className="site-prop">
      <span>{props.label}</span>
      <input
        type="number"
        step={props.step}
        min={props.min}
        placeholder={props.placeholder}
        value={props.value ?? ""}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === "") return props.onChange(undefined);
          const v = Number(raw);
          if (Number.isFinite(v)) props.onChange(v);
        }}
      />
    </label>
  );
}

const fmt1 = (v: number) => v.toLocaleString("de-CH", { maximumFractionDigits: 1, minimumFractionDigits: 1 });

/** Gruppiert Kontext-Objekte nach Ebene, Reihenfolge des ersten Auftretens. */
function groupByLayer(objects: ContextObject[]): { layer: string; items: ContextObject[] }[] {
  const order: string[] = [];
  const byLayer = new Map<string, ContextObject[]>();
  for (const obj of objects) {
    const layer = layerOf(obj);
    let items = byLayer.get(layer);
    if (!items) {
      items = [];
      byLayer.set(layer, items);
      order.push(layer);
    }
    items.push(obj);
  }
  return order.map((layer) => ({ layer, items: byLayer.get(layer)! }));
}

function ExcavationQty({ q }: { q: { cut: number; fill: number; backfill: number } | undefined }) {
  if (!q) return <div className="site-qty">{t("site.excavation.noTerrain")}</div>;
  return (
    <div className="site-qty">
      {t("site.excavation.qty", { cut: fmt1(q.cut), fill: fmt1(q.fill), backfill: fmt1(q.backfill) })}
    </div>
  );
}

export function SitePanel() {
  const host = usePanelHost();
  const notify = useStore((s) => s.notify);
  const objects = host.contextObjects;
  const contourSets = objects.filter((o) => o.type === "contourSet");

  // Standort-Import-Dialog (geo.admin/OSM) offen?
  const [ctxImportOpen, setCtxImportOpen] = useState(false);

  // Gewählter Kontur-Satz für „Gelände erzeugen" (default: erster vorhandener).
  const [selectedSet, setSelectedSet] = useState<string>("");
  const effectiveSet =
    selectedSet && contourSets.some((c) => c.id === selectedSet)
      ? selectedSet
      : (contourSets[0]?.id ?? "");

  // [T6] Glätten beim Erzeugen (Bruchkanten werden immer erzwungen).
  const [smooth, setSmooth] = useState(true);
  // [68] Mengen der Baugruben (Kern), nur neu, wenn sich das Projekt ändert.
  const quantities = useMemo(() => excavationQuantities(host.project), [host.project]);
  const patch = (id: string, field: string) => (v: number | undefined) =>
    host.onPatchContextObject(id, { [field]: v }, `site-${id}-${field}`);

  const onGenerate = () => {
    if (!effectiveSet) return;
    const id = host.onGenerateTerrain(effectiveSet, { smooth: smooth ? 2 : 0 });
    if (id === null) {
      // Kein sinnvolles TIN — ruhiger Hinweis als Toast (keine harte Fehlerbox;
      // window.alert wäre im Tauri-WKWebView ohnehin wirkungslos).
      notify(t("site.terrainFailed"), "error");
    }
  };

  return (
    <div className="site-panel">
      {/* Aktions-Zeile: Import + Gelände-Erzeugung. */}
      <div className="site-actions">
        <button
          type="button"
          className="site-btn"
          onClick={() => host.onImportDxf()}
        >
          {t("site.import")}
        </button>
        <button
          type="button"
          className="site-btn"
          onClick={() => {
            if (isTauriRuntime()) void openContextImportWindowNative();
            else setCtxImportOpen(true);
          }}
        >
          {t("site.importLocation")}
        </button>
        <button
          type="button"
          className="site-btn"
          title={t("site.setGeoref.hint")}
          onClick={() => host.onStartGeoref()}
        >
          {t("site.setGeoref")}
        </button>
      </div>

      {ctxImportOpen && (
        <ContextImportDialog
          onImport={(objs) => host.onAddContextObjects(objs)}
          onClose={() => setCtxImportOpen(false)}
          geoAnchor={host.project.geoAnchor}
          onSetGeoAnchor={host.onSetGeoAnchor}
        />
      )}

      {contourSets.length > 0 && (
        <div className="site-terrain-row">
          {contourSets.length > 1 ? (
            <Dropdown
              value={effectiveSet}
              onChange={(v) => setSelectedSet(v)}
              title={t("site.contourSet")}
              options={contourSets.map((cs) => ({ value: cs.id, label: cs.name }))}
            />
          ) : (
            <span className="site-terrain-src" title={t("site.contourSet")}>
              {contourSets[0].name}
            </span>
          )}
          <label className="site-check" title={t("site.smooth.hint")}>
            <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} />
            {t("site.smooth")}
          </label>
          <button type="button" className="site-btn" onClick={onGenerate}>
            {t("site.generateTerrain")}
          </button>
        </div>
      )}
      {objects.some((o) => o.type === "terrainMesh") && (
        <div className="site-actions">
          <button type="button" className="site-btn" title={t("site.excavation.hint")} onClick={() => host.onStartExcavation()}>
            {t("site.excavation.draw")}
          </button>
        </div>
      )}

      <div className="site-sep" />
      <SunStudySection />
      <div className="site-sep" />
      <SiteRulesSection />
      <div className="site-sep" />
      <PointCloudSection />
      <div className="site-sep" />

      {/* Kontext-Objekte nach Ebene (`layer`) gruppiert: importierte Gebäude
          liegen als EINZELNE, getrennt lösch-/anwählbare Elemente unter ihrer
          Ebene (z. B. „Gebäude"), Terrain unter „Terrain". Je Gruppe ein Kopf
          mit Anzahl + „ganze Ebene löschen". */}
      {objects.length === 0 ? (
        <div className="site-empty">{t("site.empty")}</div>
      ) : (
        groupByLayer(objects).map(({ layer, items }) => (
          <div key={layer} className="site-group">
            <div className="site-group-head">
              <span className="site-group-name">{layer}</span>
              <span className="site-group-count">{items.length}</span>
              <button
                type="button"
                className="site-remove"
                title={t("site.deleteLayer")}
                aria-label={t("site.deleteLayer")}
                onClick={() => host.onRemoveContextObjects(items.map((o) => o.id))}
              >
                ×
              </button>
            </div>
            <ul className="site-list">
              {items.map((obj) => (
                <li
                  key={obj.id}
                  className={
                    "site-row" +
                    (host.selectedContextObjectIds.includes(obj.id) ? " site-row-selected" : "")
                  }
                >
                  <span className="site-name" title={obj.name}>
                    {obj.name}
                  </span>
                  <span className={"site-badge site-badge-" + obj.type}>
                    {t(typeBadgeKey(obj))}
                  </span>
                  <button
                    type="button"
                    className="site-remove"
                    title={t("site.delete")}
                    aria-label={t("site.delete")}
                    onClick={() => host.onRemoveContextObject(obj.id)}
                  >
                    ×
                  </button>
                  {obj.type === "terrainMesh" && (
                    <div className="site-props">
                      <NumField
                        label={t("site.contourInterval")}
                        value={obj.contourInterval}
                        step={0.5}
                        min={0}
                        placeholder="—"
                        onChange={patch(obj.id, "contourInterval")}
                      />
                      <NumField
                        label={t("site.contourIndexEvery")}
                        value={obj.contourIndexEvery}
                        step={1}
                        min={1}
                        placeholder="5"
                        onChange={patch(obj.id, "contourIndexEvery")}
                      />
                    </div>
                  )}
                  {obj.type === "excavation" && (
                    <div className="site-props">
                      <NumField
                        label={t("site.excavation.bottom")}
                        value={obj.bottom}
                        step={0.05}
                        onChange={(v) => v !== undefined && patch(obj.id, "bottom")(v)}
                      />
                      <NumField label={t("site.excavation.slope")} value={obj.slope} step={5} min={5} placeholder="45" onChange={patch(obj.id, "slope")} />
                      <NumField
                        label={t("site.excavation.fillSlope")}
                        value={obj.fillSlope}
                        step={5}
                        min={5}
                        placeholder="33.7"
                        onChange={patch(obj.id, "fillSlope")}
                      />
                      <NumField
                        label={t("site.excavation.bermWidth")}
                        value={obj.bermWidth}
                        step={0.25}
                        min={0}
                        placeholder="—"
                        onChange={patch(obj.id, "bermWidth")}
                      />
                      <NumField
                        label={t("site.excavation.bermHeight")}
                        value={obj.bermHeight}
                        step={0.5}
                        min={0}
                        placeholder="—"
                        onChange={patch(obj.id, "bermHeight")}
                      />
                      <ExcavationQty q={quantities.find((x) => x.id === obj.id)} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))
      )}

      <div className="site-hint">{t("site.dwgHint")}</div>
    </div>
  );
}

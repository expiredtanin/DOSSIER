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

import { useState } from "react";
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
  }
}

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

  const onGenerate = () => {
    if (!effectiveSet) return;
    const id = host.onGenerateTerrain(effectiveSet);
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
          <button type="button" className="site-btn" onClick={onGenerate}>
            {t("site.generateTerrain")}
          </button>
        </div>
      )}

      <div className="site-sep" />
      <SunStudySection />
      <div className="site-sep" />
      <SiteRulesSection />
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

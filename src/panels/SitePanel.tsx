// Inhalts-Panel „Gelände & Kontext" — verwaltet die Kontext-Schicht
// (importierte Meshes, Höhenlinien-Sätze, abgeleitetes Gelände-TIN). Daten/
// Handler kommen über usePanelHost (kein Prop-Drilling).
//
// Aufbau:
//   • Aktions-Zeile: „DXF importieren" (öffnet den in App montierten Datei-
//     Dialog) + „Gelände erzeugen" (aus dem gewählten Kontur-Satz).
//   • Liste der Kontext-Objekte: Name + Typ-Badge + „Entfernen".
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

/** Typ-spezifisches Badge-Label (i18n-Key) je Kontext-Objekt-Art. */
function typeBadgeKey(obj: ContextObject): TranslationKey {
  switch (obj.type) {
    case "importedMesh":
      return "site.type.mesh";
    case "contourSet":
      return "site.type.contours";
    case "terrainMesh":
      return "site.type.terrain";
  }
}

export function SitePanel() {
  const host = usePanelHost();
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
      // Kein sinnvolles TIN — ruhiger Hinweis (keine harte Fehlerbox).
      // eslint-disable-next-line no-alert
      alert(t("site.terrainFailed"));
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
          onClick={() => setCtxImportOpen(true)}
        >
          {t("site.importLocation")}
        </button>
      </div>

      {ctxImportOpen && (
        <ContextImportDialog
          onImport={(objs) => host.onAddContextObjects(objs)}
          onClose={() => setCtxImportOpen(false)}
        />
      )}

      {contourSets.length > 0 && (
        <div className="site-terrain-row">
          {contourSets.length > 1 ? (
            <select
              className="site-select"
              value={effectiveSet}
              onChange={(e) => setSelectedSet(e.target.value)}
              aria-label={t("site.contourSet")}
            >
              {contourSets.map((cs) => (
                <option key={cs.id} value={cs.id}>
                  {cs.name}
                </option>
              ))}
            </select>
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

      {/* Liste der Kontext-Objekte (Name + Typ-Badge + Entfernen). */}
      {objects.length === 0 ? (
        <div className="site-empty">{t("site.empty")}</div>
      ) : (
        <ul className="site-list">
          {objects.map((obj) => (
            <li key={obj.id} className="site-row">
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
      )}

      <div className="site-hint">{t("site.dwgHint")}</div>
    </div>
  );
}

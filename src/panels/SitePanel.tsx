// Inhalts-Panel „Gelände & Kontext": Aktionen rund um die Lage — DXF-/Standort-Import, Bezugspunkt,
// „Gelände erzeugen" aus Höhenlinien, Baugrube, Schattenstudie, Baurecht, Punktwolken.
//
// [181] Keine Liste der importierten Dinge mehr: Gelände, Höhenlinien, Nachbargebäude, Luftbilder und
// Baugruben sind nach dem Import normale Elemente mit Klasse. Sichtbarkeit über die Klasse (Ebenen-Panel),
// Auswahl im Plan/3D oder im Elemente-Panel, Einstellungen und Löschen wie bei jedem Element (Objekt-Info).
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md). Alle sichtbaren
// Texte über t(...).

import { useState } from "react";
import { t } from "../i18n";
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

const NO_CONTEXT: ContextObject[] = [];

export function SitePanel() {
  const host = usePanelHost();
  const project = useStore((s) => s.project);
  const notify = useStore((s) => s.notify);
  const objects = project.context ?? NO_CONTEXT;
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
          onImport={(objs, lines) => host.onAddContextObjects(objs, lines)}
          onClose={() => setCtxImportOpen(false)}
          geoAnchor={project.geoAnchor}
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

      <div className="site-hint">{t("site.dwgHint")}</div>
    </div>
  );
}

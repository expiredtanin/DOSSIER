// Standort-Import-Dialog (modal). Sucht einen Ort/Adresse (geo.admin
// SearchServer), lässt einen Radius wählen und importiert Gebäude-Grundrisse
// (swisstopo) sowie OSM-Features (Gebäude/Strassen/Wasser/Grün/Parkplätze/
// Bahn/Wald) als Kontext-Geometrie ins Projekt.
//
// Muster wie ExportPdfDialog/ImportDialog: abgedunkeltes Overlay, Klick auf den
// Hintergrund + Esc schließen. Der eigentliche Netz-Abruf läuft hier (io/*); das
// Ergebnis wird über `onImport(objs)` nach oben gereicht (SitePanel legt es via
// Host in `project.context` ab). Bezeichner englisch, UI-Text/Kommentare deutsch
// (CONVENTIONS.md).

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import { geocode, fetchBuildings } from "../io/swissTopo";
import type { GeocodeCandidate } from "../io/swissTopo";
import { fetchBuildings3d } from "../io/swissBuildings3d";
import type { BuildingsVersion } from "../io/swissBuildings3d";
import { fetchTerrainXyz } from "../io/swissAlti3d";
import type { TerrainResolution } from "../io/swissAlti3d";
import { fetchOsm } from "../io/osm";
import type { OsmSelection } from "../io/osm";
import { featuresToContextObjects } from "../io/geoContext";
import type { GeoFeature } from "../io/geoContext";
import { terrainMeshFromGrid } from "../model/terrain";
import type { GeoOrigin } from "../io/lv95";
import type { ContextObject } from "../model/types";

/** Gebäude-Import-Modus: aus, vereinfachte Box (schnell, alt) oder echte
 *  swissBUILDINGS3D-Geometrie (Wände+Dach) in einer der zwei Generationen. */
export type SwissBuildingsMode = "off" | "flach" | "v2" | "v3";

/** Georeferenzierungs-Bezug: welcher Modell-Punkt entspricht welcher realen
 *  LV95-Koordinate (s. `Project.geoAnchor`). */
export interface GeoAnchor {
  lv95: { e: number; n: number };
  model: { x: number; y: number };
  label?: string;
}

export interface ContextImportDialogProps {
  /** Übernimmt die fertigen Kontext-Objekte (nach erfolgreichem Import). */
  onImport: (objs: ContextObject[]) => void;
  onClose: () => void;
  /** Aktueller Georeferenzierungs-Bezug des Projekts (falls schon gesetzt). */
  geoAnchor?: GeoAnchor;
  /** Setzt/ersetzt (`undefined` löscht) den Georeferenzierungs-Bezug. */
  onSetGeoAnchor: (anchor: GeoAnchor | undefined) => void;
}

type Sources = {
  swissBuildings: SwissBuildingsMode;
  swissTerrain: boolean;
  osmBuildings: boolean;
  osmRoads: boolean;
  osmWater: boolean;
  osmGreen: boolean;
  osmParking: boolean;
  osmRailway: boolean;
  osmForest: boolean;
};

const DEFAULT_SOURCES: Sources = {
  // v2 = stabile Generation (1-km-Tiles, ~50 MB) als Default; v3 (Beta) kann in
  // Städten sehr grosse Kacheln liefern (s. swissBuildings3d.ts-Kommentar).
  swissBuildings: "v2",
  swissTerrain: true,
  osmBuildings: false,
  osmRoads: true,
  osmWater: true,
  osmGreen: true,
  osmParking: false,
  osmRailway: false,
  osmForest: false,
};

export function ContextImportDialog({
  onImport,
  onClose,
  geoAnchor,
  onSetGeoAnchor,
}: ContextImportDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<GeocodeCandidate[]>([]);
  const [selected, setSelected] = useState<GeocodeCandidate | null>(null);
  const [radius, setRadius] = useState(200);
  const [sources, setSources] = useState<Sources>(DEFAULT_SOURCES);
  // 2 m = Default (schneller/kleinere Kacheln); 0.5 m für Detailarbeit.
  const [terrainResolution, setTerrainResolution] = useState<TerrainResolution>("2");

  const [searching, setSearching] = useState(false);
  const [importing, setImporting] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const searchSeq = useRef(0);

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    setError(null);
    setSearching(true);
    const seq = ++searchSeq.current;
    try {
      const res = await geocode(q, 8);
      if (seq !== searchSeq.current) return; // veraltet
      setCandidates(res);
      setSelected(res[0] ?? null);
      if (res.length === 0) setStatus(t("ctxImport.noResults"));
      else setStatus(null);
    } catch {
      if (seq === searchSeq.current) setError(t("ctxImport.searchError"));
    } finally {
      if (seq === searchSeq.current) setSearching(false);
    }
  };

  const toggle = (key: Exclude<keyof Sources, "swissBuildings">) =>
    setSources((s) => ({ ...s, [key]: !s[key] }));
  const setSwissBuildingsMode = (mode: SwissBuildingsMode) =>
    setSources((s) => ({ ...s, swissBuildings: mode }));

  const anySource =
    sources.swissBuildings !== "off" ||
    sources.swissTerrain ||
    sources.osmBuildings ||
    sources.osmRoads ||
    sources.osmWater ||
    sources.osmGreen ||
    sources.osmParking ||
    sources.osmRailway ||
    sources.osmForest;

  const runImport = async () => {
    if (!selected || !anySource) return;
    setError(null);
    setImporting(true);
    setStatus(t("ctxImport.working"));
    try {
      const center = selected.lv95;
      // Bestehenden Georeferenzierungs-Bezug wiederverwenden, statt bei jedem
      // Import einen neuen (inkonsistenten) zu berechnen — der Bezugspunkt
      // bleibt fix im Modell, nur die GESUCHTE Stelle (center/radius) steuert,
      // WOVON Daten geladen werden (s. Project.geoAnchor-Doc).
      let origin: GeoOrigin | undefined = geoAnchor
        ? { e: geoAnchor.lv95.e - geoAnchor.model.x, n: geoAnchor.lv95.n - geoAnchor.model.y }
        : undefined;
      const all: GeoFeature[] = [];
      // Echte swissBUILDINGS3D-Meshes (v2/v3) landen direkt als ContextObject
      // (kein Footprint+Box-Umweg über GeoFeature/featuresToContextObjects).
      const extraObjs: ContextObject[] = [];
      // Übersprungene Kacheln (zu gross entpackt, Netzwerkfehler o. Ä.) —
      // damit „0 Gebäude" von „X Kacheln übersprungen" unterscheidbar bleibt
      // statt eines stummen Leer-Ergebnisses (Nutzer-Report).
      let buildingsSkipped = 0;

      if (sources.swissBuildings === "flach") {
        const r = await fetchBuildings(center, radius, origin);
        origin = r.origin;
        all.push(...r.features);
      } else if (sources.swissBuildings === "v2" || sources.swissBuildings === "v3") {
        const r = await fetchBuildings3d(
          center,
          radius,
          origin,
          sources.swissBuildings as BuildingsVersion,
        );
        origin = r.origin;
        extraObjs.push(...r.meshes);
        buildingsSkipped = r.skippedTiles;
      }

      const osmSel: OsmSelection = {
        buildings: sources.osmBuildings,
        roads: sources.osmRoads,
        water: sources.osmWater,
        green: sources.osmGreen,
        parking: sources.osmParking,
        railway: sources.osmRailway,
        forest: sources.osmForest,
      };
      if (
        osmSel.buildings ||
        osmSel.roads ||
        osmSel.water ||
        osmSel.green ||
        osmSel.parking ||
        osmSel.railway ||
        osmSel.forest
      ) {
        const r = await fetchOsm(center, radius, osmSel, origin);
        origin = r.origin;
        all.push(...r.features);
      }

      // Gelände-Höhenraster (echtes swissALTI3D-XYZ, native Auflösung) → Terrain-Mesh.
      let terrain: ContextObject | null = null;
      if (sources.swissTerrain) {
        const r = await fetchTerrainXyz(center, radius, origin, terrainResolution);
        origin = r.origin;
        if (r.grid) {
          const mesh = terrainMeshFromGrid(r.grid);
          if (mesh.positions.length >= 9) terrain = mesh;
        }
      }

      if (all.length === 0 && !terrain && extraObjs.length === 0) {
        setError(
          buildingsSkipped > 0
            ? t("ctxImport.buildingsSkipped", { count: buildingsSkipped })
            : t("ctxImport.empty"),
        );
        setStatus(null);
        return;
      }

      // Erster Import in diesem Projekt (noch kein Bezug) -> DIESEN Lauf als
      // Georeferenzierungs-Bezug speichern (Modell-(0,0) = der gesuchte Ort),
      // damit künftige Importe lagerichtig zueinander bleiben.
      if (!geoAnchor && origin) {
        onSetGeoAnchor({ lv95: { e: origin.e, n: origin.n }, model: { x: 0, y: 0 }, label: selected.label });
      }

      const objs = featuresToContextObjects(all, selected.label);
      objs.push(...extraObjs);
      if (terrain) objs.push(terrain);
      onImport(objs);
      setStatus(
        buildingsSkipped > 0
          ? t("ctxImport.importedWithSkipped", {
              count: all.length + extraObjs.length,
              sets: objs.length,
              skipped: buildingsSkipped,
            })
          : t("ctxImport.imported", {
              count: all.length + extraObjs.length,
              sets: objs.length,
            }),
      );
      onClose();
    } catch {
      setError(t("ctxImport.importError"));
      setStatus(null);
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="imp-overlay" onClick={onClose}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("ctxImport.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("ctxImport.title")}</span>
          <button
            className="imp-close"
            onClick={onClose}
            aria-label={t("ctxImport.close")}
          >
            ×
          </button>
        </header>

        <div className="imp-body">
          {/* Georeferenzierungs-Bezug: sobald gesetzt, teilen sich ALLE Importe
              dieses Projekts denselben Modell↔LV95-Bezug (s. Project.geoAnchor). */}
          {geoAnchor && (
            <div className="cim-geo-anchor">
              <span>{t("ctxImport.geoAnchor", { label: geoAnchor.label ?? "?" })}</span>
              <button
                type="button"
                className="imp-linklike"
                onClick={() => onSetGeoAnchor(undefined)}
                title={t("ctxImport.geoAnchor.reset.hint")}
              >
                {t("ctxImport.geoAnchor.reset")}
              </button>
            </div>
          )}
          {/* Ortssuche */}
          <section className="imp-section">
            <div className="imp-section-title">{t("ctxImport.location")}</div>
            <div className="cim-search-row">
              <input
                className="cim-input"
                type="text"
                value={query}
                placeholder={t("ctxImport.searchPlaceholder")}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void runSearch();
                  }
                }}
                aria-label={t("ctxImport.location")}
              />
              <button
                className="imp-btn"
                onClick={() => void runSearch()}
                disabled={searching || !query.trim()}
              >
                {searching ? t("ctxImport.searching") : t("ctxImport.search")}
              </button>
            </div>

            {candidates.length > 0 && (
              <ul className="cim-results">
                {candidates.map((c, i) => (
                  <li
                    key={`${c.label}-${i}`}
                    className={
                      "cim-result" + (c === selected ? " selected" : "")
                    }
                    onClick={() => setSelected(c)}
                    title={c.label}
                  >
                    {c.label}
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Radius */}
          <section className="imp-section">
            <div className="imp-section-title">{t("ctxImport.radius")}</div>
            <div className="cim-radius-row">
              <input
                className="cim-input cim-input-num"
                type="number"
                min={20}
                max={2000}
                step={10}
                value={radius}
                onChange={(e) =>
                  setRadius(
                    Math.max(20, Math.min(2000, Number(e.target.value) || 0)),
                  )
                }
                aria-label={t("ctxImport.radius")}
              />
              <span className="cim-unit">m</span>
            </div>
          </section>

          {/* Quellen */}
          <section className="imp-section">
            <div className="imp-section-title">{t("ctxImport.sources")}</div>
            <div className="cim-checks">
              <label className="cim-check cim-check-row">
                <span>{t("ctxImport.src.swissBuildings")}</span>
                <select
                  className="cim-input"
                  value={sources.swissBuildings}
                  onChange={(e) =>
                    setSwissBuildingsMode(e.target.value as SwissBuildingsMode)
                  }
                  aria-label={t("ctxImport.src.swissBuildings")}
                >
                  <option value="off">{t("ctxImport.buildings.off")}</option>
                  <option value="flach">{t("ctxImport.buildings.flach")}</option>
                  <option value="v2">{t("ctxImport.buildings.v2")}</option>
                  <option value="v3">{t("ctxImport.buildings.v3")}</option>
                </select>
              </label>
              <label className="cim-check cim-check-row">
                <span className="cim-check-with-box">
                  <input
                    type="checkbox"
                    checked={sources.swissTerrain}
                    onChange={() => toggle("swissTerrain")}
                  />
                  {t("ctxImport.src.swissTerrain")}
                </span>
                <select
                  className="cim-input"
                  value={terrainResolution}
                  disabled={!sources.swissTerrain}
                  onChange={(e) =>
                    setTerrainResolution(e.target.value as TerrainResolution)
                  }
                  aria-label={t("ctxImport.terrain.resolution")}
                >
                  <option value="2">{t("ctxImport.terrain.res2")}</option>
                  <option value="0.5">{t("ctxImport.terrain.res05")}</option>
                </select>
              </label>
              <label className="cim-check">
                <input
                  type="checkbox"
                  checked={sources.osmBuildings}
                  onChange={() => toggle("osmBuildings")}
                />
                {t("ctxImport.src.osmBuildings")}
              </label>
              <label className="cim-check">
                <input
                  type="checkbox"
                  checked={sources.osmRoads}
                  onChange={() => toggle("osmRoads")}
                />
                {t("ctxImport.src.osmRoads")}
              </label>
              <label className="cim-check">
                <input
                  type="checkbox"
                  checked={sources.osmWater}
                  onChange={() => toggle("osmWater")}
                />
                {t("ctxImport.src.osmWater")}
              </label>
              <label className="cim-check">
                <input
                  type="checkbox"
                  checked={sources.osmGreen}
                  onChange={() => toggle("osmGreen")}
                />
                {t("ctxImport.src.osmGreen")}
              </label>
              <label className="cim-check">
                <input
                  type="checkbox"
                  checked={sources.osmParking}
                  onChange={() => toggle("osmParking")}
                />
                {t("ctxImport.src.osmParking")}
              </label>
              <label className="cim-check">
                <input
                  type="checkbox"
                  checked={sources.osmRailway}
                  onChange={() => toggle("osmRailway")}
                />
                {t("ctxImport.src.osmRailway")}
              </label>
              <label className="cim-check">
                <input
                  type="checkbox"
                  checked={sources.osmForest}
                  onChange={() => toggle("osmForest")}
                />
                {t("ctxImport.src.osmForest")}
              </label>
            </div>
          </section>

          {status && <div className="cim-status">{status}</div>}
          {error && <div className="imp-warn">{error}</div>}
        </div>

        <footer className="imp-foot">
          <button className="imp-btn" onClick={onClose}>
            {t("ctxImport.cancel")}
          </button>
          <button
            className="imp-btn primary"
            onClick={() => void runImport()}
            disabled={importing || !selected || !anySource}
          >
            {importing ? t("ctxImport.importing") : t("ctxImport.confirm")}
          </button>
        </footer>
      </div>
    </div>
  );
}

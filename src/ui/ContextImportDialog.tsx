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
import { fetchSwissImage } from "../io/swissImage";
import { fetchOsm } from "../io/osm";
import type { OsmSelection } from "../io/osm";
import { featuresToContextObjects } from "../io/geoContext";
import type { GeoFeature } from "../io/geoContext";
import { terrainMeshFromGrid } from "../model/terrain";
import { makeOrigin } from "../io/lv95";
import type { GeoOrigin, LV95 } from "../io/lv95";
import type { ContextObject, TerrainMesh } from "../model/types";

/** Gebäude-Import-Modus: aus, vereinfachte Box (schnell, alt) oder echte
 *  swissBUILDINGS3D-Geometrie (Wände+Dach) in einer der zwei Generationen. */
export type SwissBuildingsMode = "off" | "flach" | "v2" | "v3";

/** Georeferenzierungs-Bezug: welcher Modell-Punkt entspricht welcher realen
 *  LV95-Koordinate (s. `Project.geoAnchor`). */
export interface GeoAnchor {
  lv95: { e: number; n: number };
  /** Reale Höhe (m ü. M.) des Bezugspunkts — informativ, s. Project.geoAnchor. */
  height?: number;
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
  /**
   * Läuft in einem EIGENEN nativen Fenster (siehe native/contextImportWindow.ts)
   * statt als abgedunkelter Overlay-Dialog im Hauptfenster — kein Backdrop,
   * füllt die Fensterfläche, Kopfzeile wird zum Ziehbereich statt Schliessen-
   * Knopf (Abbrechen/Importieren im Fuss bleiben — das sind echte Aktionen,
   * kein reiner Schliessen-Button wie bei SettingsDialog).
   */
  windowed?: boolean;
}

type Sources = {
  swissBuildings: SwissBuildingsMode;
  swissTerrain: boolean;
  swissImage: boolean;
  swissImageDrape: boolean;
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
  swissImage: false,
  swissImageDrape: false,
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
  windowed = false,
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
  // Optionaler Bezugspunkt: welche LV95-Koordinate soll im Modell auf (0,0)
  // liegen (der „neue Nullpunkt", z. B. ein amtlicher Vermessungspunkt aus dem
  // Kataster). Leer = das Suchzentrum wird Modell-(0,0) (bisheriges Verhalten).
  const [refPoint, setRefPoint] = useState<{ e: string; n: string; h: string }>({
    e: "",
    n: "",
    h: "",
  });
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
    sources.swissImage ||
    sources.swissImageDrape ||
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
      // Optionaler Bezugspunkt (LV95): dieser Punkt wird zu Modell-(0,0). Leer
      // -> das Suchzentrum wird der Nullpunkt (bisheriges Verhalten).
      const refE = Number(refPoint.e);
      const refN = Number(refPoint.n);
      const hasRef =
        refPoint.e.trim() !== "" &&
        refPoint.n.trim() !== "" &&
        Number.isFinite(refE) &&
        Number.isFinite(refN);
      const refLv95: LV95 = hasRef ? { e: refE, n: refN } : center;
      // Optionale Höhe (m ü. M.) des Bezugspunkts — rein informativ (kein Shift).
      const refH = Number(refPoint.h);
      const hasRefH = refPoint.h.trim() !== "" && Number.isFinite(refH);
      // Der gesuchte Ort landet nahe dem Modell-Nullpunkt (Modell rechnet in
      // float32 — LV95-Koordinaten im Millionenbereich würden 2D/3D unbrauchbar
      // ungenau darstellen). Der Bezug (geoAnchor) merkt sich „Modell-(0,0) =
      // dieser LV95-Punkt", damit der IFC-/DXF-Export trotzdem die echten
      // Landeskoordinaten schreibt und weitere Importe lagerichtig dazu liegen.
      // Mit „Neuer Bezugspunkt" (georef) lässt sich der Ursprung später auf einen
      // beliebigen Modellpunkt verschieben.
      let origin: GeoOrigin = geoAnchor
        ? { e: geoAnchor.lv95.e - geoAnchor.model.x, n: geoAnchor.lv95.n - geoAnchor.model.y }
        : makeOrigin(refLv95);
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
      // Die Drapierung braucht das TIN -> Terrain auch dann holen, wenn nur
      // „Luftbild aufs Gelände" (ohne eigenen Terrain-Haken) gewählt wäre.
      let terrain: TerrainMesh | null = null;
      if (sources.swissTerrain || sources.swissImageDrape) {
        const r = await fetchTerrainXyz(center, radius, origin, terrainResolution);
        origin = r.origin;
        if (r.grid) {
          const mesh = terrainMeshFromGrid(r.grid);
          if (mesh.positions.length >= 9) terrain = mesh;
        }
      }

      // SWISSIMAGE-Luftbild (WMS) → georeferenziertes Rasterbild (EIN ContextImage).
      //  • `swissImage`  → 2D-Grundriss-Hintergrund.
      //  • `swissImageDrape` → `drape:true`: der 3D-Viewer legt es pixelscharf als
      //    Textur aufs Gelände (render3d `set_aerial_texture`).
      // Beide Modi teilen dasselbe Bild; das Bild wird nur EINMAL geladen.
      let image: ContextObject | null = null;
      if (sources.swissImage || sources.swissImageDrape) {
        const r = await fetchSwissImage(center, radius, origin);
        origin = r.origin;
        if (r.dataUrl) {
          image = {
            id: `img-${Date.now()}`,
            type: "image",
            name: `Luftbild ${selected.label}`,
            layer: "Luftbild",
            src: r.dataUrl,
            min: r.min,
            max: r.max,
            drape: sources.swissImageDrape,
          };
        }
      }

      if (all.length === 0 && !terrain && !image && extraObjs.length === 0) {
        setError(
          buildingsSkipped > 0
            ? t("ctxImport.buildingsSkipped", { count: buildingsSkipped })
            : t("ctxImport.empty"),
        );
        setStatus(null);
        return;
      }

      // Erster Import in diesem Projekt (noch kein Bezug) -> Bezug speichern:
      // Modell-(0,0) entspricht dem gesuchten Ort (LV95 `center`). Damit landet
      // der Import nahe dem Ursprung (gut darstellbar) UND der Modell-Export
      // kann später auf die echten LV95-Koordinaten zurückrechnen.
      if (!geoAnchor) {
        const anchorLabel = hasRef
          ? t("ctxImport.refPoint.anchorLabel", { e: Math.round(refE), n: Math.round(refN) })
          : selected.label;
        onSetGeoAnchor({
          lv95: refLv95,
          height: hasRefH ? refH : undefined,
          model: { x: 0, y: 0 },
          label: anchorLabel,
        });
      }

      const objs = featuresToContextObjects(all, selected.label);
      objs.push(...extraObjs);
      if (terrain) objs.push(terrain);
      if (image) objs.push(image);
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

  const dialog = (
      <div
        className={`imp-dialog${windowed ? " imp-dialog-embedded" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={t("ctxImport.title")}
        onClick={windowed ? undefined : (e) => e.stopPropagation()}
      >
        <header
          className="imp-head"
          {...(windowed ? { "data-tauri-drag-region": true } : {})}
        >
          <span className="imp-head-title">{t("ctxImport.title")}</span>
          {!windowed && (
            <button
              className="imp-close"
              onClick={onClose}
              aria-label={t("ctxImport.close")}
            >
              ×
            </button>
          )}
        </header>

        <div className="imp-body">
          {/* Georeferenzierungs-Bezug: sobald gesetzt, teilen sich ALLE Importe
              dieses Projekts denselben Modell↔LV95-Bezug (s. Project.geoAnchor).
              Ohne Bezug wird ROH importiert (echte LV95-Koordinaten, weit vom
              Nullpunkt) — ein Hinweis erklärt den Folge-Schritt „Neuer
              Bezugspunkt". */}
          {geoAnchor ? (
            <div className="cim-geo-anchor">
              <span>
                {t("ctxImport.geoAnchor", { label: geoAnchor.label ?? "?" })}
                {" — "}
                {t("ctxImport.geoAnchor.coords", {
                  e: geoAnchor.lv95.e.toFixed(2),
                  n: geoAnchor.lv95.n.toFixed(2),
                  h: typeof geoAnchor.height === "number" ? geoAnchor.height.toFixed(2) : "—",
                })}
              </span>
              <button
                type="button"
                className="imp-linklike"
                onClick={() => onSetGeoAnchor(undefined)}
                title={t("ctxImport.geoAnchor.reset.hint")}
              >
                {t("ctxImport.geoAnchor.reset")}
              </button>
            </div>
          ) : (
            <div className="cim-geo-anchor cim-geo-hint">{t("ctxImport.rawHint")}</div>
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

          {/* Bezugspunkt (Modell-Nullpunkt): nur solange noch kein Bezug steht.
              Leer -> Suchzentrum wird (0,0); gefüllt -> dieser LV95-Punkt wird
              (0,0) (z. B. amtlicher Vermessungspunkt aus dem Kataster). */}
          {!geoAnchor && (
            <section className="imp-section">
              <div className="imp-section-title">{t("ctxImport.refPoint")}</div>
              <div className="cim-radius-row">
                <input
                  className="cim-input cim-input-num"
                  type="number"
                  step={0.01}
                  value={refPoint.e}
                  placeholder={t("ctxImport.refPoint.e")}
                  onChange={(e) => setRefPoint((p) => ({ ...p, e: e.target.value }))}
                  aria-label={t("ctxImport.refPoint.e")}
                />
                <input
                  className="cim-input cim-input-num"
                  type="number"
                  step={0.01}
                  value={refPoint.n}
                  placeholder={t("ctxImport.refPoint.n")}
                  onChange={(e) => setRefPoint((p) => ({ ...p, n: e.target.value }))}
                  aria-label={t("ctxImport.refPoint.n")}
                />
                <input
                  className="cim-input cim-input-num"
                  type="number"
                  step={0.01}
                  value={refPoint.h}
                  placeholder={t("ctxImport.refPoint.h")}
                  onChange={(e) => setRefPoint((p) => ({ ...p, h: e.target.value }))}
                  aria-label={t("ctxImport.refPoint.h")}
                />
              </div>
              <div className="cim-geo-hint">{t("ctxImport.refPoint.hint")}</div>
            </section>
          )}

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
                  checked={sources.swissImage}
                  onChange={() => toggle("swissImage")}
                />
                {t("ctxImport.src.swissImage")}
              </label>
              <label className="cim-check">
                <input
                  type="checkbox"
                  checked={sources.swissImageDrape}
                  onChange={() => toggle("swissImageDrape")}
                />
                {t("ctxImport.src.swissImageDrape")}
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
  );

  if (windowed) return dialog;
  return (
    <div className="imp-overlay" onClick={onClose}>
      {dialog}
    </div>
  );
}

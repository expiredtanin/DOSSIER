// Standort-Import-Dialog (modal). Sucht einen Ort/Adresse (geo.admin
// SearchServer), lässt einen Radius wählen und importiert Gebäude-Grundrisse
// (swisstopo) sowie OSM-Features (Gebäude/Strassen/Wasser/Grün) als Kontext-
// Geometrie ins Projekt.
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
import { fetchOsm } from "../io/osm";
import type { OsmSelection } from "../io/osm";
import { featuresToContextObjects } from "../io/geoContext";
import type { GeoFeature } from "../io/geoContext";
import type { GeoOrigin } from "../io/lv95";
import type { ContextObject } from "../model/types";

export interface ContextImportDialogProps {
  /** Übernimmt die fertigen Kontext-Objekte (nach erfolgreichem Import). */
  onImport: (objs: ContextObject[]) => void;
  onClose: () => void;
}

type Sources = {
  swissBuildings: boolean;
  osmBuildings: boolean;
  osmRoads: boolean;
  osmWater: boolean;
  osmGreen: boolean;
};

const DEFAULT_SOURCES: Sources = {
  swissBuildings: true,
  osmBuildings: false,
  osmRoads: true,
  osmWater: true,
  osmGreen: true,
};

export function ContextImportDialog({
  onImport,
  onClose,
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

  const toggle = (key: keyof Sources) =>
    setSources((s) => ({ ...s, [key]: !s[key] }));

  const anySource =
    sources.swissBuildings ||
    sources.osmBuildings ||
    sources.osmRoads ||
    sources.osmWater ||
    sources.osmGreen;

  const runImport = async () => {
    if (!selected || !anySource) return;
    setError(null);
    setImporting(true);
    setStatus(t("ctxImport.working"));
    try {
      const center = selected.lv95;
      let origin: GeoOrigin | undefined;
      const all: GeoFeature[] = [];

      if (sources.swissBuildings) {
        const r = await fetchBuildings(center, radius, origin);
        origin = r.origin;
        all.push(...r.features);
      }

      const osmSel: OsmSelection = {
        buildings: sources.osmBuildings,
        roads: sources.osmRoads,
        water: sources.osmWater,
        green: sources.osmGreen,
      };
      if (
        osmSel.buildings ||
        osmSel.roads ||
        osmSel.water ||
        osmSel.green
      ) {
        const r = await fetchOsm(center, radius, osmSel, origin);
        origin = r.origin;
        all.push(...r.features);
      }

      if (all.length === 0) {
        setError(t("ctxImport.empty"));
        setStatus(null);
        return;
      }

      const objs = featuresToContextObjects(all, selected.label);
      onImport(objs);
      setStatus(
        t("ctxImport.imported", { count: all.length, sets: objs.length }),
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
              <label className="cim-check">
                <input
                  type="checkbox"
                  checked={sources.swissBuildings}
                  onChange={() => toggle("swissBuildings")}
                />
                {t("ctxImport.src.swissBuildings")}
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

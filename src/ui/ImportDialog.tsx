// Import-Dialog (modal) für DXF/DWG. Öffnet sich beim Import (Button ODER
// Datei-Drop) und fragt, WIE mit der Datei umzugehen ist:
//   • Ziel-Zeichnungsebene: bestehende wählen ODER neue „Zeichnung" anlegen.
//   • Ebenen-Handling: DXF-Layer als Kategorien (categoryCode) übernehmen vs.
//     alles auf die aktive Kategorie.
//   • Mesh-Behandlung: vorhandene Meshes als Kontext-Geometrie (3D) importieren.
//
// Muster wie ResourceManager: abgedunkeltes Overlay, Klick auf den Hintergrund
// und Esc schließen. Diese Komponente HÄLT nur Formular-Zustand und liefert beim
// Bestätigen eine strukturierte Entscheidung (`ImportDecision`) nach oben; die
// eigentlichen Store-Mutationen (Ebene anlegen, Drawings anhängen, Kontext)
// führt App in der richtigen Reihenfolge aus.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md). Alle sichtbaren
// Texte über t(...).

import { useEffect, useState } from "react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import type { DrawingLevelKind, ImportedMesh, Project } from "../model/types";
import type { DxfImportResult, ImportDiagnostics } from "../io/dxfParser";
import {
  contoursToDrawings,
  textsToDrawings,
  countContours,
  distinctLayers,
} from "../io/dxfToDrawings";
import type { CategoryMode } from "../io/dxfToDrawings";
import { Dropdown } from "./Dropdown";

/** Strukturierte Import-Entscheidung, die der Dialog beim Bestätigen liefert. */
export interface ImportDecision {
  /** Ziel: bestehende Ebene (id) ODER neue Zeichnung (name). */
  target: { kind: "existing"; levelId: string } | { kind: "new"; name: string };
  /** Wie DXF-Layer auf Kategorien abgebildet werden. */
  categoryMode: CategoryMode;
  /** Ob die Meshes als Kontext-Geometrie übernommen werden. */
  importMeshes: boolean;
  /** Die geparsten Konturen-Sätze (für die spätere 2D-Konvertierung). */
  parsed: DxfImportResult;
}

/** i18n-Badge-Key je Zeichnungsebenen-Art. */
function kindBadgeKey(kind: DrawingLevelKind): TranslationKey {
  switch (kind) {
    case "floor":
      return "import.badge.floor";
    case "section":
      return "import.badge.section";
    case "elevation":
      return "import.badge.elevation";
    case "drawing":
      return "import.badge.drawing";
  }
}

/**
 * Formatiert das Entity-Typ-Histogramm der Import-Diagnose zu einer kompakten
 * Daten-Zeile, z. B. „120 Entities — INSERT×80, ARC×30, LINE×10". Die Entity-
 * Typ-Codes sind technische DWG-Bezeichner (keine übersetzbare UI-Prosa); nur
 * die Gesamtzahl ist eine reine Zahl. Bei 0 Entities zeigt sie „0 Entities" —
 * das deutet auf ein Encoding-/Versions-Problem (nicht auf eine Abdeckungslücke).
 */
function formatDiagnostics(d: ImportDiagnostics): string {
  const parts = Object.entries(d.entityCounts)
    .sort((a, b) => b[1] - a[1])
    .map(([type, n]) => `${type}×${n}`);
  const head = `${d.total} Entities`;
  return parts.length > 0 ? `${head} — ${parts.join(", ")}` : head;
}

export interface ImportDialogProps {
  fileName: string;
  /**
   * true, wenn eine DWG-Datei NICHT gelesen werden konnte (LibreDWG-WASM schlug
   * fehl) → ODA-Hinweis als Fallback. Bei erfolgreichem DWG-Parsing ist das false
   * und `parsed` enthält das Ergebnis (gleicher Fluss wie DXF).
   */
  isDwg: boolean;
  /** true, solange eine DWG-Datei noch geparst wird (WASM lädt/läuft). */
  loading?: boolean;
  /** Geparstes Ergebnis (null während Laden / bei DWG-Parse-Fehler). */
  parsed: DxfImportResult | null;
  project: Project;
  activeCategoryCode: string;
  onImport: (decision: ImportDecision) => void;
  onClose: () => void;
}

export function ImportDialog({
  fileName,
  isDwg,
  loading = false,
  parsed,
  project,
  activeCategoryCode,
  onImport,
  onClose,
}: ImportDialogProps) {
  // Esc schließt den Dialog (wie ResourceManager).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const contourSets = parsed?.contours ?? [];
  const meshes: ImportedMesh[] = parsed?.meshes ?? [];
  const texts = parsed?.texts ?? [];
  const contourCount = countContours(contourSets);
  const textCount = texts.length;
  const layers = distinctLayers(contourSets);
  const hasDrawings = contourCount > 0 || textCount > 0;
  const hasMeshes = meshes.length > 0;

  // ── Formular-Zustand ──────────────────────────────────────────────────────
  const firstLevelId = project.drawingLevels[0]?.id ?? "";
  const [targetKind, setTargetKind] = useState<"existing" | "new">("new");
  const [existingLevelId, setExistingLevelId] = useState<string>(firstLevelId);
  // Default-Name der neuen Zeichnung aus dem Dateinamen (ohne Endung).
  const [newName, setNewName] = useState<string>(() =>
    fileName.replace(/\.[^.]+$/, "") || "",
  );
  const [categoryMode, setCategoryMode] = useState<CategoryMode>(
    layers.length > 0 ? "byLayer" : "active",
  );
  const [importMeshes, setImportMeshes] = useState<boolean>(true);

  const canImport =
    !isDwg && !loading && (hasDrawings || (hasMeshes && importMeshes));

  const onConfirm = () => {
    if (!parsed || !canImport) return;
    const target =
      targetKind === "existing"
        ? ({ kind: "existing", levelId: existingLevelId } as const)
        : ({ kind: "new", name: newName } as const);
    onImport({ target, categoryMode, importMeshes, parsed });
  };

  return (
    <div className="imp-overlay" onClick={onClose}>
      <div
        className="imp-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("import.title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="imp-head">
          <span className="imp-head-title">{t("import.title")}</span>
          <button
            className="imp-close"
            onClick={onClose}
            aria-label={t("import.close")}
          >
            ×
          </button>
        </header>

        <div className="imp-body">
          {/* Datei-Zusammenfassung. */}
          <div className="imp-file">
            <span className="imp-file-label">{t("import.file")}</span>
            <span className="imp-file-name" title={fileName}>
              {fileName}
            </span>
          </div>

          {loading ? (
            // DWG wird gelesen (WASM lädt/parst) → Ladehinweis, nur Abbrechen.
            <section className="imp-section">
              <div className="imp-section-title">{t("import.dwg.heading")}</div>
              <div className="imp-dwg-hint">{t("import.dwg.loading")}</div>
            </section>
          ) : isDwg ? (
            // DWG konnte nicht gelesen werden → ODA-Fallback-Hinweis.
            <section className="imp-section">
              <div className="imp-section-title">{t("import.dwg.heading")}</div>
              <div className="imp-dwg-hint">{t("import.dwg.hint")}</div>
            </section>
          ) : (
            <>
              {/* Inhalt der Datei. */}
              <section className="imp-section">
                <div className="imp-section-title">
                  {t("import.summary.heading")}
                </div>
                <ul className="imp-summary">
                  <li>{t("import.summary.contours", { n: contourCount })}</li>
                  {textCount > 0 && (
                    <li>{t("import.summary.texts", { n: textCount })}</li>
                  )}
                  <li>{t("import.summary.meshes", { n: meshes.length })}</li>
                  <li>
                    {layers.length > 0
                      ? t("import.summary.layers", { layers: layers.join(", ") })
                      : t("import.summary.noLayers")}
                  </li>
                </ul>
                {!hasDrawings && !hasMeshes && (
                  <div className="imp-warn">
                    {t("import.summary.empty")}
                    {/* Diagnose-Histogramm (vom DWG-Parser): macht sichtbar,
                        WORAN es liegt — 0 Entities (Encoding/Version) vs.
                        Abdeckungslücke (z. B. „500 ARC, 200 INSERT"). Entity-Typ-
                        Codes + Zahlen sind technische DWG-Bezeichner (Daten,
                        keine übersetzbare Prosa). */}
                    {parsed?.diagnostics && (
                      <div className="imp-diag">
                        {formatDiagnostics(parsed.diagnostics)}
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* Ziel-Zeichnungsebene. */}
              {hasDrawings && (
                <section className="imp-section">
                  <div className="imp-section-title">
                    {t("import.target.heading")}
                  </div>
                  <label className="imp-radio">
                    <input
                      type="radio"
                      name="imp-target"
                      checked={targetKind === "existing"}
                      onChange={() => setTargetKind("existing")}
                    />
                    <span>{t("import.target.existing")}</span>
                  </label>
                  {targetKind === "existing" && (
                    <Dropdown
                      value={existingLevelId}
                      onChange={(v) => setExistingLevelId(v)}
                      title={t("import.target.existing")}
                      options={project.drawingLevels.map((z) => ({
                        value: z.id,
                        label: `${z.name} · ${t(kindBadgeKey(z.kind))}`,
                      }))}
                    />
                  )}
                  <label className="imp-radio">
                    <input
                      type="radio"
                      name="imp-target"
                      checked={targetKind === "new"}
                      onChange={() => setTargetKind("new")}
                    />
                    <span>{t("import.target.new")}</span>
                  </label>
                  {targetKind === "new" && (
                    <input
                      type="text"
                      className="imp-input"
                      value={newName}
                      placeholder={t("import.target.newNamePlaceholder")}
                      onChange={(e) => setNewName(e.target.value)}
                      aria-label={t("import.target.newNamePlaceholder")}
                    />
                  )}
                </section>
              )}

              {/* Ebenen-Handling (DXF-Layer → Kategorien). */}
              {hasDrawings && (
                <section className="imp-section">
                  <div className="imp-section-title">
                    {t("import.layers.heading")}
                  </div>
                  <label className="imp-radio">
                    <input
                      type="radio"
                      name="imp-cat"
                      checked={categoryMode === "byLayer"}
                      disabled={layers.length === 0}
                      onChange={() => setCategoryMode("byLayer")}
                    />
                    <span>{t("import.layers.asCategories")}</span>
                  </label>
                  <label className="imp-radio">
                    <input
                      type="radio"
                      name="imp-cat"
                      checked={categoryMode === "active"}
                      onChange={() => setCategoryMode("active")}
                    />
                    <span>
                      {t("import.layers.toActive", { code: activeCategoryCode })}
                    </span>
                  </label>
                </section>
              )}

              {/* Mesh-Behandlung. */}
              {hasMeshes && (
                <section className="imp-section">
                  <div className="imp-section-title">
                    {t("import.mesh.heading")}
                  </div>
                  <label className="imp-check">
                    <input
                      type="checkbox"
                      checked={importMeshes}
                      onChange={(e) => setImportMeshes(e.target.checked)}
                    />
                    <span>{t("import.mesh.asContext")}</span>
                  </label>
                  <div className="imp-note">{t("import.mesh.note")}</div>
                </section>
              )}
            </>
          )}
        </div>

        <footer className="imp-foot">
          <button className="imp-btn" onClick={onClose}>
            {t("import.cancel")}
          </button>
          <button
            className="imp-btn primary"
            onClick={onConfirm}
            disabled={!canImport}
          >
            {t("import.confirm")}
          </button>
        </footer>
      </div>
    </div>
  );
}

/**
 * Baut aus einer Import-Entscheidung die fertigen Drawing2D-Elemente für die
 * Ziel-Ebene `levelId`. `byLayer` mappt jeden DXF-Layer-Namen deterministisch
 * auf einen Kategorie-Code: existiert eine Kategorie mit passendem Namen, wird
 * deren Code genutzt; sonst fällt der Layer auf den aktiven Code zurück.
 *
 * (Die App ruft diese Funktion, NACHDEM sie ggf. die neue Ebene angelegt hat —
 * sie braucht die echte Ziel-`levelId`.)
 */
export function buildDrawings(
  decision: ImportDecision,
  levelId: string,
  project: Project,
  activeCategoryCode: string,
) {
  // Layer-Name → Kategorie-Code: bevorzugt eine Kategorie mit demselben Namen
  // (case-insensitiv), sonst der aktive Code. Identifier bleiben so stabil.
  const byName = new Map<string, string>();
  for (const c of project.layers) byName.set(c.name.toLowerCase(), c.code);
  const layerToCode = (layerName: string): string =>
    byName.get(layerName.toLowerCase()) ?? activeCategoryCode;
  const fromContours = contoursToDrawings(
    decision.parsed.contours,
    levelId,
    decision.categoryMode,
    activeCategoryCode,
    layerToCode,
  );
  const fromTexts = textsToDrawings(
    decision.parsed.texts ?? [],
    levelId,
    decision.categoryMode,
    activeCategoryCode,
    layerToCode,
  );
  return [...fromContours, ...fromTexts];
}

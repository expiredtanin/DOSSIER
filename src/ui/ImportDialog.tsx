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
import { flattenCategories } from "../model/types";
import type { DxfImportResult, ImportDiagnostics } from "../io/dxfParser";
import {
  contoursToDrawings,
  textsToDrawings,
  countContours,
  distinctLayers,
} from "../io/dxfToDrawings";
import type { CategoryMode } from "../io/dxfToDrawings";
import { Dropdown } from "./Dropdown";
import { PDF_SCALES, PT_TO_MM } from "../io/pdfVector";

/** Vektor-PDF ([76]): Seite und Massstab, nach denen `parsed` aus dem PDF abgeleitet wurde. */
export interface PdfImportOptions {
  pageCount: number;
  /** 0-basiert. */
  page: number;
  /** Massstabszahl (100 = 1:100). */
  scale: number;
  /** Angezeigte Seitengrösse in pt. */
  widthPt: number;
  heightPt: number;
  /** Bilder auf der Seite (werden nicht übernommen). */
  images: number;
}

/** Strukturierte Import-Entscheidung, die der Dialog beim Bestätigen liefert. */
export interface ImportDecision {
  /** Ziel: bestehende Ebene (id) ODER neue Zeichnung (name). */
  target: { kind: "existing"; levelId: string } | { kind: "new"; name: string };
  /** Wie DXF-Layer auf Kategorien abgebildet werden. */
  categoryMode: CategoryMode;
  /** Ob die Meshes als Kontext-Geometrie übernommen werden. */
  importMeshes: boolean;
  /**
   * Platzierung der importierten Geometrie: `origin` = 1:1 an den DXF-Koordinaten
   * (relativ zum Nullpunkt); `viewCenter` = der Gesamt-Umriss wird in die Mitte
   * des aktuellen Ausschnitts geschoben.
   */
  placement: "origin" | "viewCenter";
  /** Die geparsten Konturen-Sätze (für die spätere 2D-Konvertierung). */
  parsed: DxfImportResult;
}

/**
 * Übersetzt den groben Phasencode aus `parseDxfAsync`'s `onProgress`
 * (`"structure"` | `"parse-single"` | `"parse-parallel:<N>"`) in einen
 * sichtbaren Status-Text. `null` = noch keine Phase bekannt (ganz am Anfang,
 * bevor der erste Fortschritts-Callback feuert) — der Aufrufer zeigt dann
 * den generischen `import.loading.hint`.
 */
function dxfProgressText(progress: string | undefined): string | null {
  if (!progress) return null;
  if (progress === "pdf") return t("import.pdf.loading");
  if (progress === "structure") return t("import.loading.phase.structure");
  if (progress === "parse-single") return t("import.loading.phase.parseSingle");
  const m = /^parse-parallel:(\d+)$/.exec(progress);
  if (m) return t("import.loading.phase.parseParallel", { n: m[1] });
  return null;
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
   * true, wenn eine DWG-Datei NICHT gelesen werden konnte (das Format-Modul schlug
   * fehl) → ODA-Hinweis als Fallback. Bei erfolgreichem DWG-Parsing ist das false
   * und `parsed` enthält das Ergebnis (gleicher Fluss wie DXF).
   */
  isDwg: boolean;
  /** true, solange eine DWG-Datei noch geparst wird (WASM lädt/läuft). */
  loading?: boolean;
  /** Grober Phasenname während `loading` (nur DXF, s. `dxfParserAsync.ts`'s
   *  `onProgress`) — `"structure"`, `"parse-single"` oder
   *  `"parse-parallel:<N>"`; `undefined` = noch keine Phase bekannt/DWG. */
  progress?: string;
  /** Meldung des Format-Moduls, wenn die Datei nicht gelesen werden konnte (leer, beschädigt …). */
  error?: string;
  /** Wählt ein Papierbereich-Layout (Name) oder den Modellraum (`null`) zum Import; liest neu. */
  onSelectLayout?: (layout: string | null) => void;
  /** Geparstes Ergebnis (null während Laden / bei DWG-Parse-Fehler). */
  parsed: DxfImportResult | null;
  /** Vektor-PDF ([76]): Seite/Massstab; `onPdfChange` liest neu bzw. rechnet um. */
  pdf?: PdfImportOptions;
  onPdfChange?: (page: number, scale: number) => void;
  project: Project;
  activeCategoryCode: string;
  onImport: (decision: ImportDecision) => void;
  onClose: () => void;
}

export function ImportDialog({
  fileName,
  isDwg,
  loading = false,
  progress,
  error,
  onSelectLayout,
  parsed,
  pdf,
  onPdfChange,
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
  // Standard folgt den DXF-Layern, SOBALD sie geparst sind: der Dialog öffnet sich
  // schon während des Parsens (`layers` dann noch leer) — ein einmaliger useState-
  // Startwert blieb deshalb dauerhaft auf "alles auf die aktive Kategorie". Erst
  // eine ausdrückliche Wahl des Nutzers überschreibt den abgeleiteten Wert.
  const [categoryModeChoice, setCategoryMode] = useState<CategoryMode | null>(null);
  const categoryMode: CategoryMode = categoryModeChoice ?? (layers.length > 0 ? "byLayer" : "active");
  const [importMeshes, setImportMeshes] = useState<boolean>(true);
  const [placement, setPlacement] = useState<"origin" | "viewCenter">("origin");
  // Zwischen Klick auf „Importieren" und dem (synchronen, u. U. mehrere
  // Sekunden dauernden — Drawings ins Projekt einhängen + Plan/3D neu bauen)
  // `onImport`: zeigt einen Ladehinweis, STATT sofort zu blockieren (Nutzer-
  // Report 2026-10-09: nach Klick auf „Importieren" keine Rückmeldung, nicht
  // unterscheidbar von einem Hänger). Zwei `requestAnimationFrame` statt direktem Aufruf geben
  // dem Browser einen Frame, um diesen Zustand VOR dem schweren synchronen
  // Teil zu malen — sonst würde React den State-Update-Commit gar nicht mehr
  // vor dem Block zum Zug kommen lassen.
  const [applying, setApplying] = useState(false);
  // Freier PDF-Massstab (Texteingabe „1:75" oder „75"), angewandt bei Enter/Verlassen.
  const [customScaleText, setCustomScaleText] = useState("");
  const applyCustomScale = () => {
    const n = Number(customScaleText.trim().replace(/^1\s*:\s*/, ""));
    if (pdf && onPdfChange && Number.isFinite(n) && n > 0) onPdfChange(pdf.page, n);
  };

  const canImport =
    !isDwg && !loading && !applying && (hasDrawings || (hasMeshes && importMeshes));

  const onConfirm = () => {
    if (!parsed || !canImport) return;
    const target =
      targetKind === "existing"
        ? ({ kind: "existing", levelId: existingLevelId } as const)
        : ({ kind: "new", name: newName } as const);
    setApplying(true);
    // Zwei Frames warten: erst dann ist der "Importiere …"-Zustand tatsächlich
    // GEMALT. Ein setTimeout(0) feuert oft vor dem Paint — der Dialog sah dann
    // bis zum Ende des (blockierenden) Imports unverändert eingefroren aus.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => onImport({ target, categoryMode, importMeshes, placement, parsed })),
    );
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

          {applying ? (
            // Klick auf „Importieren" ist erfolgt, `onImport` (synchron,
            // Drawings einhängen + Plan/3D neu bauen) läuft gleich — derselbe
            // Ladehinweis wie beim Parsen, damit dieser Schritt nicht wie ein
            // Hänger aussieht (s. Kommentar bei `applying` oben).
            <section className="imp-section">
              <div className="imp-section-title">{t("import.applying.heading")}</div>
              <div className="imp-dwg-hint">{t("import.applying.hint")}</div>
            </section>
          ) : loading ? (
            // Datei wird gelesen/geparst (DWG: WASM; DXF: Web Worker, s.
            // dxfParserAsync.ts) → Ladehinweis, nur Abbrechen. `progress`
            // (nur DXF) macht die Phase sichtbar (Nutzer-Report 2026-10-09:
            // "keine Rückmeldung, kein Status" — ohne das sieht ein mehrere
            // Sekunden dauernder Import wie ein Hänger aus).
            <section className="imp-section">
              <div className="imp-section-title">
                {t(isDwg ? "import.dwg.heading" : "import.loading.heading")}
              </div>
              <div className="imp-dwg-hint">
                {isDwg
                  ? t("import.dwg.loading")
                  : dxfProgressText(progress) ?? t("import.loading.hint")}
              </div>
            </section>
          ) : isDwg ? (
            // DWG konnte nicht gelesen werden → ODA-Fallback-Hinweis.
            <section className="imp-section">
              <div className="imp-section-title">{t("import.dwg.heading")}</div>
              {error && <div className="imp-warn">{error}</div>}
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
                {parsed?.recovered && <div className="imp-warn">{t("import.summary.recovered")}</div>}
                {!hasDrawings && !hasMeshes && (
                  <div className="imp-warn">
                    {error ?? t("import.summary.empty")}
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

              {/* Vektor-PDF ([76]): Seite und Massstab (pt → m: 25.4/72 mm Papier × Massstab). */}
              {pdf && onPdfChange && (
                <section className="imp-section">
                  <div className="imp-section-title">{t("import.pdf.heading")}</div>
                  {pdf.pageCount > 1 && (
                    <Dropdown
                      value={String(pdf.page)}
                      onChange={(v) => onPdfChange(Number(v), pdf.scale)}
                      title={t("import.pdf.page")}
                      options={Array.from({ length: pdf.pageCount }, (_, i) => ({
                        value: String(i),
                        label: t("import.pdf.pageOf", { n: i + 1, total: pdf.pageCount }),
                      }))}
                    />
                  )}
                  <Dropdown
                    value={String(pdf.scale)}
                    onChange={(v) => onPdfChange(pdf.page, Number(v))}
                    title={t("import.pdf.scale")}
                    triggerClassName="tb-dd-mono"
                    options={[
                      ...((PDF_SCALES as readonly number[]).includes(pdf.scale)
                        ? []
                        : [{ value: String(pdf.scale), label: `1:${pdf.scale}` }]),
                      ...PDF_SCALES.map((n) => ({ value: String(n), label: `1:${n}` })),
                    ]}
                  />
                  <div className="imp-scale-custom">
                    <input
                      className="imp-input"
                      type="text"
                      placeholder={t("import.pdf.scaleFree")}
                      aria-label={t("import.pdf.scaleFree")}
                      value={customScaleText}
                      onChange={(e) => setCustomScaleText(e.target.value)}
                      onBlur={applyCustomScale}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") applyCustomScale();
                      }}
                    />
                  </div>
                  <div className="imp-note">
                    {t("import.pdf.size", {
                      w: Math.round(pdf.widthPt * PT_TO_MM),
                      h: Math.round(pdf.heightPt * PT_TO_MM),
                      mw: ((pdf.widthPt * PT_TO_MM * pdf.scale) / 1000).toFixed(2),
                      mh: ((pdf.heightPt * PT_TO_MM * pdf.scale) / 1000).toFixed(2),
                    })}
                  </div>
                  {pdf.images > 0 && <div className="imp-note">{t("import.pdf.images", { n: pdf.images })}</div>}
                  <div className="imp-dwg-hint">{t("import.pdf.note")}</div>
                </section>
              )}

              {/* Papierbereich: Layouts der Datei (Bericht) und, wenn möglich, eines statt des Modellraums lesen. */}
              {parsed?.layouts && parsed.layouts.length > 0 && (
                <section className="imp-section">
                  <div className="imp-section-title">{t("import.layouts.heading")}</div>
                  {onSelectLayout ? (
                    <Dropdown
                      value={parsed.layout ?? ""}
                      onChange={(v) => onSelectLayout(v === "" ? null : v)}
                      title={t("import.layouts.heading")}
                      options={[
                        { value: "", label: t("import.layouts.model") },
                        ...parsed.layouts.map((l) => ({
                          value: l.name,
                          label: `${l.name} · ${t("import.layouts.entities", { n: l.entities })}`,
                        })),
                      ]}
                    />
                  ) : (
                    <ul className="imp-summary">
                      {parsed.layouts.map((l) => (
                        <li key={l.name}>{`${l.name} · ${t("import.layouts.entities", { n: l.entities })}`}</li>
                      ))}
                    </ul>
                  )}
                  <div className="imp-dwg-hint">{t("import.layouts.note")}</div>
                </section>
              )}

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

              {/* Platzierung: an den DXF-Koordinaten (relativ zu 0) ODER in die
                  Mitte des aktuellen Ausschnitts geschoben. */}
              {hasDrawings && (
                <section className="imp-section">
                  <div className="imp-section-title">
                    {t("import.placement.heading")}
                  </div>
                  <label className="imp-radio">
                    <input
                      type="radio"
                      name="imp-place"
                      checked={placement === "origin"}
                      onChange={() => setPlacement("origin")}
                    />
                    <span>{t("import.placement.origin")}</span>
                  </label>
                  <label className="imp-radio">
                    <input
                      type="radio"
                      name="imp-place"
                      checked={placement === "viewCenter"}
                      onChange={() => setPlacement("viewCenter")}
                    />
                    <span>{t("import.placement.viewCenter")}</span>
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
          <button className="imp-btn" onClick={onClose} disabled={applying}>
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
  codeByLayer?: ReadonlyMap<string, string>,
) {
  // Layer-Name → Kategorie-Code: bevorzugt eine Kategorie mit demselben Namen
  // (case-insensitiv), sonst der aktive Code. Identifier bleiben so stabil.
  // `flattenCategories`, NICHT `project.layers` direkt: manche Kategorien
  // (z. B. „Gebäude"/„Situation") liegen als KINDER unter „05 Kontext" (s.
  // sampleProject.ts) — ein flacher Scan hätte sie beim Namensabgleich
  // übersehen (Regression, beim Verschachteln der Kontext-Kategorien
  // gefunden).
  const byName = new Map<string, string>();
  for (const c of flattenCategories(project.layers)) byName.set(c.name.toLowerCase(), c.code);
  // `codeByLayer` (aus `planImportCategories`) hat Vorrang: dort sind auch die
  // beim Import NEU angelegten Kategorien enthalten, die `project` hier (Stand
  // vor dem Import) noch nicht kennt.
  const layerToCode = (layerName: string): string =>
    codeByLayer?.get(layerName) ?? byName.get(layerName.toLowerCase()) ?? activeCategoryCode;
  const fillColors = decision.parsed.layerFillColors;
  const fromContours = contoursToDrawings(
    decision.parsed.contours,
    levelId,
    decision.categoryMode,
    activeCategoryCode,
    layerToCode,
    fillColors ? (layer) => fillColors[layer] : undefined,
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

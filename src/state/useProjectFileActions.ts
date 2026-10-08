// Bündelt Projektdatei-I/O (Speichern/Öffnen/Schreib-Lock der .obp/.json-
// Datei), den Schnellexport (CSV/IFC/OBJ/STL) sowie die Ausführung eines
// bestätigten DXF/DWG-Imports (`runImport`). Nur aus App() herausgezogen, um
// die Funktion zu entlasten — reine Zustands-/Aktions-Bündelung, keine
// Verhaltensänderung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { t } from "../i18n";
import type { DxfImportResult } from "../io/dxfParser";
import { parseDxfAsync } from "../io/dxfParserAsync";
import { buildDrawings } from "../ui/ImportDialog";
import type { ImportDecision } from "../ui/ImportDialog";
import { exportScheduleCsv } from "../export/exportSchedule";
import { exportIfcSpf } from "../export/exportIfc";
import { exportObj, exportStl } from "../export/exportMesh";
import type { ExportSaveFormat } from "../ui/ExportSaveDialog";
import { saveTextFile } from "../io/saveFile";
import {
  saveProjectFile,
  openProjectFileNative,
  openProjectFileAtPath,
  openProjectTemplateNative,
  acquireProjectLock,
  releaseProjectLock,
  registerLockAutoRelease,
  isTauriRuntime,
} from "../io/projectFile";
import type { LockInfo } from "../io/projectFile";
import { addRecentProject, removeRecentProject } from "./recentProjects";
import { emptyProject, sampleProject } from "../model/sampleProject";
import type { ContextObject, Drawing2D, Project, Vec2 } from "../model/types";
import type { PlanViewHandle } from "../plan/PlanView";

/** Umriss (bbox) aller Drawing2D-Geometrien in Modell-Metern (null = leer). */
function drawingsBBox(
  drawings: Drawing2D[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const acc = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const d of drawings) {
    const g = d.geom;
    if (g.shape === "line" || g.shape === "xline" || g.shape === "ray") { acc(g.a.x, g.a.y); acc(g.b.x, g.b.y); }
    else if (g.shape === "polyline") for (const p of g.pts) acc(p.x, p.y);
    else if (g.shape === "rect") { acc(g.min.x, g.min.y); acc(g.max.x, g.max.y); }
    else if (g.shape === "circle" || g.shape === "arc") {
      acc(g.center.x - g.r, g.center.y - g.r);
      acc(g.center.x + g.r, g.center.y + g.r);
    } else if (g.shape === "ellipse") {
      acc(g.center.x - g.rx, g.center.y - g.ry);
      acc(g.center.x + g.rx, g.center.y + g.ry);
    } else if (g.shape === "bezier" || g.shape === "spline") {
      for (const p of g.pts) acc(p.x, p.y);
    } else if (g.shape === "dimension") {
      for (const p of g.pts) acc(p.x, p.y);
    } else if (g.shape === "kote") acc(g.at.x, g.at.y);
    else if (g.shape === "detailref") acc(g.at.x, g.at.y);
    else if (g.shape === "scalebar") {
      acc(g.at.x, g.at.y);
      acc(g.at.x + g.segmentLength * g.segments, g.at.y);
    }
    else if (g.shape === "pointmarker") acc(g.at.x, g.at.y);
    else if (g.shape === "text") acc(g.at.x, g.at.y);
    else if (g.shape === "block") acc(g.at.x, g.at.y);
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}

/** Ein Drawing2D um (dx,dy) in Modell-Metern verschieben (alle Formen). */
function translateDrawing(d: Drawing2D, dx: number, dy: number): Drawing2D {
  const mv = (p: Vec2): Vec2 => ({ x: p.x + dx, y: p.y + dy });
  const g = d.geom;
  switch (g.shape) {
    case "line": return { ...d, geom: { ...g, a: mv(g.a), b: mv(g.b) } };
    case "xline": return { ...d, geom: { ...g, a: mv(g.a), b: mv(g.b) } };
    case "ray": return { ...d, geom: { ...g, a: mv(g.a), b: mv(g.b) } };
    case "polyline": return { ...d, geom: { ...g, pts: g.pts.map(mv) } };
    case "rect": return { ...d, geom: { ...g, min: mv(g.min), max: mv(g.max) } };
    case "circle": return { ...d, geom: { ...g, center: mv(g.center) } };
    case "arc": return { ...d, geom: { ...g, center: mv(g.center) } };
    case "ellipse": return { ...d, geom: { ...g, center: mv(g.center) } };
    case "bezier": return { ...d, geom: { ...g, pts: g.pts.map(mv) } };
    case "spline": return { ...d, geom: { ...g, pts: g.pts.map(mv) } };
    case "dimension": return { ...d, geom: { ...g, pts: g.pts.map(mv) } };
    case "kote": return { ...d, geom: { ...g, at: mv(g.at) } };
    case "detailref": return { ...d, geom: { ...g, at: mv(g.at) } };
    case "scalebar": return { ...d, geom: { ...g, at: mv(g.at) } };
    case "pointmarker": return { ...d, geom: { ...g, at: mv(g.at) } };
    case "text":
      return {
        ...d,
        geom: {
          ...g,
          at: mv(g.at),
          ...(g.leaderTarget ? { leaderTarget: mv(g.leaderTarget) } : {}),
          ...(g.leaderBendPoints ? { leaderBendPoints: g.leaderBendPoints.map(mv) } : {}),
          ...(g.pathPts ? { pathPts: g.pathPts.map(mv) } : {}),
        },
      };
    case "block": return { ...d, geom: { ...g, at: mv(g.at) } };
    default: return d;
  }
}

/** Modaler Import-Dialog-Zustand (DXF/DWG) — dieselbe Form wie in useDialogState. */
export type ImportDialogState = {
  fileName: string;
  isDwg: boolean;
  parsed: DxfImportResult | null;
  loading?: boolean;
} | null;

export function useProjectFileActions(
  project: Project,
  setProject: (next: Project | ((p: Project) => Project)) => void,
  setImportState: (next: ImportDialogState) => void,
  setExportSaveFormat: (format: ExportSaveFormat | null) => void,
  activeCategoryCode: string,
  addDrawingLevel: (name: string) => string,
  importDrawings: (drawings: Drawing2D[]) => void,
  addContextObjects: (objs: ContextObject[]) => void,
  setActiveLevelId: (id: string) => void,
  planViewRef: RefObject<PlanViewHandle | null>,
) {
  // Verstecktes Datei-Input zum Laden eines Projekts (Datei-Burger „Öffnen").
  // Wird NUR im Browser-Pfad benutzt (ohne Tauri) — unter Tauri geht „Öffnen"
  // über den nativen Dialog (openProjectFileNative), der einen echten Pfad für
  // den Lock liefert (File-API im Browser hat keinen echten Dateipfad).
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  // Verstecktes Datei-Input für „Neu aus Vorlage" (Datei wählen) — derselbe
  // Browser-Fallback wie `projectFileInputRef`, nur mit `.obpt`-Filter.
  const projectTemplateFileInputRef = useRef<HTMLInputElement>(null);
  // Pfad + Lock-Status der aktuell offenen .obp/.json-Datei (nur Tauri; sonst
  // bleibt beides null/false — Browser-Blob-Pfad hat keinen echten Pfad).
  const openedProjectPathRef = useRef<string | null>(null);
  const projectLockOwnedRef = useRef(false);
  // Konflikt-Zustand: Datei ist in einer anderen Instanz gesperrt → Dialog mit
  // „Schreibgeschützt öffnen"/„Trotzdem erzwingen"/„Abbrechen" (kein window.confirm!).
  const [lockConflict, setLockConflict] = useState<{
    path: string;
    content: string;
    info: LockInfo | null;
  } | null>(null);
  // Referenz-Identität des zuletzt gespeicherten/geladenen Projekt-Stands.
  // `setProject` liefert bei JEDER echten Änderung eine NEUE `Project`-Referenz
  // (structural sharing, s. historySlice.ts) — ein reiner `!==`-Vergleich
  // genügt daher als billiger "ungespeicherte Änderungen"-Test, ganz ohne
  // JSON-Diff. Start = das beim allerersten Render aktive Projekt (Startzustand
  // gilt als "gespeichert", noch nichts zu verlieren).
  const lastSavedProjectRef = useRef(project);
  // Eine verworfene Aktion (Neu/Öffnen), die erst nach Bestätigung des
  // "Ungespeicherte Änderungen"-Dialogs ausgeführt wird — s. `guardDiscard`.
  const [pendingDiscard, setPendingDiscard] = useState<(() => void) | null>(null);
  /**
   * Führt `action` (Projekt ERSETZEN — Neu/Öffnen) nur direkt aus, wenn seit
   * dem letzten Speichern/Laden nichts geändert wurde; sonst wird sie als
   * `pendingDiscard` geparkt und der Nutzer über `UnsavedChangesDialog`
   * gefragt (Speichern/Nicht speichern/Abbrechen) — ersetzt das bisherige
   * kommentarlose Überschreiben (Bug: Cmd+N löschte bisher stillschweigend).
   */
  const guardDiscard = (action: () => void) => {
    if (project !== lastSavedProjectRef.current) setPendingDiscard(() => action);
    else action();
  };

  // Best-effort Lock-Freigabe beim Fenster-Schliessen (sauberes Timing; der
  // OS-Lock fällt bei Prozessende/Absturz ohnehin automatisch weg). No-op ohne Tauri.
  useEffect(() => {
    registerLockAutoRelease(() => openedProjectPathRef.current);
  }, []);

  // Eine Datei (Button ODER Drop) öffnet den modalen Import-Dialog. DXF wird als
  // Text geparst, DWG als ArrayBuffer über LibreDWG-WASM (lazy, asynchron); beide
  // münden in dasselbe {meshes, contours}-Format und denselben Dialog-Fluss.
  // Parse-Fehler werden ruhig abgefangen: DWG fällt auf den ODA-Hinweis zurück.
  const openImportForFile = (file: File) => {
    const isDwg = /\.dwg$/i.test(file.name);
    if (isDwg) {
      // Async-Zustand: Dialog öffnet sofort und zeigt „DWG wird gelesen …",
      // während WASM lädt/parst. Danach echte Zusammenfassung ODER ODA-Hinweis.
      setImportState({
        fileName: file.name,
        isDwg: true,
        parsed: null,
        loading: true,
      });
      const r = new FileReader();
      r.onload = () => {
        const buf = r.result;
        if (!(buf instanceof ArrayBuffer)) {
          setImportState({
            fileName: file.name,
            isDwg: true,
            parsed: null,
            loading: false,
          });
          return;
        }
        // Dynamisch importieren, damit LibreDWG-WASM nicht im Initial-Bundle ist.
        import("../io/dwgParser")
          .then(({ parseDwg }) => parseDwg(buf))
          .then((parsed) => {
            setImportState({
              fileName: file.name,
              isDwg: false,
              parsed,
              loading: false,
            });
          })
          .catch((err) => {
            console.error("DWG-Import fehlgeschlagen:", err);
            // Fallback: weiterhin DWG-Modus → Dialog zeigt den ODA-Hinweis.
            setImportState({
              fileName: file.name,
              isDwg: true,
              parsed: null,
              loading: false,
            });
          });
      };
      r.readAsArrayBuffer(file);
      return;
    }
    // Async-Zustand (identisches Muster zum DWG-Zweig oben): Dialog öffnet
    // sofort und zeigt einen Ladehinweis, während `parseDxf` in einem Web
    // Worker läuft — bei sehr grossen Dateien (Kataster-Import einer ganzen
    // Stadt, Nutzer-Report 2026-10-08) blockierte das zuvor für die GESAMTE
    // Parse-Dauer den Haupt-Thread/die UI (s. `io/dxfParserAsync.ts`).
    setImportState({ fileName: file.name, isDwg: false, parsed: null, loading: true });
    const r = new FileReader();
    r.onload = () => {
      parseDxfAsync(String(r.result ?? ""))
        .then((parsed) => {
          setImportState({ fileName: file.name, isDwg: false, parsed, loading: false });
        })
        .catch((err) => {
          console.error("DXF-Import fehlgeschlagen:", err);
          const parsed: DxfImportResult = { meshes: [], contours: [] };
          setImportState({ fileName: file.name, isDwg: false, parsed, loading: false });
        });
    };
    r.readAsText(file);
  };

  // Projekt als Datei speichern/laden (Datei-Burger-Menü, TopBar/AppMenu).
  // Reines JSON des ProjectSlice-Zustands. Eigene Endung „.obp" (openbureau
  // project) statt generischem „.json" — unter Tauri über den nativen
  // Speichern-/Öffnen-Dialog mit passendem Datei-Filter (saveProjectFile/
  // openProjectFileNative in io/projectFile.ts), im Browser Blob-Download wie
  // bisher. Laden parst die Datei und ersetzt das Projekt — nur ein grobes
  // Shape-Sanity-Check (walls/layers als Array), damit ein fremdes/kaputtes
  // JSON nicht die App zerlegt. Alte „.json"-Projekte bleiben ladbar (Filter
  // erlaubt beide Endungen).
  // Liefert `true`, wenn wirklich gespeichert wurde (nicht bei abgebrochenem
  // nativem Dialog) — `guardDiscard`-Aufrufer verlassen sich darauf, um NICHT
  // zu verwerfen, wenn der Nutzer den Speichern-Dialog abbricht.
  const onSaveProject = (): Promise<boolean> => {
    const json = JSON.stringify(project, null, 2);
    return saveProjectFile(json, project.name, (path) =>
      addRecentProject(path, project.name || "modell"),
    ).then((saved) => {
      if (saved) lastSavedProjectRef.current = project;
      return saved;
    });
  };
  // „Neu" (Datei-Menü): leeres Projekt, wie am Startbildschirm — löst dabei
  // einen evtl. gehaltenen Datei-Lock der bisherigen Projektdatei und vergisst
  // deren Pfad (das leere Projekt ist noch NICHT gespeichert). Über
  // `guardDiscard`: bei ungespeicherten Änderungen erst der Dialog, s. o.
  const onNewProject = () => guardDiscard(() => {
    releaseCurrentProjectLock();
    setProject(emptyProject);
    lastSavedProjectRef.current = emptyProject;
  });

  // Übernimmt ein neues, noch UNGESPEICHERTES Projekt aus Vorlagen-Inhalt
  // (Musterhaus ODER eine gewählte `.obpt`-Datei): grobe Form-Prüfung wie beim
  // normalen Öffnen, aber bewusst OHNE Pfad/Lock zu setzen — die Vorlage
  // bleibt unangetastet, das nächste „Speichern" fragt nach einem neuen Ort.
  // Ersetzt ebenfalls das bisherige Projekt → über `guardDiscard`.
  const applyTemplateContent = (content: string): boolean => {
    try {
      const parsed = JSON.parse(content) as Partial<Project>;
      if (!Array.isArray(parsed.walls) || !Array.isArray(parsed.layers)) {
        console.warn("Vorlagen-Datei hat kein gültiges Projekt-Format (walls/layers fehlen).");
        return false;
      }
      guardDiscard(() => {
        releaseCurrentProjectLock();
        setProject(parsed as Project);
        lastSavedProjectRef.current = parsed as Project;
      });
      return true;
    } catch (err) {
      console.error("Vorlage konnte nicht geladen werden:", err);
      return false;
    }
  };
  // „Neu aus Vorlage: Musterhaus" — das eingebaute Demo-Haus (model/sampleProject.ts)
  // als Start eines neuen Projekts. `structuredClone`, damit spätere Bearbeitung
  // nicht das gemeinsame Modul-Singleton mutiert (es dient auch als Store-
  // Startzustand, s. state/projectSlice.ts).
  const onNewProjectFromSample = () => guardDiscard(() => {
    releaseCurrentProjectLock();
    const next = structuredClone(sampleProject);
    setProject(next);
    lastSavedProjectRef.current = next;
  });
  // „Neu aus Vorlage: Datei wählen…" — native `.obpt`-Dialog unter Tauri, sonst
  // das versteckte `<input type=file>` (projectTemplateFileInputRef).
  const onNewProjectFromTemplate = () => {
    if (isTauriRuntime()) {
      void (async () => {
        let opened: Awaited<ReturnType<typeof openProjectTemplateNative>>;
        try {
          opened = await openProjectTemplateNative();
        } catch (err) {
          console.error("Vorlage konnte nicht geöffnet werden:", err);
          return;
        }
        if (opened) applyTemplateContent(opened.content);
      })();
    } else {
      projectTemplateFileInputRef.current?.click();
    }
  };
  const onProjectTemplateFileChosen = (file: File) => {
    const r = new FileReader();
    r.onload = () => applyTemplateContent(String(r.result ?? ""));
    r.readAsText(file);
  };

  // Gibt den Lock der zuletzt geöffneten Projektdatei frei (falls wir ihn
  // halten) und vergisst den Pfad — vor dem Wechsel auf ein anderes Projekt.
  const releaseCurrentProjectLock = () => {
    if (openedProjectPathRef.current && projectLockOwnedRef.current) {
      void releaseProjectLock(openedProjectPathRef.current);
    }
    openedProjectPathRef.current = null;
    projectLockOwnedRef.current = false;
  };
  // Übernimmt ein per Pfad geöffnetes Projekt (Tauri-Fluss): parst, prüft grob
  // die Form, gibt einen evtl. vorher gehaltenen Lock frei und merkt sich Pfad
  // + ob WIR den Schreib-Lock für die neue Datei halten.
  const applyOpenedProjectFile = (path: string, content: string, lockOwned: boolean) => {
    try {
      const parsed = JSON.parse(content) as Partial<Project>;
      if (!Array.isArray(parsed.walls) || !Array.isArray(parsed.layers)) {
        console.warn("Projekt-Datei hat kein gültiges Projekt-Format (walls/layers fehlen).");
        return;
      }
      guardDiscard(() => {
        releaseCurrentProjectLock();
        setProject(parsed as Project);
        lastSavedProjectRef.current = parsed as Project;
        openedProjectPathRef.current = path;
        projectLockOwnedRef.current = lockOwned;
        addRecentProject(path, (parsed as Project).name || "modell");
      });
    } catch (err) {
      console.error("Projekt-Import fehlgeschlagen:", err);
    }
  };
  // Öffnen unter Tauri: nativer Dialog (echter Pfad) → Lock versuchen. Klappt
  // er → Projekt übernehmen. Schon gesperrt → Konflikt-Dialog (kein
  // window.confirm!) mit „Schreibgeschützt öffnen"/„Trotzdem erzwingen"/
  // „Abbrechen". Beide „öffnen"-Optionen übernehmen das Projekt ohne eigenen
  // Lock (die andere Instanz hält ihn) — „erzwingen" bewusst mit Warn-Hinweis
  // im Dialog, „schreibgeschützt" als sichere Standardwahl.
  const openProjectViaNativeDialog = async () => {
    let opened: Awaited<ReturnType<typeof openProjectFileNative>>;
    try {
      opened = await openProjectFileNative();
    } catch (err) {
      console.error(t("file.openFailed"), err);
      return;
    }
    if (!opened) return; // Nutzer hat den Öffnen-Dialog abgebrochen
    const lock = await acquireProjectLock(opened.path);
    if (lock.ok) {
      applyOpenedProjectFile(opened.path, opened.content, true);
    } else {
      setLockConflict({ path: opened.path, content: opened.content, info: lock.info });
    }
  };
  // Öffnen über einen BEKANNTEN Pfad (Startbildschirm/„Zuletzt geöffnet",
  // s. ui/StartScreen.tsx) — kein Dialog, sonst identischer Lock-Fluss wie
  // `openProjectViaNativeDialog`. Ist die Datei nicht mehr lesbar (gelöscht/
  // verschoben), wird der verwaiste Eintrag aus der Liste entfernt.
  const openProjectAtPath = async (path: string): Promise<boolean> => {
    const opened = await openProjectFileAtPath(path);
    if (!opened) {
      removeRecentProject(path);
      return false;
    }
    const lock = await acquireProjectLock(opened.path);
    if (lock.ok) {
      applyOpenedProjectFile(opened.path, opened.content, true);
    } else {
      setLockConflict({ path: opened.path, content: opened.content, info: lock.info });
    }
    return true;
  };
  // Datei speichern: unter Tauri nativer „Speichern unter"-Dialog (Ordner + Name),
  // im Browser Blob-Download-Fallback — die gesamte Logik (inkl. WKWebView-
  // Härtung: octet-stream-MIME + verzögertes revoke) steckt in saveTextFile.
  const downloadTextFile = (
    content: string,
    filename: string,
    mime = "application/octet-stream",
  ) => {
    void saveTextFile(content, filename, mime);
  };
  const projectFileName = () => project.name || "modell";
  // Führt den gewählten Direkt-Export (CSV/IFC/OBJ/STL) mit dem im Dialog
  // gewählten Dateinamen aus. Erzeugung aus dem jeweiligen reinen Kern, Download
  // über den robusten Helfer.
  const runExport = (format: ExportSaveFormat, filename: string) => {
    switch (format) {
      case "csv":
        downloadTextFile("﻿" + exportScheduleCsv(project), filename, "text/csv;charset=utf-8;");
        break;
      case "ifc":
        downloadTextFile(exportIfcSpf(project), filename);
        break;
      case "obj":
        downloadTextFile(exportObj(project), filename);
        break;
      case "stl":
        downloadTextFile(exportStl(project), filename);
        break;
    }
  };
  // Schnellexport aus dem Topbar-Menü öffnet den Format-/Dateiname-Dialog
  // (vorausgewähltes Format). PDF/DXF haben eigene Options-Dialoge.
  const onExportSchedule = () => setExportSaveFormat("csv");
  const onExportIfc = () => setExportSaveFormat("ifc");
  const onExportObj = () => setExportSaveFormat("obj");
  const onExportStl = () => setExportSaveFormat("stl");
  // Unter Tauri: nativer Öffnen-Dialog (echter Pfad → Lock möglich). Im
  // Browser: verstecktes <input type=file> wie bisher (kein echter Pfad, also
  // ohne Lock — File-API im Browser liefert keinen Dateisystempfad).
  const onOpenProject = () => {
    if (isTauriRuntime()) {
      void openProjectViaNativeDialog();
    } else {
      projectFileInputRef.current?.click();
    }
  };

  const onProjectFileChosen = (file: File) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        const parsed = JSON.parse(String(r.result ?? "")) as Partial<Project>;
        if (!Array.isArray(parsed.walls) || !Array.isArray(parsed.layers)) {
          console.warn("Projekt-Datei hat kein gültiges Projekt-Format (walls/layers fehlen).");
          return;
        }
        // Browser-Pfad hat keinen echten Dateipfad → kein Lock für die neue
        // Datei, aber ein evtl. vorher (unter Tauri) gehaltener Lock wird frei.
        guardDiscard(() => {
          releaseCurrentProjectLock();
          setProject(parsed as Project);
          lastSavedProjectRef.current = parsed as Project;
        });
      } catch (err) {
        console.error("Projekt-Import fehlgeschlagen:", err);
      }
    };
    r.readAsText(file);
  };

  // Bestätigte Import-Entscheidung ausführen: ggf. neue Zeichnung anlegen, die
  // 2D-Konturen als Drawing2D anhängen, optional die Meshes als Kontext
  // übernehmen. Reihenfolge: erst Ebene (echte ID), dann Drawings/Kontext.
  const runImport = (decision: ImportDecision) => {
    const levelId =
      decision.target.kind === "new"
        ? addDrawingLevel(decision.target.name)
        : decision.target.levelId;
    let drawings = buildDrawings(
      decision,
      levelId,
      project,
      activeCategoryCode,
    );
    // Platzierung „viewCenter": den Gesamt-Umriss so verschieben, dass seine
    // Mitte auf die Mitte des aktuellen Ausschnitts fällt (sonst bleibt alles an
    // den DXF-Koordinaten relativ zum Nullpunkt).
    if (decision.placement === "viewCenter" && drawings.length) {
      const center = planViewRef.current?.viewCenterModel();
      const bb = drawingsBBox(drawings);
      if (center && bb) {
        const dx = center.x - (bb.minX + bb.maxX) / 2;
        const dy = center.y - (bb.minY + bb.maxY) / 2;
        drawings = drawings.map((d) => translateDrawing(d, dx, dy));
      }
    }
    if (drawings.length) importDrawings(drawings);
    if (decision.importMeshes && decision.parsed.meshes.length) {
      addContextObjects(decision.parsed.meshes);
    }
    // Auf die Ziel-Ebene wechseln, damit die importierte Geometrie sichtbar ist.
    setActiveLevelId(levelId);
    setImportState(null);
  };

  return {
    projectFileInputRef,
    projectTemplateFileInputRef,
    openedProjectPathRef,
    projectLockOwnedRef,
    lockConflict,
    setLockConflict,
    pendingDiscard,
    setPendingDiscard,
    openImportForFile,
    onSaveProject,
    onNewProject,
    onNewProjectFromSample,
    onNewProjectFromTemplate,
    onProjectTemplateFileChosen,
    releaseCurrentProjectLock,
    applyOpenedProjectFile,
    openProjectViaNativeDialog,
    openProjectAtPath,
    downloadTextFile,
    projectFileName,
    runExport,
    onExportSchedule,
    onExportIfc,
    onExportObj,
    onExportStl,
    onOpenProject,
    onProjectFileChosen,
    runImport,
  };
}

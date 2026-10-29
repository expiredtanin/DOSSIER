// Bündelt Projektdatei-I/O (Speichern/Öffnen/Schreib-Lock der .obp/.json-
// Datei), den Schnellexport (CSV/IFC/OBJ/STL) sowie die Ausführung eines
// bestätigten DXF/DWG-Imports (`runImport`). Nur aus App() herausgezogen, um
// die Funktion zu entlasten — reine Zustands-/Aktions-Bündelung, keine
// Verhaltensänderung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { getState, useStore } from "./appStore";
import type { NotifyKind } from "./notifySlice";
import { serializeProject } from "../io/projectFormat";
import { AUTOSAVE_INTERVAL_MS, clearAutosave, createAutosaveTracker, readAutosave, writeAutosave } from "./autosave";
import type { AutosaveRecovery } from "./autosave";
import { useEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { t } from "../i18n";
import { parseDxfAsync } from "../io/dxfParserAsync";
import { emptyImport, type ParsedImport } from "../io/importSource";
import { beginBusy, endBusy } from "./busyStore";
import type { ImportDecision, PdfImportOptions } from "../ui/ImportDialog";
import { isPdfFile, pdfImport, readPdfVector, type PdfRead } from "../io/pdfVector";
import { exportScheduleCsv } from "../export/exportSchedule";
import { exportIfcSpf, type IfcExportOptions } from "../export/exportIfc";
import { loadFileio } from "../engine/fileioWasm";
import { exportProjectStep } from "../export/exportStep";
import { exportGlb, exportObj, exportStl } from "../export/exportMesh";
import type { ExportSaveFormat } from "../ui/ExportSaveDialog";
import { saveBinaryFile, saveTextFile } from "../native/saveFile";
import {
  saveProjectFile,
  openProjectFileNative,
  openProjectFileAtPath,
  openProjectTemplateNative,
  acquireProjectLock,
  releaseProjectLock,
  registerLockAutoRelease,
  isTauriRuntime,
} from "../native/projectFile";
import type { LockInfo } from "../native/projectFile";
import { addRecentProject, removeRecentProject } from "./recentProjects";
import { emptyProject, sampleProject } from "../model/sampleProject";
import type { Project } from "../model/types";
import type { PlanViewHandle } from "../views/plan/PlanView";

/** Modaler Import-Dialog-Zustand (DXF/DWG) — dieselbe Form wie in useDialogState. */
export type ImportDialogState = {
  fileName: string;
  isDwg: boolean;
  parsed: ParsedImport | null;
  loading?: boolean;
  /** Grober Phasenname während `loading` (DXF via `parseDxfAsync`'s
   *  `onProgress`) — rein informativ, s. `ImportDialog.tsx`. */
  progress?: string;
  /** Fehlermeldung des Format-Moduls (Datei leer, beschädigt, kein DXF/DWG …); `null`/fehlend = kein Fehler. */
  error?: string;
  /** Vektor-PDF ([76]): Seite und Massstab, aus denen `parsed` abgeleitet ist. */
  pdf?: PdfImportOptions;
} | null;

/** Meldung eines abgefangenen Fehlers (Rust-Fehler kommen als String, Worker-Fehler als Error). */
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));


/**
 * Öffnet Projekt-Text im Kern (`openProjectFile`: Version, Migration, Toleranz; direkt ins
 * Kern-Dokument, Verlauf leer) und meldet Fehler sichtbar statt nur in der Konsole. `null` = nicht
 * ladbar (das bisherige Projekt bleibt).
 */
function openProjectOrReport(content: string, notify: (msg: string, kind?: NotifyKind) => void): Project | null {
  const r = getState().openProjectFile(content);
  if (!r.ok) {
    notify(`${t("project.open.failed")} ${r.error}`, "error");
    return null;
  }
  for (const w of r.warnings) console.info(`Projekt geladen mit Hinweis: ${w}`);
  return r.project;
}

export function useProjectFileActions(
  project: Project,
  setImportState: (next: ImportDialogState) => void,
  setExportSaveFormat: (format: ExportSaveFormat | null) => void,
  activeCategoryCode: string,
  setActiveLevelId: (id: string) => void,
  planViewRef: RefObject<PlanViewHandle | null>,
) {
  // Verstecktes Datei-Input zum Laden eines Projekts (Datei-Burger „Öffnen").
  // Wird NUR im Browser-Pfad benutzt (ohne Tauri) — unter Tauri geht „Öffnen"
  // über den nativen Dialog (openProjectFileNative), der einen echten Pfad für
  // den Lock liefert (File-API im Browser hat keinen echten Dateipfad).
  const projectFileInputRef = useRef<HTMLInputElement>(null);
  // Meldungen als Toast (window.alert ist im Tauri-WKWebView wirkungslos).
  const notify = useStore((s) => s.notify);
  // Ein anderes Projekt übernehmen (Neu, Vorlage, Öffnen, Wiederherstellen) lädt es im Kern als Ganzes
  // (`loadProject`/`openProjectFile`, [K4] S4) und leert den Undo-Verlauf — sonst führte Rückgängig über
  // das Laden hinaus ins vorherige Projekt, und jede Änderung dort verwarf den Redo-Stapel.
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
    if (project !== lastSavedProjectRef.current) {
      // Bewusst verworfen (oder vorher gespeichert) → Wiederherstellungskopie ist hinfällig.
      const path = openedProjectPathRef.current;
      setPendingDiscard(() => () => {
        void clearAutosave(path);
        autosaveTracker.cleared();
        action();
      });
    } else action();
  };

  // ── Autosave + Wiederherstellen (s. state/autosave.ts) ─────────────────────
  const projectRef = useRef(project);
  projectRef.current = project;
  const autosaveTracker = useRef(createAutosaveTracker()).current;
  const [recovery, setRecovery] = useState<AutosaveRecovery | null>(null);
  useEffect(() => {
    const id = window.setInterval(() => {
      const p = projectRef.current;
      if (!autosaveTracker.shouldWrite(p, lastSavedProjectRef.current)) return;
      void writeAutosave(openedProjectPathRef.current, serializeProject(p));
    }, AUTOSAVE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, []);
  const offerRecovery = (path: string | null) => {
    void readAutosave(path).then((r) => {
      if (r) setRecovery({ path, text: r.text, savedAt: r.savedAt });
    });
  };
  // Start: Kopie eines nie gespeicherten Projekts aus der letzten Sitzung?
  useEffect(() => offerRecovery(null), []);
  const onRecoverRestore = () => {
    if (!recovery) return;
    openProjectOrReport(recovery.text, notify); // bleibt „ungespeichert" bis zum Speichern
    setRecovery(null);
  };
  const onRecoverDiscard = () => {
    if (recovery) void clearAutosave(recovery.path);
    autosaveTracker.cleared();
    setRecovery(null);
  };
  const onRecoverLater = () => setRecovery(null);

  // Best-effort Lock-Freigabe beim Fenster-Schliessen (sauberes Timing; der
  // OS-Lock fällt bei Prozessende/Absturz ohnehin automatisch weg). No-op ohne Tauri.
  useEffect(() => {
    registerLockAutoRelease(() => openedProjectPathRef.current);
  }, []);

  // Eine Datei (Button ODER Drop) öffnet den modalen Import-Dialog. DXF (ASCII/Binär)
  // und DWG werden als Bytes im Web-Worker über das Rust-Format-Modul gelesen (lazy,
  // asynchron); beide münden in dasselbe {meshes, contours}-Format und denselben Dialog.
  // Parse-Fehler werden ruhig abgefangen: DWG fällt auf den ODA-Hinweis zurück.
  // Rohdaten der zuletzt geöffneten Import-Datei: der Dialog kann damit ein Papierbereich-Layout
  // statt des Modellraums nachladen (`loadImportLayout`), ohne die Datei erneut zu wählen.
  const importSourceRef = useRef<{ fileName: string; buf: ArrayBuffer } | null>(null);

  /** Liest `layout` (Papierbereich) oder, bei `null`, den Modellraum der geöffneten Import-Datei neu. */
  const loadImportLayout = (layout: string | null) => {
    const src = importSourceRef.current;
    if (!src) return;
    setImportState({ fileName: src.fileName, isDwg: false, parsed: null, loading: true });
    parseDxfAsync(src.buf, undefined, layout ?? undefined)
      .then((parsed) => setImportState({ fileName: src.fileName, isDwg: false, parsed, loading: false }))
      .catch((err) => {
        console.error("Layout-Import fehlgeschlagen:", err);
        setImportState({
          fileName: src.fileName,
          isDwg: false,
          parsed: emptyImport(),
          loading: false,
          error: errorText(err),
        });
      });
  };

  // Vektor-PDF ([76]): Bytes und zuletzt gelesene Seite — Massstabswechsel rechnet nur um, ein
  // Seitenwechsel liest die Seite neu (Rust, synchron; das Format-Modul ist dann schon geladen).
  const pdfSourceRef = useRef<{ fileName: string; bytes: Uint8Array; read: PdfRead } | null>(null);

  const pdfImportState = (fileName: string, read: PdfRead, scale: number): ImportDialogState => {
    const page = read.page;
    return {
    fileName,
    isDwg: false,
    parsed: pdfImport(read, scale),
    loading: false,
    pdf: {
      pageCount: page.pageCount,
      page: page.pageIndex,
      scale,
      widthPt: page.width,
      heightPt: page.height,
      images: page.images,
      preview: page,
    },
    };
  };

  const openPdfImport = (file: File) => {
    pdfSourceRef.current = null;
    setImportState({ fileName: file.name, isDwg: false, parsed: null, loading: true, progress: "pdf" });
    void Promise.all([file.arrayBuffer(), loadFileio()])
      .then(([buf]) => {
        const bytes = new Uint8Array(buf);
        const read = readPdfVector(bytes, 0);
        pdfSourceRef.current = { fileName: file.name, bytes, read };
        setImportState(pdfImportState(file.name, read, 100));
      })
      .catch((err) => {
        console.error("PDF-Import fehlgeschlagen:", err);
        setImportState({ fileName: file.name, isDwg: false, parsed: emptyImport(), loading: false, error: errorText(err) });
      });
  };

  /** Import-Dialog: andere PDF-Seite oder anderer Massstab. */
  const setImportPdfOptions = (pageIndex: number, scale: number) => {
    const src = pdfSourceRef.current;
    if (!src || !(scale > 0)) return;
    try {
      if (pageIndex !== src.read.page.pageIndex) src.read = readPdfVector(src.bytes, pageIndex);
      setImportState(pdfImportState(src.fileName, src.read, scale));
    } catch (err) {
      setImportState({ fileName: src.fileName, isDwg: false, parsed: emptyImport(), loading: false, error: errorText(err) });
    }
  };

  const openImportForFile = (file: File) => {
    if (isPdfFile(file.name)) {
      openPdfImport(file);
      return;
    }
    const isDwg = /\.dwg$/i.test(file.name);
    importSourceRef.current = null;
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
        importSourceRef.current = { fileName: file.name, buf };
        // Dynamisch importieren (das Format-Modul wird ohnehin erst im Worker geladen).
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
              error: errorText(err),
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
      // Bytes statt Text: Binär-DXF und Code-Seiten (vor R2007) liest erst Rust richtig.
      const buf = r.result instanceof ArrayBuffer ? r.result : new ArrayBuffer(0);
      importSourceRef.current = { fileName: file.name, buf };
      parseDxfAsync(buf, (progress) => {
        setImportState({ fileName: file.name, isDwg: false, parsed: null, loading: true, progress });
      })
        .then((parsed) => {
          setImportState({ fileName: file.name, isDwg: false, parsed, loading: false });
        })
        .catch((err) => {
          console.error("DXF-Import fehlgeschlagen:", err);
          const parsed = emptyImport();
          setImportState({ fileName: file.name, isDwg: false, parsed, loading: false, error: errorText(err) });
        });
    };
    r.readAsArrayBuffer(file);
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
    const json = serializeProject(project);
    return saveProjectFile(json, project.name, (path) =>
      addRecentProject(path, project.name || "modell"),
    ).then((saved) => {
      if (saved) {
        lastSavedProjectRef.current = project;
        void clearAutosave(openedProjectPathRef.current);
        void clearAutosave(null);
        autosaveTracker.cleared();
      }
      return saved;
    });
  };
  // „Neu" (Datei-Menü): leeres Projekt, wie am Startbildschirm — löst dabei
  // einen evtl. gehaltenen Datei-Lock der bisherigen Projektdatei und vergisst
  // deren Pfad (das leere Projekt ist noch NICHT gespeichert). Über
  // `guardDiscard`: bei ungespeicherten Änderungen erst der Dialog, s. o.
  const onNewProject = () => guardDiscard(() => {
    releaseCurrentProjectLock();
    getState().loadProject(emptyProject);
    lastSavedProjectRef.current = emptyProject;
  });

  // Übernimmt ein neues, noch UNGESPEICHERTES Projekt aus Vorlagen-Inhalt
  // (eine gewählte `.obpt`-Datei): Prüfung wie beim normalen Öffnen, aber
  // bewusst OHNE Pfad/Lock zu setzen — die Vorlage bleibt unangetastet, das
  // nächste „Speichern" fragt nach einem neuen Ort. Ersetzt ebenfalls das
  // bisherige Projekt → über `guardDiscard` (der Kern lädt erst danach; eine
  // kaputte Datei lässt das bisherige Projekt stehen).
  const applyTemplateContent = (content: string): void => {
    guardDiscard(() => {
      const loaded = openProjectOrReport(content, notify);
      if (!loaded) return;
      releaseCurrentProjectLock();
      lastSavedProjectRef.current = loaded;
    });
  };
  // „Neu aus Vorlage: Musterhaus" — das eingebaute Demo-Haus (model/sampleProject.ts)
  // als Start eines neuen Projekts. `structuredClone`, damit spätere Bearbeitung
  // nicht das gemeinsame Modul-Singleton mutiert (es dient auch als Store-
  // Startzustand, s. state/projectSlice.ts).
  const onNewProjectFromSample = () => guardDiscard(() => {
    releaseCurrentProjectLock();
    const next = structuredClone(sampleProject);
    getState().loadProject(next);
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
    guardDiscard(() => {
      const loaded = openProjectOrReport(content, notify);
      if (!loaded) {
        if (lockOwned) void releaseProjectLock(path);
        return;
      }
      releaseCurrentProjectLock();
      lastSavedProjectRef.current = loaded;
      openedProjectPathRef.current = path;
      projectLockOwnedRef.current = lockOwned;
      addRecentProject(path, loaded.name || "modell");
      offerRecovery(path);
    });
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
  const runExport = (format: ExportSaveFormat, filename: string, ifcOptions?: IfcExportOptions) => {
    switch (format) {
      case "csv":
        downloadTextFile("﻿" + exportScheduleCsv(project), filename, "text/csv;charset=utf-8;");
        break;
      case "ifc":
        // IFC schreibt Rust (Format-Modul pkgFileIo, wird beim ersten Export nachgeladen).
        void loadFileio()
          .then(() => downloadTextFile(exportIfcSpf(project, ifcOptions), filename))
          .catch((e) => notify(`${t("ifc.export.failed")}: ${e instanceof Error ? e.message : String(e)}`, "error"));
        break;
      case "obj":
      case "stl":
      case "glb":
        // OBJ/STL/glTF schreibt Rust (Format-Modul pkgFileIo, wird beim ersten Export nachgeladen).
        void loadFileio()
          .then(() => {
            if (format === "glb") void saveBinaryFile(exportGlb(project), filename, "model/gltf-binary");
            else downloadTextFile(format === "obj" ? exportObj(project) : exportStl(project), filename);
          })
          .catch((e) => notify(`${t("mesh.export.failed")}: ${e instanceof Error ? e.message : String(e)}`, "error"));
        break;
      case "step":
        // B-Rep via truck-WASM (asynchron): Körper, die truck nicht bauen kann, werden
        // übersprungen — der Export bleibt trotzdem erhalten, Hinweis per Meldung.
        void exportProjectStep(project, filename.replace(/\.[^.]+$/, ""))
          .then((r) => {
            downloadTextFile(r.text, filename);
            if (r.skipped.length > 0) {
              notify(t("step.export.skipped", { n: r.skipped.length }), "warning");
            }
          })
          .catch((e) => notify(`${t("step.export.failed")}: ${e instanceof Error ? e.message : String(e)}`, "error"));
        break;
    }
  };
  // Schnellexport aus dem Topbar-Menü öffnet den Format-/Dateiname-Dialog
  // (vorausgewähltes Format). PDF/DXF haben eigene Options-Dialoge.
  const onExportSchedule = () => setExportSaveFormat("csv");
  const onExportIfc = () => setExportSaveFormat("ifc");
  const onExportObj = () => setExportSaveFormat("obj");
  const onExportStl = () => setExportSaveFormat("stl");
  const onExportGlb = () => setExportSaveFormat("glb");
  const onExportStep = () => setExportSaveFormat("step");
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
      const content = String(r.result ?? "");
      // Browser-Pfad hat keinen echten Dateipfad → kein Lock für die neue
      // Datei, aber ein evtl. vorher (unter Tauri) gehaltener Lock wird frei.
      guardDiscard(() => {
        const loaded = openProjectOrReport(content, notify);
        if (!loaded) return;
        releaseCurrentProjectLock();
        lastSavedProjectRef.current = loaded;
      });
    };
    r.readAsText(file);
  };

  const importParentName = (decision: ImportDecision): string =>
    decision.target.kind === "new" ? decision.target.name : "DXF";

  // Bestätigte Import-Entscheidung ausführen: der Kern legt ggf. die neue Zeichnung an, ergänzt Kategorien
  // je Layer und Linienstile (PDF-Strichmuster), hängt die 2D-Zeichnungen und optional die Meshes als
  // Kontext an — als EIN Undo-Schritt ([K4] S4, `ProjectDocument.importDrawing`).
  const runImport = (decision: ImportDecision) => {
    // Hinweis bleibt, bis PlanView den neuen Plan gezeichnet hat (endBusyAfterPaint):
    // der Aufbau nach dem Einhängen blockiert noch einmal mehrere Sekunden.
    beginBusy(t("busy.import"));
    const center = decision.placement === "viewCenter" ? planViewRef.current?.viewCenterModel() : undefined;
    let r: { levelId: string } | null = null;
    try {
      r = getState().commitImport((doc, base, now) =>
        doc.importDrawing(
          base,
          decision.parsed.src,
          {
            target: decision.target,
            categoryMode: decision.categoryMode,
            activeCategoryCode,
            importMeshes: decision.importMeshes,
            ...(center ? { viewCenter: [center.x, center.y] as [number, number] } : {}),
            levelNameTemplate: t("default.drawingName", { n: "{n}" }),
            parentName: t("import.layers.parentName", { name: importParentName(decision) }),
            dashStyleTemplate: t("import.pdf.dashStyleName", { pattern: "{pattern}" }),
          },
          now,
        ),
        "history.import.drawing",
      );
    } catch (err) {
      // Kaputter Puffer o. Ä. (Meldung des Kerns).
      notify(`${t("import.failed")}: ${errorText(err)}`, "error");
    }
    setImportState(null);
    // Auf die Ziel-Ebene wechseln, damit die importierte Geometrie sichtbar ist (zurückgewiesen: Hinweis weg).
    if (r) setActiveLevelId(r.levelId);
    else endBusy();
  };

  return {
    projectFileInputRef,
    projectTemplateFileInputRef,
    openedProjectPathRef,
    projectLockOwnedRef,
    lockConflict,
    setLockConflict,
    recovery,
    onRecoverRestore,
    onRecoverDiscard,
    onRecoverLater,
    pendingDiscard,
    setPendingDiscard,
    openImportForFile,
    setImportPdfOptions,
    loadImportLayout,
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
    onExportGlb,
    onExportStep,
    onOpenProject,
    onProjectFileChosen,
    runImport,
  };
}

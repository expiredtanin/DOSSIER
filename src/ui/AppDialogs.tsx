// Dialoge und Overlays des Editors ([163], aus App.tsx herausgelöst): Ressourcen-Fenster,
// Öffnungs-Editor, Import (DXF/DWG/PDF, IFC samt Bericht), Plan-Export (PDF/SVG/DXF), Einstellungen,
// Schnellexport, Autosave-Wiederherstellung, Sperrkonflikt, ungespeicherte Änderungen, Kopien-Anzahl,
// Raumstempel-Editor und der Drop-Rahmen — in derselben Reihenfolge wie zuvor. Gerendert von
// `App.tsx` nach der Status-Leiste; Zustand und Handler kommen aus den Hooks der App.

import type { DrawingLevel } from "../model/types";
import { lineEndsOf, setFieldIfChanged } from "../core";
import { getState, useStore, type RootState } from "../state/appStore";
import { setAiAccessEnabled } from "../state/aiAccess";
import { reconcileLayout } from "../state/layoutSlice";
import type { useCommandEngineHost } from "../state/useCommandEngineHost";
import type { useDialogState } from "../state/useDialogState";
import type { useDrawingToolState } from "../state/useDrawingToolState";
import type { useExportHandlers } from "../state/useExportHandlers";
import type { useModelImport } from "../state/useModelImport";
import type { useProjectActions } from "../state/useProjectActions";
import type { useProjectFileActions } from "../state/useProjectFileActions";
import type { useSettingsHost } from "../state/useSettingsHost";
import type { useTopBarState } from "../state/useTopBarState";
import type { useContextMenuState } from "../menus/useContextMenuState";
import { t } from "../i18n";
import { AiActivityPanel } from "./AiActivityPanel";
import { BusyOverlay } from "./BusyOverlay";
import { ExportDxfDialog } from "./ExportDxfDialog";
import { ExportPdfDialog } from "./ExportPdfDialog";
import { ExportSaveDialog } from "./ExportSaveDialog";
import { IfcImportDialog, IfcImportReportDialog } from "./IfcImportDialog";
import { ImportDialog } from "./ImportDialog";
import { LockConflictDialog } from "./LockConflictDialog";
import { PresentationDialogHost } from "./PresentationDialog";
import { RenderDialogHost } from "./RenderDialog";
import { PromptDialog } from "./PromptDialog";
import { RecoverAutosaveDialog } from "./RecoverAutosaveDialog";
import { ResourceManager, type ResourceManagerHandlers } from "./ResourceManager";
import { RoomStampEditorHost } from "./RoomStampEditorHost";
import { SettingsDialog } from "./SettingsDialog";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";

type TopBar = ReturnType<typeof useTopBarState>;
type EngineHost = ReturnType<typeof useCommandEngineHost>;
type ToolState = ReturnType<typeof useDrawingToolState>;
type Menu = ReturnType<typeof useContextMenuState>;

export function AppDialogs(props: {
  applyChange: RootState["applyChange"];
  layout: RootState["layout"];
  setLayout: RootState["setLayout"];
  activeLevel: DrawingLevel;
  activeCategoryCode: string;
  scaleDenominator: TopBar["scaleDenominator"];
  marqueeColor: TopBar["marqueeColor"];
  setMarqueeColor: TopBar["setMarqueeColor"];
  snapColor: TopBar["snapColor"];
  setSnapColor: TopBar["setSnapColor"];
  dialogs: ReturnType<typeof useDialogState>;
  files: ReturnType<typeof useProjectFileActions>;
  modelImport: ReturnType<typeof useModelImport>;
  settings: ReturnType<typeof useSettingsHost>;
  planExport: ReturnType<typeof useExportHandlers>;
  pa: ReturnType<typeof useProjectActions>;
  resourceHandlers: ResourceManagerHandlers;
  /** Anzahl sperrbarer Elemente der Auswahl (Export „nur Auswahl"). */
  selectionCount: number;
  engine: EngineHost["engine"];
  setAliasOverrides: EngineHost["setAliasOverrides"];
  setShortcutOverrides: EngineHost["setShortcutOverrides"];
  pendingCopyMode: ToolState["pendingCopyMode"];
  setPendingCopyMode: ToolState["setPendingCopyMode"];
  commitCopyCount: ToolState["commitCopyCount"];
  stampEditorRoomId: Menu["stampEditorRoomId"];
  setStampEditorRoomId: Menu["setStampEditorRoomId"];
}) {
  const {
    applyChange,
    layout,
    setLayout,
    activeLevel,
    activeCategoryCode,
    scaleDenominator,
    marqueeColor,
    setMarqueeColor,
    snapColor,
    setSnapColor,
    resourceHandlers,
    engine,
    setAliasOverrides,
    setShortcutOverrides,
    pendingCopyMode,
    setPendingCopyMode,
    commitCopyCount,
    stampEditorRoomId,
    setStampEditorRoomId,
  } = props;
  const {
    resourcesOpen,
    setResourcesOpen,
    resourcesTab,
    setActiveLayoutId,
    importState,
    setImportState,
    exportOpen,
    setExportOpen,
    exportDxfOpen,
    setExportDxfOpen,
    settingsOpen,
    setSettingsOpen,
    exportSaveFormat,
    setExportSaveFormat,
    dropActive,
  } = props.dialogs;
  const {
    recovery,
    onRecoverRestore,
    onRecoverDiscard,
    onRecoverLater,
    lockConflict,
    setLockConflict,
    pendingDiscard,
    setPendingDiscard,
    loadImportLayout,
    setImportPdfOptions,
    onSaveProject,
    applyOpenedProjectFile,
    projectFileName,
    runExport,
    runImport,
  } = props.files;
  const { pendingIfc, setPendingIfc, ifcReport, setIfcReport, runIfcImport } = props.modelImport;
  const { themeMode, setThemeMode, offline, onOfflineChange, aiAccess, setScaleLineWeights, setLineEnds } = props.settings;
  const { exportContentMeters, onExportPdf, onExportSvg, onExportDxf } = props.planExport;
  const { setRoomStamp, setRoomStampDoc } = props.pa;
  // Das Projekt nur abonnieren, solange ein Dialog offen ist, der es zeigt ([121]): sonst rendert eine Op
  // am Modell hier nichts. `App` reicht es nicht mehr durch.
  const needsProject = resourcesOpen || !!importState || settingsOpen;
  const subscribed = useStore((s) => (needsProject ? s.project : null));
  const project = subscribed ?? getState().project;
  // [193] Höhe eines Netzpunkts (Rechtsklick auf den Griff): Overlay-Eingabe statt window.prompt.
  const meshHeightPrompt = useStore((s) => s.meshHeightPrompt);
  const meshPromptZ = useStore((s) => {
    const p = s.meshHeightPrompt;
    const o = p ? (s.project.context ?? []).find((c) => c.id === p.id) : undefined;
    return p && o && "positions" in o ? o.positions[3 * p.index + 2] : undefined;
  });
  return (
    <>
    {/* Frei schwebendes, NICHT-modales Ressourcen-Fenster: kein Backdrop, der
        Grundriss dahinter bleibt bedienbar (Schraffur-/Linien-Änderungen live
        am Modell sichtbar). Verschiebbar über die Kopfzeile, größenveränderbar
        über den Greifer unten rechts. Der „Ressourcen"-Knopf toggelt; Esc
        schließt (siehe Effekt oben). */}
    {resourcesOpen && (
      <ResourceManager
        project={project}
        handlers={resourceHandlers}
        initialTab={resourcesTab}
        onClose={() => setResourcesOpen(false)}
      />
    )}

    <BusyOverlay />
    <AiActivityPanel />

    {/* Modaler Import-Dialog (DXF/DWG) — offen, sobald eine Datei gewählt/
        fallengelassen wurde. Liefert eine strukturierte Entscheidung an
        runImport (Ebene anlegen / Drawings anhängen / Meshes als Kontext). */}
    {/* [66] Präsentationsplan: Dialog (Befehl `praesentation`, Knopf im Layouts-Panel) */}
    <PresentationDialogHost onCreated={setActiveLayoutId} />
    {/* [211] Rendering mit Blender/Cycles (Befehl `rendering`, Menü Ansicht) */}
    <RenderDialogHost />
    {importState && (
      <ImportDialog
        fileName={importState.fileName}
        isDwg={importState.isDwg}
        loading={importState.loading ?? false}
        progress={importState.progress}
        error={importState.error}
        onSelectLayout={loadImportLayout}
        parsed={importState.parsed}
        pdf={importState.pdf}
        onPdfChange={setImportPdfOptions}
        project={project}
        activeCategoryCode={activeCategoryCode}
        onImport={runImport}
        onClose={() => setImportState(null)}
      />
    )}

    {/* PDF-/SVG-Export-Dialog (Grundriss → Vektor-PDF oder -SVG). Nur im
        Grundriss eines Geschosses sinnvoll; der Button ist sonst deaktiviert. */}
    {exportOpen && (
      <ExportPdfDialog
        initialScale={scaleDenominator}
        planTitle={activeLevel.name}
        contentMeters={exportContentMeters}
        selectionCount={props.selectionCount}
        onExport={onExportPdf}
        onExportSvg={onExportSvg}
        onClose={() => setExportOpen(false)}
      />
    )}

    {/* DXF-Export-Dialog (Grundriss → Modell-Space-DXF in Metern). */}
    {exportDxfOpen && (
      <ExportDxfDialog
        planTitle={activeLevel.name}
        levelKind={activeLevel.kind}
        initialScale={scaleDenominator}
        selectionCount={props.selectionCount}
        onExport={onExportDxf}
        onClose={() => setExportDxfOpen(false)}
      />
    )}

    {settingsOpen && (
      <SettingsDialog
        themeMode={themeMode}
        onThemeModeChange={setThemeMode}
        marqueeColor={marqueeColor}
        onMarqueeColorChange={setMarqueeColor}
        snapColor={snapColor}
        onSnapColorChange={setSnapColor}
        referenceElevationMasl={project.referenceElevationMasl}
        onReferenceElevationChange={(n) => applyChange((p) => setFieldIfChanged(p, "referenceElevationMasl", n))}
        scaleLineWeights={project.scaleLineWeights === true}
        onScaleLineWeightsChange={setScaleLineWeights}
        lineEnds={lineEndsOf(project)}
        onLineEndsChange={setLineEnds}
        offline={offline}
        onOfflineChange={onOfflineChange}
        aiAccess={aiAccess}
        onAiAccessChange={setAiAccessEnabled}
        layout={layout}
        onApplyLayout={(l) => setLayout(reconcileLayout(l))}
        onAliasOverridesChange={setAliasOverrides}
        onShortcutOverridesChange={setShortcutOverrides}
        onClose={() => setSettingsOpen(false)}
      />
    )}

    {exportSaveFormat && (
      <ExportSaveDialog
        initialFormat={exportSaveFormat}
        baseName={projectFileName()}
        onSave={(fmt, filename, ifcOptions) => {
          runExport(fmt, filename, ifcOptions);
          setExportSaveFormat(null);
        }}
        onClose={() => setExportSaveFormat(null)}
      />
    )}

    {recovery && (
      <RecoverAutosaveDialog
        path={recovery.path}
        savedAt={recovery.savedAt}
        onRestore={onRecoverRestore}
        onDiscard={onRecoverDiscard}
        onLater={onRecoverLater}
      />
    )}
    {lockConflict && (
      <LockConflictDialog
        info={lockConflict.info}
        onCancel={() => setLockConflict(null)}
        onReadOnly={() => {
          applyOpenedProjectFile(lockConflict.path, lockConflict.content, false);
          setLockConflict(null);
        }}
        onForceOpen={() => {
          // Kein eigener Lock (die andere Instanz hält ihn) — bewusste
          // Risiko-Übernahme, im Dialog als Warnung gekennzeichnet.
          applyOpenedProjectFile(lockConflict.path, lockConflict.content, false);
          setLockConflict(null);
        }}
      />
    )}

    {pendingIfc && (
      <IfcImportDialog
        fileName={pendingIfc.name}
        onCancel={() => setPendingIfc(null)}
        onImport={(mode) => {
          const f = pendingIfc;
          setPendingIfc(null);
          runIfcImport(f, mode);
        }}
      />
    )}

    {ifcReport && (
      <IfcImportReportDialog fileName={ifcReport.fileName} summary={ifcReport.summary} onClose={() => setIfcReport(null)} />
    )}

    {pendingDiscard && (
      <UnsavedChangesDialog
        onCancel={() => setPendingDiscard(null)}
        onDiscard={() => {
          pendingDiscard();
          setPendingDiscard(null);
        }}
        onSave={onSaveProject}
      />
    )}

    {meshHeightPrompt && meshPromptZ !== undefined && (
      <PromptDialog
        title={t("site.meshPointHeight.title")}
        label={t("site.meshPointHeight.label", { n: meshHeightPrompt.index + 1 })}
        defaultValue={String(Math.round(meshPromptZ * 1000) / 1000)}
        type="number"
        onConfirm={(v) => {
          const z = Number(v.replace(",", "."));
          if (Number.isFinite(z)) getState().setMeshPointHeight(meshHeightPrompt.id, meshHeightPrompt.index, z);
          getState().setMeshHeightPrompt(null);
        }}
        onClose={() => getState().setMeshHeightPrompt(null)}
      />
    )}

    {pendingCopyMode && (
      <PromptDialog
        title={t(pendingCopyMode === "array" ? "transform.mode.array" : "transform.mode.distribute")}
        label={t("transform.countPrompt")}
        defaultValue="3"
        type="number"
        onConfirm={(v) => commitCopyCount(v, (mode, n) => engine.chooseOption(mode, n))}
        onClose={() => setPendingCopyMode(null)}
      />
    )}

    {/* Inline-Text-Editor für Drawing2D-Text (`editTextId`) rendert PlanView
        jetzt direkt auf der Zeichenfläche (kein Dialog mehr, Nutzer-Wunsch —
        gleiches Prinzip wie der Layout-Blatt-Inline-Editor). Ausgelöst über
        `text`/`textbox` (sofort nach Platzieren, s. host.focusDrawing) oder
        Doppelklick auf ein bestehendes Element (onEditDrawingText). */}

    {/* Text-Editor (schwebendes Fenster): Doppelklick auf einen Raumstempel bzw.
        Button in der Objekt-Info öffnet ihn. „Übernehmen" schreibt das
        bearbeitete Rich-Text-Dokument über setRoomStampDoc. Die Formatier-
        Leiste in der Oberleiste wirkt ebenfalls live auf den gewählten Raum. */}
    {stampEditorRoomId && (
      <RoomStampEditorHost
        roomId={stampEditorRoomId}
        onClose={() => setStampEditorRoomId(null)}
        setRoomStamp={setRoomStamp}
        setRoomStampDoc={setRoomStampDoc}
      />
    )}

    {/* Dezenter Drop-Rahmen, solange eine Datei über die App gezogen wird. */}
    {dropActive && (
      <div className="drop-feedback" aria-hidden="true">
        <div className="drop-feedback-inner">{t("drop.hint")}</div>
      </div>
    )}
    </>
  );
}

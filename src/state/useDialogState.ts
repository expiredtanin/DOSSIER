// Bündelt die transienten Dialog-/Overlay-Sichtbarkeits-States der App-Shell
// (Ressourcen-Fenster, Layout-Ansicht, Import-/Export-/Einstellungs-Dialoge,
// Drop-Feedback). Bewusst KEIN Store-Slice: dieser State ist rein lokal (keine
// Undo/Redo-Relevanz, kein Cross-Component-Lesezugriff nötig — TopBar/
// AppMenuBar bekommen ihn weiterhin als Props von App() gereicht, unverändert)
// — nur aus App() herausgezogen, um die Funktion zu entlasten. Reine
// useState-Bündelung, keine Verhaltensänderung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useState } from "react";
import type { DxfImportResult } from "../io/dxfParser";
import type { ExportSaveFormat } from "../ui/ExportSaveDialog";
import type { TabId as ResourceTabId } from "../ui/ResourceManager";

export function useDialogState() {
  // Schwebendes Ressourcen-Fenster (Overlay über allem). Transienter UI-State,
  // bleibt lokal. Wird über die Oberleiste geöffnet und über X / Hintergrund-
  // Klick / Esc geschlossen.
  const [resourcesOpen, setResourcesOpen] = useState(false);
  // Angeforderter Start-Tab des Ressourcen-Fensters (z. B. „doorStyles", wenn man
  // von einer gewählten Tür in den Typeditor springt).
  const [resourcesTab, setResourcesTab] = useState<ResourceTabId>("components");
  // Offener Fenster-/Tür-Einstellungsdialog (⚙ der OpeningSection) — ID der
  // editierten Öffnung, oder null wenn geschlossen.
  const [openingEditorId, setOpeningEditorId] = useState<string | null>(null);

  // Aktives Layout-Blatt im HAUPT-Viewport (DOSSIER A3, Phase 2b): Id des offenen
  // Layouts oder null (= normale Modell-Ansicht). Transienter UI-State; das
  // Layout selbst lebt im Projekt (project.layouts). Ist es gesetzt, zeigt der
  // Haupt-Viewport das Blatt (LayoutSheetView) statt Grundriss/3D.
  const [activeLayoutId, setActiveLayoutId] = useState<string | null>(null);

  // Modaler Import-Dialog (DXF/DWG). Offen, sobald eine Datei gewählt/fallen-
  // gelassen wurde; hält Dateiname, geparstes Ergebnis (null bei DWG) und das
  // DWG-Flag (kein Parser). null = kein Dialog offen. Transienter UI-State.
  const [importState, setImportState] = useState<{
    fileName: string;
    isDwg: boolean;
    parsed: DxfImportResult | null;
    // true, solange DWG noch geparst wird (WASM lädt/läuft).
    loading?: boolean;
  } | null>(null);
  // Modaler PDF-Export-Dialog (Grundriss → Vektor-PDF). true = offen.
  const [exportOpen, setExportOpen] = useState(false);
  const [exportDxfOpen, setExportDxfOpen] = useState(false);
  // Modales Einstellungs-Fenster (Darstellungsfarben + Projekt-Felder).
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Offener Schnellexport-Dialog: Format (aus dem Menü) oder null = geschlossen.
  const [exportSaveFormat, setExportSaveFormat] = useState<ExportSaveFormat | null>(null);
  // Visuelles Drop-Feedback (dezenter Rahmen), solange eine Datei über die App
  // gezogen wird. Zählt dragenter/dragleave aus, um Flackern bei Kind-Elementen
  // zu vermeiden.
  const [dropActive, setDropActive] = useState(false);

  return {
    resourcesOpen,
    setResourcesOpen,
    resourcesTab,
    setResourcesTab,
    openingEditorId,
    setOpeningEditorId,
    activeLayoutId,
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
    setDropActive,
  };
}

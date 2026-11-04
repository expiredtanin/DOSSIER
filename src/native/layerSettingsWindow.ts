// Ebeneneinstellungen als EIGENES natives Tauri-Fenster — Referenz: DOSSIER-
// Rhino-Plugin (`git.kgva.ch/karim/DOSSIER`, `rhino/layers_panel.py`
// `_open_ebenen_settings`), das dort exakt so als „Satelliten-Fenster"
// (Eto-Form, kein Docked-Panel) läuft. Ersetzt unter Tauri den bisherigen
// `InlineEditor`-Popover (App.tsx, `editor?.kind === "layer"`); im reinen
// Browser bleibt der Popover (kein OS-Fenster-Konzept dort).
//
// **Bewusst NUR die heute schon im Modell vorhandenen Felder** (Name/Farbe/
// Linienstärke/Schraffur-Auswahl) — die Rhino-Version kennt zusätzlich eine
// PRO-EBENE Schraffur-Skalierung/-Rotation/-Stiftstärke (`section.hatchScale`
// etc.), die es in `LayerCategory` (model/types.ts) schlicht nicht gibt
// (dort nur `hatch?: string`, eine Referenz auf die geteilte Hatch-Resource
// ohne Per-Kategorie-Override). Das nachzurüsten wäre eine eigene
// Modell-Erweiterung + generatePlan.ts-Verdrahtung, keine reine Fenster-
// Frage — bewusst nicht mitgemacht, um hier nichts zu erfinden, das der Rest
// der App nicht einlöst.
//
// Nur EIN Fenster gleichzeitig (Label fix "layer-settings", wie Rhinos
// Satellit): erneutes Öffnen für eine andere Ebene schiebt nur den neuen Code
// nach (kein Fenster-Zoo), analog dem Dropdown-Wechsel im Original.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { findCategory } from "../model/layers";
import type { HatchStyle, LayerCategory, Project } from "../model/types";
import { BORDERLESS_WINDOW_CHROME } from "./windowChrome";
import { useWindowBridgeHost } from "./windowBridge";

const LAYER_SETTINGS_WINDOW_LABEL = "layer-settings";

export interface LayerSettingsSyncState {
  code: string;
  name: string;
  color: string;
  lw: number;
  hatchId: string | undefined;
  hatches: { id: string; name: string }[];
}

export interface LayerSettingsCommandHandlers {
  onPatchCategory: (code: string, patch: Partial<LayerCategory>) => void;
}

/** Öffnet das native Ebeneneinstellungs-Fenster für `code` (bzw. schiebt den Code nach, falls schon offen). */
export async function openLayerSettingsWindowNative(code: string): Promise<void> {
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel(LAYER_SETTINGS_WINDOW_LABEL);
  if (existing) {
    const { emitTo } = await import("@tauri-apps/api/event");
    await emitTo(LAYER_SETTINGS_WINDOW_LABEL, "layer-settings-set-code", code).catch(() => {});
    await existing.setFocus();
    return;
  }
  new WebviewWindow(LAYER_SETTINGS_WINDOW_LABEL, {
    url: `index.html?window=layer-settings&code=${encodeURIComponent(code)}`,
    title: "Ebeneneinstellungen — dossier",
    width: 360,
    height: 420,
    minWidth: 300,
    minHeight: 340,
    ...BORDERLESS_WINDOW_CHROME,
  });
}

/** Baut den Sync-Zustand für eine Kategorie (bzw. `null`, wenn der Code nicht mehr existiert — z. B. gelöscht). */
function stateFor(project: Project, code: string): LayerSettingsSyncState | null {
  const cat = findCategory(project.layers, code);
  if (!cat) return null;
  return {
    code: cat.code,
    name: cat.name,
    color: cat.color,
    lw: cat.lw,
    hatchId: cat.hatch,
    hatches: project.hatches.map((h: HatchStyle) => ({ id: h.id, name: h.name })),
  };
}

/** Hauptfenster-Seite der Sync-Brücke. `code` = aktuell im Fenster editierte Ebene (folgt `openLayerSettingsWindowNative`-Aufrufen). */
export function useLayerSettingsWindowHost(
  project: Project,
  code: string | null,
  onPatchCategory: (code: string, patch: Partial<LayerCategory>) => void,
): void {
  const state: LayerSettingsSyncState | null = code ? stateFor(project, code) : null;
  useWindowBridgeHost(LAYER_SETTINGS_WINDOW_LABEL, "layer-settings", state, { onPatchCategory: (c: string, patch: Partial<LayerCategory>) => onPatchCategory(c, patch) }, [project, code]);
}

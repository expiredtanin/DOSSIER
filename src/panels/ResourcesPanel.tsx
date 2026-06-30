// Inhalts-Panel „Ressourcen" — dünner Adapter um den ResourceManager.
//
// Wiederverwendet die bestehende <ResourceManager>-Komponente (Bauteile /
// Schraffuren / Linien) UNVERÄNDERT, rendert sie aber INLINE als Panel-Körper
// statt als rechte Schublade. Projekt + Handler kommen aus dem Host-Context.
//
// ResourceManager ist als Overlay-Schublade gebaut (.res-overlay fixed/inset:0
// → .res-drawer mit fester Breite, Rand und Schatten) und erwartet onClose.
// Da styles.css und ResourceManager selbst nicht angefasst werden dürfen,
// zähmt dieser Adapter die Schubladen-Chrome lokal: ein eingebetteter,
// gescopter <style>-Block (kein Eingriff in styles.css) löst das Overlay aus
// der Fixpositionierung, lässt die „Schublade" die Panel-Fläche füllen und
// blendet den Schließen-Knopf aus (ein Panel schließt man über den Rahmen,
// nicht über die Schublade). onClose ist daher ein No-Op.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { ResourceManager } from "../ui/ResourceManager";
import type { ResourceManagerHandlers } from "../ui/ResourceManager";
import { usePanelHost } from "./host";

/** Inhalt des Panels „Ressourcen". */
export function ResourcesPanel() {
  const host = usePanelHost();

  // Handler aus dem Host auf die Signatur des ResourceManager bündeln.
  const handlers: ResourceManagerHandlers = {
    onPatchComponent: host.onPatchComponent,
    onAddComponent: host.onAddComponent,
    onDeleteComponent: host.onDeleteComponent,
    onPatchHatch: host.onPatchHatch,
    onAddHatch: host.onAddHatch,
    onDeleteHatch: host.onDeleteHatch,
    onPatchLineStyle: host.onPatchLineStyle,
    onAddLineStyle: host.onAddLineStyle,
    onDeleteLineStyle: host.onDeleteLineStyle,
    onImportLineStyles: host.onImportLineStyles,
    onImportHatches: host.onImportHatches,
  };

  return (
    <div className="panel-resources-host">
      {/* Gescopte Override-Regeln: machen aus der Overlay-Schublade einen
          flächenfüllenden Inline-Körper. Betrifft nur Nachfahren dieses
          Wrappers — styles.css bleibt unberührt. */}
      <style>{PANEL_RESOURCES_CSS}</style>
      <ResourceManager
        project={host.project}
        handlers={handlers}
        onClose={NO_OP}
      />
    </div>
  );
}

/** onClose-Platzhalter: als Panel gibt es keinen Schubladen-Schließer. */
const NO_OP = () => {};

/**
 * Lokale Override-Regeln, die die fixe Overlay-Schublade in einen normalen,
 * im Panel sitzenden Block verwandeln. Klassen-Selektoren sind unter
 * `.panel-resources-host` verschachtelt, damit nichts außerhalb des Panels
 * betroffen ist.
 */
const PANEL_RESOURCES_CSS = `
.panel-resources-host {
  height: 100%;
  min-height: 0;
  display: flex;
}
.panel-resources-host .res-overlay {
  position: static;
  inset: auto;
  z-index: auto;
  background: transparent;
  display: flex;
  flex: 1;
  min-height: 0;
  justify-content: stretch;
}
.panel-resources-host .res-drawer {
  width: 100%;
  height: 100%;
  border-left: none;
  box-shadow: none;
}
/* Im Panel ohne Schubladen-Schließer. */
.panel-resources-host .res-close {
  display: none;
}
`;

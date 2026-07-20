// Panel-Rahmen — Kopfzeile + scrollbarer Körper um einen Panel-Inhalt.
//
// Der Rahmen ist inhaltsneutral: er bekommt eine PanelDef (für Titel und das
// Flag hasDisplayMode) und den generischen PanelContext, mit dem er
// `def.render(ctx)` aufruft. Den eigentlichen Inhalt liefert also das Panel
// selbst; der Rahmen kümmert sich nur um Titelzeile, optionalen
// Darstellungsmodus-Umschalter und den überlaufenden, scrollbaren Körper.
//
// Der Darstellungsmodus wird von außen durchgereicht (value + onChange), damit
// der Rahmen nichts vom Host-Context wissen muss. Der Umschalter erscheint nur,
// wenn das Panel ihn deklariert (def.hasDisplayMode) UND ein onChange anliegt.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { DisplayModeSelect } from "./DisplayModeSelect";
import type { DisplayMode, PanelContext, PanelDef } from "./types";
import { t } from "../i18n";

export interface PanelFrameProps {
  /** Definition des darzustellenden Panels (liefert Titel + hasDisplayMode). */
  def: PanelDef;
  /** Generischer Kontext, der an `def.render` weitergereicht wird. */
  ctx?: PanelContext;
  /**
   * Aktueller Darstellungsmodus. Nur relevant, wenn das Panel
   * `hasDisplayMode` deklariert; der Umschalter ist sonst ausgeblendet.
   */
  displayMode?: DisplayMode;
  /**
   * Setter für den Darstellungsmodus. Liegt er an und deklariert das Panel
   * `hasDisplayMode`, zeigt die Kopfzeile das Dropdown.
   */
  onDisplayModeChange?: (mode: DisplayMode) => void;
}

/**
 * Container eines einzelnen Panels: Kopfzeile (Titel + optionaler
 * Darstellungsmodus-Umschalter) über einem scrollbaren Körper, der den
 * gerenderten Panel-Inhalt aufnimmt.
 */
export function PanelFrame({
  def,
  ctx,
  displayMode,
  onDisplayModeChange,
}: PanelFrameProps) {
  // Umschalter nur, wenn das Panel ihn will UND er verdrahtet ist.
  const showMode =
    Boolean(def.hasDisplayMode) &&
    onDisplayModeChange !== undefined &&
    displayMode !== undefined;

  return (
    <section className="panel-frame">
      <header className="panel-head">
        <span className="panel-title">{t(def.title)}</span>
        <span className="panel-head-actions">
          {def.headerActions}
          {showMode && (
            <DisplayModeSelect
              value={displayMode as DisplayMode}
              onChange={onDisplayModeChange as (m: DisplayMode) => void}
            />
          )}
        </span>
      </header>
      <div className="panel-body">{def.render(ctx ?? {})}</div>
    </section>
  );
}

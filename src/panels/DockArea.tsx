// Dock-Bereich der App ([163], aus App.tsx herausgelöst): linkes und rechtes Dock (gestapelte
// Gruppen mit Tabs), die Mitte als `children`, Rand-Andockzonen während eines Drags, schwebende
// Panels und das Drag-Overlay. Jede Gruppe bzw. jedes schwebende Panel bekommt einen eigenen
// Host-Provider (`hostWithMode`), damit der Darstellungsmodus dem eigenen Tab folgt. Gerendert von
// `App.tsx`; der Drag-Zustand kommt aus `useDockDragState` in der App.
//
// [121] Die Docks sind memoisiert und bekommen hier stabile Rückrufe: ein App-Render (z. B. nach einer
// Op) rendert sie nicht mit, solange Layout, Host (stabil, s. `usePanelHostBase`), Darstellungsmodi
// und Messwert gleich bleiben. Die Panels selbst abonnieren ihre Projektdaten im Store.

import { useCallback, type ReactNode } from "react";
import type { MeasurementReadout } from "../tools/types";
import { useStore, type RootState } from "../state/appStore";
import type { useDockDragState } from "../state/useDockDragState";
import { Dock } from "./Dock";
import { FloatingPanel } from "./FloatingPanel";
import { hostWithMode, PanelHostProvider } from "./host";
import { DragOverlay } from "./panelDrag";
import { useEvent } from "../state/useEvent";

export function DockArea(props: {
  layout: RootState["layout"];
  baseHost: Parameters<typeof hostWithMode>[0];
  modeFor: RootState["modeFor"];
  setModeFor: RootState["setModeFor"];
  /** Messwert der laufenden Vorschau (Panels zeigen ihn an). */
  measure: MeasurementReadout | null;
  dockDrag: ReturnType<typeof useDockDragState>;
  children: ReactNode;
}) {
  const { layout, baseHost, modeFor, setModeFor, measure } = props;
  const { drag, startTabDrag, onFloatTitleDrop, onFloatTitleDrag, leftHasTabs, rightHasTabs, dragActive, activeZone } =
    props.dockDrag;
  // Layout-Mutationen aus dem Layout-Slice (referenzstabile Store-Actions).
  const resizeDock = useStore((s) => s.resizeDock);
  const resizeGroups = useStore((s) => s.resizeGroups);
  const focusFloat = useStore((s) => s.focusFloat);
  const moveFloat = useStore((s) => s.moveFloat);
  const resizeFloat = useStore((s) => s.resizeFloat);
  const closeFloat = useStore((s) => s.closeFloat);
  const redockFloat = useStore((s) => s.redockFloat);
  // `modeFor` ist eine stabile Store-Funktion; die Modi selbst abonnieren, damit sich die Rückrufe
  // unten (und damit die memoisierten Docks) bei einem Moduswechsel ändern.
  const displayModes = useStore((s) => s.displayModes);
  const onStartTabDrag = useEvent(startTabDrag);
  const resizeLeft = useCallback((size: number) => resizeDock("left", size), [resizeDock]);
  const resizeRight = useCallback((size: number) => resizeDock("right", size), [resizeDock]);
  const resizeGroupsLeft = useCallback((w: number[]) => resizeGroups("left", w), [resizeGroups]);
  const resizeGroupsRight = useCallback((w: number[]) => resizeGroups("right", w), [resizeGroups]);
  const buildHost = useCallback(
    (activeTab: string | null) => hostWithMode(baseHost, activeTab, modeFor, setModeFor, measure),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [baseHost, modeFor, setModeFor, measure, displayModes],
  );
  const displayModeFor = useCallback(
    (activeTab: string | null) => modeFor(activeTab),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [modeFor, displayModes],
  );
  const onDisplayModeChange = useCallback(
    (activeTab: string | null, m: Parameters<typeof setModeFor>[1]) => setModeFor(activeTab, m),
    [setModeFor],
  );
  return (
    <>
      <div className="body">
        {/* Linkes Dock: gestapelte Gruppen (Werkzeuge oben, Zeichnungsebenen/
            Ebenen unten). Jede Gruppe baut über buildHost ihren eigenen
            Host-Provider, damit der Darstellungsmodus dem aktiven Tab DIESER
            Gruppe folgt. Nur gerendert, wenn das Dock Gruppen hat. */}
        {leftHasTabs && (
          <Dock
            side="left"
            dock={layout.left}
            onStartTabDrag={onStartTabDrag}
            onResize={resizeLeft}
            onResizeGroups={resizeGroupsLeft}
            buildHost={buildHost}
            displayModeFor={displayModeFor}
            onDisplayModeChange={onDisplayModeChange}
          />
        )}
        {props.children}

        {/* Rechtes Dock: standardmäßig leer (Ressourcen ist ein schwebendes
            Fenster). Nur gerendert, wenn es Gruppen hat — sonst nutzt die Mitte
            den freigewordenen Platz. */}
        {rightHasTabs && (
          <Dock
            side="right"
            dock={layout.right}
            onStartTabDrag={onStartTabDrag}
            onResize={resizeRight}
            onResizeGroups={resizeGroupsRight}
            buildHost={buildHost}
            displayModeFor={displayModeFor}
            onDisplayModeChange={onDisplayModeChange}
          />
        )}

        {/* Rand-Andock-Zonen (links/rechts) — nur während einer Drag-Geste
            (Tab-Ziehen ODER Titel-Drag eines Fensters). Sie sind die
            Trefferflächen für „hierher andocken"; data-drop-zone wird von der
            Drag-Auflösung (panelDrag/onFloatTitleDrop) gelesen. */}
        {dragActive && (
          <>
            <div
              className={`drop-zone drop-zone-left${
                activeZone === "left" ? " active" : ""
              }`}
              data-drop-zone="left"
            />
            <div
              className={`drop-zone drop-zone-right${
                activeZone === "right" ? " active" : ""
              }`}
              data-drop-zone="right"
            />
          </>
        )}

        {/* Schwebende Panels ÜBER der Mitte. Jedes bekommt einen eigenen
            Host-Provider, damit sein Darstellungsmodus-Umschalter dem eigenen
            Panel folgt (wie bei den Docks). Verschieben/Größe/Andocken/Schließen
            schreiben das Layout fort (persistiert via useEffect). */}
        {layout.floating.map((fp) => (
          <PanelHostProvider
            key={fp.panelId}
            value={hostWithMode(baseHost, fp.panelId, modeFor, setModeFor, measure)}
          >
            <FloatingPanel
              panel={fp}
              displayMode={modeFor(fp.panelId)}
              onDisplayModeChange={(m) => setModeFor(fp.panelId, m)}
              onFocus={focusFloat}
              onMove={moveFloat}
              onResize={resizeFloat}
              onRedock={redockFloat}
              onClose={closeFloat}
              onTitleDrag={onFloatTitleDrag}
              onTitleDrop={onFloatTitleDrop}
            />
          </PanelHostProvider>
        ))}
      </div>

      {/* Drag-Overlay (Geist + Tab-Einfüge-Caret) während eines Tab-Ziehens. */}
      <DragOverlay drag={drag} />
    </>
  );
}

// Tab-Drag-Steuerung (Reorder / Einreihen / Stapeln / Lösen) + Titel-Drag eines
// schwebenden Fensters über eine Rand-Andockzone. Der eigentliche Drag-vs-Klick-
// Controller ist `usePanelDrag` (panels/panelDrag.tsx); dieser Hook bündelt nur
// den App-lokalen Float-Titel-Drag-Zustand + die abgeleiteten Rand-Zonen-Werte.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useState } from "react";
import { usePanelDrag } from "../panels/panelDrag";
import type { DockId, LayoutState } from "../panels/types";

export function useDockDragState(opts: {
  layout: LayoutState;
  activateTab: (panelId: string) => void;
  joinGroup: (panelId: string, dock: DockId, group: number, index?: number) => void;
  newGroup: (panelId: string, dock: DockId, at: number) => void;
  dropFloat: (panelId: string, x: number, y: number) => void;
  dockFloatTo: (panelId: string, dock: DockId) => void;
}) {
  const { layout, activateTab, joinGroup, newGroup, dropFloat, dockFloatTo } = opts;

  // Der Controller (usePanelDrag) klärt anhand der Bewegung Klick vs. Ziehen
  // und löst beim Loslassen das Ziel auf; die Auflösung selbst macht der Slice.
  const { drag, startTabDrag } = usePanelDrag({
    onActivate: activateTab,
    onJoinGroup: joinGroup,
    onNewGroup: newGroup,
    onDropFloat: dropFloat,
  });

  // Zustand für die Rand-Zonen-Hervorhebung beim Titel-Drag eines Fensters.
  // `floatDragging` schaltet die Zonen ein (sobald die Titelleiste gezogen
  // wird), `floatDragHover` markiert die gerade überfahrene Zone.
  const [floatDragging, setFloatDragging] = useState(false);
  const [floatDragHover, setFloatDragHover] = useState<DockId | null>(null);

  // Titel-Drag eines schwebenden Fensters über eine Rand-Zone: liefert true,
  // wenn das Fenster angedockt wurde (dann unterbleibt das reine Verschieben).
  // Trefferprüfung über die Datenattribute der Rand-Zonen (data-drop-zone).
  const onFloatTitleDrop = (panelId: string, clientX: number, clientY: number): boolean => {
    setFloatDragging(false);
    setFloatDragHover(null);
    const zone = document
      .elementsFromPoint(clientX, clientY)
      .find((el) => (el as HTMLElement).dataset?.dropZone !== undefined) as
      | HTMLElement
      | undefined;
    if (!zone) return false;
    const dock = zone.dataset.dropZone as DockId;
    dockFloatTo(panelId, dock);
    return true;
  };

  const onFloatTitleDrag = (_panelId: string, clientX: number, clientY: number) => {
    if (!floatDragging) setFloatDragging(true);
    const zone = document
      .elementsFromPoint(clientX, clientY)
      .find((el) => (el as HTMLElement).dataset?.dropZone !== undefined) as
      | HTMLElement
      | undefined;
    setFloatDragHover(zone ? (zone.dataset.dropZone as DockId) : null);
  };

  // Ein Dock wird nur gerendert, wenn es Tabs hat — ein leeres Dock soll die
  // Mitte nicht stauchen. (Rechtes Dock ist standardmäßig leer: Ressourcen ist
  // ein schwebendes Fenster.)
  const leftHasTabs = layout.left.groups.length > 0;
  const rightHasTabs = layout.right.groups.length > 0;
  // Rand-Andock-Zonen sind aktiv, solange irgendeine Drag-Geste läuft (Tab-Drag
  // ODER Titel-Drag eines schwebenden Fensters). Die gerade überfahrene Zone
  // (für die Hervorhebung) kommt aus dem Tab-Drag-Hover bzw. dem Float-Hover.
  const dragActive = drag !== null || floatDragging;
  const activeZone: DockId | null =
    drag && drag.hover.kind === "zone" ? drag.hover.dock : floatDragHover;

  return {
    drag,
    startTabDrag,
    onFloatTitleDrop,
    onFloatTitleDrag,
    leftHasTabs,
    rightHasTabs,
    dragActive,
    activeZone,
  };
}

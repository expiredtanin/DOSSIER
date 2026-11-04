// Bündelt die Auswahl-Zustände aller Bauteil-/Zeichnungs-Arten: je Art eine
// MENGE aus dem Store-Slice (Marquee/Mehrfachauswahl) plus ein daraus
// abgeleitetes Einzel-Element (nur bei genau einem gewählten Element) für die
// bestehende Einzel-Element-Maschinerie (Grips, Edit, Attribute, Object-Info).
// Dazu die 2D-Zeichenelement-Zwischenablage und den 3D-Live-Schnitt-Treiber
// (reiner Ansichts-Zustand, unabhängig von der Auswahl). Nur aus App()
// herausgezogen, um die Funktion zu entlasten — reine Zustands-Bündelung,
// keine Verhaltensänderung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useState } from "react";
import { useStore } from "./appStore";
import type { ElementClipboard } from "../editors/elementClipboard";
import { single } from "./selection";

export function useSelectionState() {
  // Die ganze Auswahl (je Art eine Menge, [130]); App liest sie vollständig, die
  // Einzel-Element-Maschinerie (Grips, Edit, Attribute, Object-Info) bekommt je Art
  // das „eine" gewählte Element (nur bei genau einem).
  const selection = useStore((s) => s.selection);
  const setSelection = useStore((s) => s.setSelection);
  const clearSelection = useStore((s) => s.clearSelection);
  // Zwischenablage für ALLE Bauteil-Arten (Ctrl/Cmd+C/V) — Wand/Decke/Dach/
  // Öffnung/Treppe/Raum/Extrusion/Stütze + 2D-Zeichenelemente, s.
  // `editors/elementClipboard.ts`. Kopiert die GEWÄHLTEN Elemente tief;
  // Einfügen legt Klone mit neuen IDs auf dem AKTIVEN Geschoss an — so lässt
  // sich z. B. importiertes Mobiliar über Geschosse hinweg wiederverwenden.
  const [elementClipboard, setElementClipboard] = useState<ElementClipboard | null>(null);
  // Welche Schnittlinie treibt den 3D-Live-Schnitt (reiner Ansichts-Zustand,
  // unabhängig von der Auswahl — der Schnitt bleibt beim Klick woanders aktiv).
  const [section3dCutId, setSection3dCutId] = useState<string | null>(null);
  const updateRoof = useStore((s) => s.updateRoof);
  const moveRoofGrip = useStore((s) => s.moveRoofGrip);
  const moveRoofBy = useStore((s) => s.moveRoofBy);
  // Gruppen (Vectorworks-artig): Isolations-Pfad ("Gruppe betreten"), s. `groupActions.ts`.
  const groupPath = useStore((s) => s.groupPath);
  const setGroupPath = useStore((s) => s.setGroupPath);

  return {
    selection,
    setSelection,
    clearSelection,
    // Bequemer Einzel-Selektor (erste gewählte Wand).
    selectedWallId: selection.walls[0] ?? null,
    selectedDrawingId: single(selection, "drawings"),
    selectedCeilingId: single(selection, "ceilings"),
    selectedSectionLineId: single(selection, "sectionLines"),
    selectedRoomId: single(selection, "rooms"),
    elementClipboard,
    setElementClipboard,
    section3dCutId,
    setSection3dCutId,
    updateRoof,
    moveRoofGrip,
    moveRoofBy,
    groupPath,
    setGroupPath,
  };
}

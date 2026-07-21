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
import type { Drawing2D } from "../model/types";

export function useSelectionState() {
  const selectedWallIds = useStore((s) => s.selectedWallIds);
  const setSelectedWallIds = useStore((s) => s.setSelectedWallIds);
  // 2D-Auswahl ist jetzt eine MENGE (Marquee/Mehrfach). Für die bestehende
  // Einzel-Element-Maschinerie (Grips, Edit, Attribute, Object-Info) wird lokal
  // der „eine" gewählte Zeichnungs-ID abgeleitet (nur bei genau einem Element);
  // `setSelectedDrawingId` bleibt als bequeme Einzel-Setter-Hülle erhalten.
  const selectedDrawingIds = useStore((s) => s.selectedDrawingIds);
  const setSelectedDrawingIds = useStore((s) => s.setSelectedDrawingIds);
  const selectedDrawingId =
    selectedDrawingIds.length === 1 ? selectedDrawingIds[0] : null;
  const setSelectedDrawingId = (id: string | null) =>
    setSelectedDrawingIds(id ? [id] : []);
  // Zwischenablage für 2D-Zeichenelemente (Ctrl/Cmd+C/V). Kopiert die GEWÄHLTEN
  // Drawing2D tief; Einfügen legt Klone mit neuen IDs auf dem AKTIVEN Geschoss
  // (Zeichnungsebene) an — so lässt sich z. B. importiertes Mobiliar über
  // Geschosse hinweg wiederverwenden. Kategorie/Stil bleiben erhalten.
  const [drawingClipboard, setDrawingClipboard] = useState<Drawing2D[]>([]);
  // Bequemer Einzel-Selektor (erste gewählte Wand).
  const selectedWallId = selectedWallIds[0] ?? null;
  // Decken-Auswahl (MENGE); für die Einzel-Element-Maschinerie der „eine"
  // gewählte (bei genau einem Element).
  const selectedCeilingIds = useStore((s) => s.selectedCeilingIds);
  const setSelectedCeilingIds = useStore((s) => s.setSelectedCeilingIds);
  const selectedCeilingId =
    selectedCeilingIds.length === 1 ? selectedCeilingIds[0] : null;
  // Dach-Auswahl (MENGE); Einzel-Element bei genau einem gewählten Dach.
  const selectedRoofIds = useStore((s) => s.selectedRoofIds);
  const setSelectedRoofIds = useStore((s) => s.setSelectedRoofIds);
  const selectedRoofId = selectedRoofIds.length === 1 ? selectedRoofIds[0] : null;
  // Schnitt-/Ansichtslinien-Auswahl (Einzel-DrawingLevel-Id oder null).
  const selectedSectionLineId = useStore((s) => s.selectedSectionLineId);
  const setSelectedSectionLineId = useStore((s) => s.setSelectedSectionLineId);
  // Welche Schnittlinie treibt den 3D-Live-Schnitt (reiner Ansichts-Zustand,
  // unabhängig von der Auswahl — der Schnitt bleibt beim Klick woanders aktiv).
  const [section3dCutId, setSection3dCutId] = useState<string | null>(null);
  const updateRoof = useStore((s) => s.updateRoof);
  const moveRoofGrip = useStore((s) => s.moveRoofGrip);
  const moveRoofBy = useStore((s) => s.moveRoofBy);
  const selectedOpeningIds = useStore((s) => s.selectedOpeningIds);
  const setSelectedOpeningIds = useStore((s) => s.setSelectedOpeningIds);
  const selectedOpeningId =
    selectedOpeningIds.length === 1 ? selectedOpeningIds[0] : null;
  const selectedStairIds = useStore((s) => s.selectedStairIds);
  const setSelectedStairIds = useStore((s) => s.setSelectedStairIds);
  const selectedStairId =
    selectedStairIds.length === 1 ? selectedStairIds[0] : null;
  const selectedRoomIds = useStore((s) => s.selectedRoomIds);
  const setSelectedRoomIds = useStore((s) => s.setSelectedRoomIds);
  const selectedRoomId =
    selectedRoomIds.length === 1 ? selectedRoomIds[0] : null;
  const selectedExtrudedSolidIds = useStore((s) => s.selectedExtrudedSolidIds);
  const setSelectedExtrudedSolidIds = useStore((s) => s.setSelectedExtrudedSolidIds);
  const selectedExtrudedSolidId =
    selectedExtrudedSolidIds.length === 1 ? selectedExtrudedSolidIds[0] : null;
  const selectedColumnIds = useStore((s) => s.selectedColumnIds);
  const setSelectedColumnIds = useStore((s) => s.setSelectedColumnIds);
  const selectedColumnId =
    selectedColumnIds.length === 1 ? selectedColumnIds[0] : null;
  const selectedContextObjectIds = useStore((s) => s.selectedContextObjectIds);
  const setSelectedContextObjectIds = useStore((s) => s.setSelectedContextObjectIds);

  return {
    selectedWallIds,
    setSelectedWallIds,
    selectedDrawingIds,
    setSelectedDrawingIds,
    selectedDrawingId,
    setSelectedDrawingId,
    drawingClipboard,
    setDrawingClipboard,
    selectedWallId,
    selectedCeilingIds,
    setSelectedCeilingIds,
    selectedCeilingId,
    selectedRoofIds,
    setSelectedRoofIds,
    selectedRoofId,
    selectedSectionLineId,
    setSelectedSectionLineId,
    section3dCutId,
    setSection3dCutId,
    updateRoof,
    moveRoofGrip,
    moveRoofBy,
    selectedOpeningIds,
    setSelectedOpeningIds,
    selectedOpeningId,
    selectedStairIds,
    setSelectedStairIds,
    selectedStairId,
    selectedRoomIds,
    setSelectedRoomIds,
    selectedRoomId,
    selectedExtrudedSolidIds,
    setSelectedExtrudedSolidIds,
    selectedExtrudedSolidId,
    selectedColumnIds,
    setSelectedColumnIds,
    selectedColumnId,
    selectedContextObjectIds,
    setSelectedContextObjectIds,
  };
}

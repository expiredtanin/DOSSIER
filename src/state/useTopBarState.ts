// Bündelt den Oberleisten-/Status-Zustand (View-State, kein Modell): Detail-
// stufe, 3D-Rendermodus, Feldweite, Boden-Referenzraster, Plan-Farbmodus,
// Wand-Achslinien, Linienmodus, Fadenkreuz-/Snap-Farbe und Papier-Massstab
// kommen aus dem Store; liveScale/selectedViewSnapshotId/cursor sind rein
// lokaler UI-State (PlanView meldet den Live-Massstab, kein Undo/Redo-Bezug).
// zoomPercent ist daraus abgeleitet. Nur aus App() herausgezogen, um die
// Funktion zu entlasten — reine Zustands-Bündelung, keine Verhaltensänderung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useState } from "react";
import { useStore } from "./appStore";

export function useTopBarState() {
  const detail = useStore((s) => s.detail);
  const setDetail = useStore((s) => s.setDetail);
  const renderMode = useStore((s) => s.renderMode);
  const setRenderMode = useStore((s) => s.setRenderMode);
  const view3d = useStore((s) => s.view3d);
  const setView3d = useStore((s) => s.setView3d);
  const fov = useStore((s) => s.fov);
  const setFov = useStore((s) => s.setFov);
  // Boden-Referenzraster im 3D-Viewport (wirkt nur im WASM/Nordstern-Pfad,
  // s. Wasm3DViewport.tsx) — Umschalter sitzt als Overlay-Button im Viewport.
  const grid3dVisible = useStore((s) => s.grid3dVisible);
  const setGrid3dVisible = useStore((s) => s.setGrid3dVisible);
  const planColorMode = useStore((s) => s.planColorMode);
  const setPlanColorMode = useStore((s) => s.setPlanColorMode);
  const referenceLines = useStore((s) => s.referenceLines);
  const setReferenceLines = useStore((s) => s.setReferenceLines);
  const lineMode = useStore((s) => s.lineMode);
  const setLineMode = useStore((s) => s.setLineMode);
  const marqueeColor = useStore((s) => s.marqueeColor);
  const setMarqueeColor = useStore((s) => s.setMarqueeColor);
  const snapColor = useStore((s) => s.snapColor);
  const setSnapColor = useStore((s) => s.setSnapColor);
  const scaleDenominator = useStore((s) => s.scaleDenominator);
  const setScaleDenominator = useStore((s) => s.setScaleDenominator);
  // Der LIVE Papier-Massstab (PlanView meldet ihn) lebt in `liveScaleStore` ([121]): sonst
  // rendert jeder Zoom-Schritt die ganze App neu.
  // „Angewählter" Ausschnitt (View-Snapshot): bleibt gesetzt, solange der
  // Live-Zustand EXAKT dem Ausschnitt entspricht (siehe Effekt weiter unten).
  // Steuert die Footer-Bar + die Aktiv-Markierung im Ausschnitte-Panel.
  const [selectedViewSnapshotId, setSelectedViewSnapshotId] = useState<
    string | null
  >(null);

  return {
    detail,
    setDetail,
    renderMode,
    setRenderMode,
    view3d,
    setView3d,
    fov,
    setFov,
    grid3dVisible,
    setGrid3dVisible,
    planColorMode,
    setPlanColorMode,
    referenceLines,
    setReferenceLines,
    lineMode,
    setLineMode,
    marqueeColor,
    setMarqueeColor,
    snapColor,
    setSnapColor,
    scaleDenominator,
    setScaleDenominator,
    selectedViewSnapshotId,
    setSelectedViewSnapshotId,
  };
}

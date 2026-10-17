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
  // LIVE Papier-Massstab-Nenner aus der View-Transform (PlanView meldet ihn);
  // null = keine Plan-Ansicht aktiv. Transienter UI-State, bleibt lokal.
  const [liveScale, setLiveScale] = useState<number | null>(null);
  // „Angewählter" Ausschnitt (View-Snapshot): bleibt gesetzt, solange der
  // Live-Zustand EXAKT dem Ausschnitt entspricht (siehe Effekt weiter unten).
  // Steuert die Footer-Bar + die Aktiv-Markierung im Ausschnitte-Panel.
  const [selectedViewSnapshotId, setSelectedViewSnapshotId] = useState<
    string | null
  >(null);
  // Live-Zoom in Prozent RELATIV zum angewandten Papier-Massstab: 100 % =
  // Live-Ansicht steht exakt im angewandten Massstab (liveScale == scaleDenominator).
  // Reinzoomen > 100 %, Rauszoomen < 100 %. Einzige Quelle: angewandter Nenner
  // (scaleDenominator) / Live-Nenner (liveScale). Ohne Live-Massstab (keine
  // Plan-Ansicht) Fallback 100 %.
  const zoomPercent =
    liveScale != null && liveScale > 0
      ? (scaleDenominator / liveScale) * 100
      : 100;

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
    liveScale,
    setLiveScale,
    selectedViewSnapshotId,
    setSelectedViewSnapshotId,
    zoomPercent,
  };
}

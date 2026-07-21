// Bündelt den Zeichenwerkzeug-Zustand (transienter View-State; bleibt lokal):
// aktives Werkzeug, Werkzeug-Parameter (Wandtyp/Kategorie/Linienstil), Snap-
// Einstellungen sowie der laufende Werkzeug-Zustand (Ref, kein Re-Render je
// Mausbewegung), die Live-Vorschau (Draft → Overlay in PlanView) und die
// aktive Transformation (Bewegen/Spiegeln/Drehen) auf der Auswahl. Nur aus
// App() herausgezogen, um die Funktion zu entlasten — reine Zustands-
// Bündelung, keine Verhaltensänderung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useRef, useState } from "react";
import { useStore } from "./appStore";
import { getTool } from "../tools/tools";
import type { CopyMode, TransformOp } from "../tools/transform";
import { DEFAULT_SNAP } from "../tools/types";
import type { SnapSettings, ToolDraft, ToolId, ToolState } from "../tools/types";
import type { Vec2 } from "../model/types";

export function useDrawingToolState(initialWallTypeId: string, initialLineStyleId: string) {
  const [activeTool, setActiveTool] = useState<ToolId>("select");
  const [activeWallTypeId, setActiveWallTypeId] = useState<string>(initialWallTypeId);
  const activeCategoryCode = useStore((s) => s.activeCategoryCode);
  const setActiveCategoryCode = useStore((s) => s.setActiveCategoryCode);
  const [activeLineStyleId] = useState<string>(initialLineStyleId);
  const [snap, setSnap] = useState<SnapSettings>(DEFAULT_SNAP);
  const toolStateRef = useRef<ToolState>(getTool("select").init());
  const [draft, setDraft] = useState<ToolDraft | null>(null);
  // Aktive Transformation (Bewegen/Spiegeln/Drehen) auf der Auswahl — Vectorworks-
  // Stil mit U/I/O/P-Modusleiste. null = keine Transformation läuft.
  const [activeTransform, setActiveTransform] = useState<{
    op: TransformOp;
    copyMode: CopyMode;
    count: number;
    points: Vec2[];
  } | null>(null);
  // Letzter gesnappter Cursor der laufenden Transformation — für das Live-Feld
  // (Winkel/Distanz) der Befehlszeile (analog gripDragInfoRef beim Vertex-Drag).
  const transformDragInfoRef = useRef<{ cursor: Vec2 } | null>(null);
  // Kopienanzahl für array/distribute wird über einen PromptDialog erfasst
  // (window.prompt ist im Tauri-WKWebView deaktiviert) — `pendingCopyMode`
  // hält den Modus, während der Dialog offen ist.
  const [pendingCopyMode, setPendingCopyMode] = useState<"array" | "distribute" | null>(null);
  const requestCopyCount = (mode: "array" | "distribute") => setPendingCopyMode(mode);
  const commitCopyCount = (input: string) => {
    const n = Math.round(Number(input));
    if (Number.isFinite(n) && n >= 1 && pendingCopyMode) {
      const mode = pendingCopyMode;
      setActiveTransform((t) => (t ? { ...t, copyMode: mode, count: n } : t));
    }
    setPendingCopyMode(null);
  };

  return {
    activeTool,
    setActiveTool,
    activeWallTypeId,
    setActiveWallTypeId,
    activeCategoryCode,
    setActiveCategoryCode,
    activeLineStyleId,
    snap,
    setSnap,
    toolStateRef,
    draft,
    setDraft,
    activeTransform,
    setActiveTransform,
    transformDragInfoRef,
    pendingCopyMode,
    setPendingCopyMode,
    requestCopyCount,
    commitCopyCount,
  };
}

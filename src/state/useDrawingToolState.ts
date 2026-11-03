// Bündelt den Zeichenwerkzeug-Zustand (transienter View-State; bleibt lokal):
// aktives Werkzeug, Werkzeug-Parameter (Wandtyp/Kategorie/Linienstil), Snap-
// Einstellungen, die Live-Vorschau (Draft → Overlay in PlanView) und der Dialog für die
// Kopienanzahl (N Kopien/Verteilen der Transformations-Befehle). Nur aus App() herausgezogen,
// um die Funktion zu entlasten — reine Zustands-Bündelung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useState } from "react";
import { useStore } from "./appStore";
import { DEFAULT_SNAP } from "../tools/types";
import type { SnapSettings, ToolDraft, ToolId } from "../tools/types";

export function useDrawingToolState(initialWallTypeId: string, initialLineStyleId: string) {
  const [activeTool, setActiveTool] = useState<ToolId>("select");
  const [activeWallTypeId, setActiveWallTypeId] = useState<string>(initialWallTypeId);
  const activeCategoryCode = useStore((s) => s.activeCategoryCode);
  const setActiveCategoryCode = useStore((s) => s.setActiveCategoryCode);
  const [activeLineStyleId] = useState<string>(initialLineStyleId);
  const [snap, setSnap] = useState<SnapSettings>(DEFAULT_SNAP);
  const [draft, setDraft] = useState<ToolDraft | null>(null);
  // Kopienanzahl für array/distribute wird über einen PromptDialog erfasst
  // (window.prompt ist im Tauri-WKWebView deaktiviert) — `pendingCopyMode`
  // hält den Modus, während der Dialog offen ist.
  const [pendingCopyMode, setPendingCopyMode] = useState<"array" | "distribute" | null>(null);
  const requestCopyCount = (mode: "array" | "distribute") => setPendingCopyMode(mode);
  /** Dialog-Eingabe übernehmen: `apply(mode, n)` (Option an den laufenden Befehl), dann schliessen. */
  const commitCopyCount = (input: string, apply: (mode: "array" | "distribute", n: number) => void) => {
    const n = Math.round(Number(input));
    if (Number.isFinite(n) && n >= 1 && pendingCopyMode) apply(pendingCopyMode, n);
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
    draft,
    setDraft,
    pendingCopyMode,
    setPendingCopyMode,
    requestCopyCount,
    commitCopyCount,
  };
}

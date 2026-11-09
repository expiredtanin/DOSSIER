// Werkzeug-Eingabe → Befehls-Engine ([163], aus App.tsx herausgelöst): die Plan-Handler
// (`toolHandlers`: Bewegen, Klick, Rechtsklick), die Werkzeugwahl der Palette (`onSelectTool`),
// Ribbon-Befehle (`onRunCommand`) und die 3D-Arbeitsebene (`onWorkplanePoint`). Alles mündet in
// dieselbe `CommandEngine` aus `useCommandEngineHost`. Aufgerufen von `App.tsx` direkt nach dem
// Engine-Host; `TRANSFORM_COMMANDS` nutzen auch `useSelectionCommands` und die Effekte in App.

import type { RefObject } from "react";
import type { Vec2 } from "../model/types";
import { toolInfo } from "../tools/tools";
import type { ToolDraft, ToolHandlers, ToolId } from "../tools/types";
import type { EngineMods } from "../commands/engine";
import type { useCommandEngineHost } from "./useCommandEngineHost";

type EngineHost = ReturnType<typeof useCommandEngineHost>;

/**
 * Befehlsname für ein gekoppeltes Werkzeug (oder null). Die Zeichen-Werkzeuge der Palette sind
 * Engine-Befehle: ein Klick auf das Werkzeug startet diesen Befehl (`tools/tools.ts`, [123]).
 */
function coupledCommandFor(id: ToolId): string | null {
  return toolInfo(id).command ?? null;
}

/** Transformations-Befehle der Auswahl: Rechtsklick bricht ab, Geschoss-/Ansichtswechsel auch. */
export const TRANSFORM_COMMANDS = new Set(["move", "rotate", "mirror"]);

export function useToolInput(opts: {
  engineRef: EngineHost["engineRef"];
  engine: EngineHost["engine"];
  commandLineRef: EngineHost["commandLineRef"];
  activeTool: ToolId;
  setActiveTool: (id: ToolId) => void;
  draft: ToolDraft | null;
  imageInputRef: RefObject<HTMLInputElement | null>;
}) {
  const { engineRef, engine, commandLineRef, activeTool, setActiveTool, draft, imageInputRef } = opts;

  const toolHandlers: ToolHandlers = {
    onToolMove: (raw, _pxPerMeter, mods) => {
      // Läuft ein Befehl, übernimmt die Engine die Plan-Eingabe (ein Eingabepfad).
      // Modifikatoren (Shift=Ortho, Ctrl=Snap aus) mitgeben, damit auch der ERSTE
      // Punkt sauber snappt bzw. unterdrückt werden kann. Ohne Befehl: nur Hover.
      engineRef.current?.move(raw, { shift: mods.shift, ctrl: mods.ctrl });
    },
    onToolClick: (raw, _pxPerMeter, mods) => {
      const em = { shift: mods.shift, ctrl: mods.ctrl };
      if (engineRef.current?.isActive()) {
        engineRef.current.pick(raw, em);
        return;
      }
      // Gekoppeltes Werkzeug, aber der Befehl ist (nach Commit) beendet: denselben
      // Befehl neu starten und den Klick als ersten Punkt durchreichen — so bleibt
      // das Werkzeug wie in einem CAD armiert. Der erste Punkt snappt ebenfalls.
      const cmd = coupledCommandFor(activeTool);
      if (cmd) {
        engineRef.current?.start(cmd);
        engineRef.current?.pick(raw, em);
      }
    },
    onToolCommit: () => {
      // Rechtsklick im Viewport = Enter an die Engine (§2.3); in einer Transformation = abbrechen.
      const eng = engineRef.current;
      if (!eng?.isActive()) return;
      if (TRANSFORM_COMMANDS.has(eng.activeCommandName() ?? "")) eng.cancel();
      else eng.confirm();
    },
    draft,
  };

  // ── GUI-Werkzeug ↔ Befehls-Engine (ein Eingabe-Hub) ───────────────────────
  // Ein Klick auf ein gekoppeltes Zeichen-Werkzeug (Wand/Linie/Rechteck/Polylinie)
  // STARTET den passenden Befehl in der Engine und fokussiert das Befehlsfeld
  // („Dialog drin"). „Auswahl" beendet einen laufenden Befehl (Auswahl-Modus).
  const onSelectTool = (id: ToolId) => {
    // Erneuter Klick auf das bereits AKTIVE Werkzeug schaltet zurück auf
    // „Auswahl" (Nutzer-Wunsch) — statt das Werkzeug einfach neu zu starten.
    if (id !== "select" && id === activeTool) id = "select";
    if (id === "image") {
      // Datei-Auswahl ist async (Dateidialog) — kein Klick-Platzieren wie bei
      // den übrigen Zeichen-Werkzeugen, daher hier abgefangen statt über die
      // Befehls-Engine/`activeTool` zu laufen (s. tools/tools.ts).
      imageInputRef.current?.click();
      return;
    }
    const cmd = coupledCommandFor(id);
    if (cmd) {
      // Den gekoppelten Befehl in DERSELBEN Engine starten wie das Tippen von
      // „line" — Klick und Tippen münden in denselben Befehl. Das aktive-Tool-
      // Highlight spiegelt den laufenden Befehl (activeTool = id); toolHandlers
      // leiten Move/Pick/Confirm an die Engine (siehe oben).
      engine.start(cmd);
      setActiveTool(id);
      // Befehlsfeld fokussieren: getippte Präzisionseingabe steht sofort bereit.
      // Nach dem Render des aktiven Prompts fokussieren (nächster Tick).
      requestAnimationFrame(() => commandLineRef.current?.focus());
      return;
    }
    // „Auswahl": laufenden Befehl beenden.
    if (engine.isActive()) engine.cancel();
    setActiveTool(id);
  };

  // Ribbon-Befehl (Ändern-Gruppe u. a.): startet einen Engine-Befehl OHNE
  // eigenes Werkzeug (kein ToolId). Läuft über DIESELBE Engine wie das Tippen des
  // Befehls; das Werkzeug-Highlight fällt auf „Auswahl" zurück, das Aktiv-
  // Highlight des Ribbon-Befehls spiegelt der laufende Befehl (engineView).
  // Bewegen/Drehen/Spiegeln sind gewöhnliche Befehle ([123]); ohne Auswahl starten sie nicht
  // (Hinweis über den Engine-Host) und das Werkzeug bleibt, wie es ist.
  const onRunCommand = (name: string) => {
    if (!engine.start(name) && TRANSFORM_COMMANDS.has(name)) return;
    setActiveTool("select");
    requestAnimationFrame(() => commandLineRef.current?.focus());
  };

  // 3D-Viewport als Erstellungs-Fläche: der Viewport projiziert den Cursor auf
  // die Geschoss-Arbeitsebene und liefert einen rohen Modell-`Vec2`; wir füttern
  // ihn in DIESELBE ansichts-agnostische CommandEngine wie PlanView (move/pick).
  // Snapping/Tab-Felder/Commit laufen unverändert über den EngineHost; die neuen
  // Elemente landen auf dem aktiven Geschoss (host.context().level).
  const onWorkplanePoint = (kind: "move" | "pick", model: Vec2, mods?: EngineMods) => {
    const eng = engineRef.current;
    if (!eng?.isActive()) return;
    if (kind === "move") eng.move(model, mods);
    else eng.pick(model, mods);
  };
  const onWorkplaneConfirm = () => {
    // Rechtsklick-ohne-Drag/Doppelklick im 3D — dasselbe Verhalten wie `onToolCommit` im 2D-Plan.
    toolHandlers.onToolCommit();
  };

  return { toolHandlers, onSelectTool, onRunCommand, onWorkplanePoint, onWorkplaneConfirm };
}

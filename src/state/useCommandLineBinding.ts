// Befehlszeile und Cursor-HUD ([163], aus App.tsx herausgelöst): entscheidet, wer Befehlsfeld und HUD
// belegt — ein laufender Griff-Drag (2D-Punkt, 2D-Kante, 3D) als Feld-Controller oder sonst die
// Befehls-Engine — und leitet Eingabe, Tab und Esc dorthin. Getippte Längen werden aus Anzeige-
// Einheiten (Blatt: Papier-mm) in Meter umgerechnet. Aufgerufen von `App.tsx`; die Werte gehen an
// `CommandLine` und die Hauptansicht (`hudFields`).

import type { RefObject } from "react";
import { NON_LENGTH_FIELDS } from "../commands/parseInput";
import type { EngineView } from "../commands/engine";
import { lengthFromDisplay, type DisplayUnits } from "../tools/displayUnits";
import { grip3dEditFields } from "../viewport/grip3dHud";
import type { PlanViewHandle } from "../views/plan/PlanView";
import type { useCommandEngineHost } from "./useCommandEngineHost";
import type { useGrip3dEditing } from "./useGrip3dEditing";
import type { useGripEditing } from "./useGripEditing";


/** Keine Inline-Optionen (stabile Identität für die memoisierte Befehlszeile, [121]). */
const NO_OPTIONS: EngineView["options"] = [];

export function useCommandLineBinding(opts: {
  engine: ReturnType<typeof useCommandEngineHost>["engine"];
  engineView: EngineView;
  commandActive: boolean;
  cmdTyped: string;
  displayUnits: DisplayUnits;
  planViewRef: RefObject<PlanViewHandle>;
  grip2d: ReturnType<typeof useGripEditing>;
  grip3d: ReturnType<typeof useGrip3dEditing>;
}) {
  const { engine, engineView, commandActive, cmdTyped, displayUnits, planViewRef } = opts;
  const {
    gripEdit,
    gripEditFields,
    submitGripEditValue,
    cycleGripEditField,
    closeGripEditField,
    edgeEdit,
    edgeEditFields,
    submitEdgeEditValue,
    cycleEdgeEditField,
    closeEdgeEditField,
  } = opts.grip2d;
  const { grip3dEdit, setGrip3dEdit, last3dDragRef, cycleGrip3dEditField, submitGrip3dEditValue } = opts.grip3d;

  // Feld-Zustand fürs Cursor-HUD (neben der Maus, VW-Stil): läuft ein Punkt-
  // ODER Kanten-Griff-Drag, hat er Vorrang (dieselben Felder wie unten in der
  // Befehlszeile — Länge/Winkel- bzw. Abstand-Tab-Zyklus), sonst die Befehls-
  // Engine-Felder (Zeichnen; Winkel beim Drehen bzw. Distanz beim Bewegen). Vorher zeigte das Cursor-HUD beim Griff-Ziehen
  // GAR KEINE Länge/Winkel-Werte an (nur die Befehlszeile unten) — Nutzer-
  // Wunsch: „du kannst [Länge/Winkel] gleich bei der Maus anzeigen wie beim
  // Erstellen".
  const hudFields =
    gripEdit
      ? { fields: gripEditFields(), typed: cmdTyped }
      : edgeEdit
        ? { fields: edgeEditFields(), typed: cmdTyped }
        : grip3dEdit
          ? {
              fields: grip3dEditFields(grip3dEdit, last3dDragRef.current?.raw ?? grip3dEdit.anchor),
              typed: cmdTyped,
            }
          : commandActive && engineView.fields.length > 0
            ? {
                fields: engineView.fields.map((f) => ({
                  id: f.id,
                  value: f.value,
                  locked: f.locked,
                  active: f.active,
                })),
                typed: cmdTyped,
              }
            : null;

  // Befehlszeile (Rhino-artig): Während eines Vertex- ODER Kanten-Griff-Drags belegt der Feld-
  // Controller das Befehlsfeld (Länge/Winkel bzw. Abstand). Läuft eine Auswahl-Transformation
  // (Drehen etc.), belegt sie Prompt + U/I/O/P + Winkel-/Distanzfeld. Sonst gilt die Engine
  // (Zeichnen/Ruhe). Griff-/Kanten-Drag haben Vorrang (schließen sich sonst aus).
  const fieldController = !!(gripEdit || edgeEdit || grip3dEdit);
  const cmdLineActive = fieldController ? true : engineView.active;
  const cmdLinePromptKey = gripEdit
    ? "cmd.edit.point"
    : edgeEdit
    ? "cmd.edit.edge"
    : grip3dEdit
    ? "cmd.edit.point"
    : engineView.promptKey;
  const cmdLineOptions = fieldController ? NO_OPTIONS : engineView.options;
  const cmdLineFields = gripEdit
    ? gripEditFields()
    : edgeEdit
    ? edgeEditFields()
    : grip3dEdit
    ? grip3dEditFields(grip3dEdit, last3dDragRef.current?.raw ?? grip3dEdit.anchor)
    : engineView.fields;
  const cmdLineSteps = fieldController ? 0 : engineView.steps;

  const onCmdSubmit = (text: string) => {
    // Feld-Controller (Griff, Kante): getippte Länge in Anzeige-Einheiten
    // (Blatt: Papier-mm) → Meter; Winkel/Anzahl bleiben.
    const ctlFields = gripEdit
      ? gripEditFields()
      : edgeEdit
      ? edgeEditFields()
      : [];
    const ctlActive = ctlFields.find((f) => f.active)?.id;
    const typed = (raw: string): number => {
      const n = parseFloat(raw.replace(",", "."));
      return ctlActive && !NON_LENGTH_FIELDS.has(ctlActive) ? lengthFromDisplay(displayUnits, n) : n;
    };
    if (gripEdit) {
      const v = typed(text);
      if (isFinite(v)) submitGripEditValue(v);
      // Leere Eingabe: kein neuer Wert zu locken — Enter bestätigt
      // stattdessen die aktuelle Position (Maus- oder bereits
      // gelockte Werte) und schließt die Griff-Bearbeitung ab. Vorher
      // ein Totdruck (Nutzer-Report: Enter tat nichts).
      else planViewRef.current?.confirmGripEdit();
      return;
    }
    if (edgeEdit) {
      const v = typed(text);
      if (isFinite(v)) submitEdgeEditValue(v);
      else planViewRef.current?.confirmEdgeEdit();
      return;
    }
    if (grip3dEdit) {
      const v = parseFloat(text.replace(",", "."));
      if (isFinite(v)) submitGrip3dEditValue(v);
      // Leere Eingabe: Feld-Controller schliessen, Maus steuert den
      // laufenden Griff-Drag wieder normal weiter (kein 3D-Äquivalent
      // zu `confirmGripEdit` — die Maustaste bleibt physisch gedrückt).
      else setGrip3dEdit(null);
      return;
    }
    engine.submitText(text);
  };
  const onCmdCycleField = () =>
    gripEdit
      ? cycleGripEditField()
      : edgeEdit
      ? cycleEdgeEditField()
      : grip3dEdit
      ? cycleGrip3dEditField()
      : engine.cycleField();
  const onCmdCancel = () =>
    gripEdit
      ? closeGripEditField()
      : edgeEdit
      ? closeEdgeEditField()
      : grip3dEdit
      ? setGrip3dEdit(null)
      : engine.escape();

  return {
    hudFields,
    cmdLineActive,
    cmdLinePromptKey,
    cmdLineOptions,
    cmdLineFields,
    cmdLineSteps,
    onCmdSubmit,
    onCmdCycleField,
    onCmdCancel,
  };
}

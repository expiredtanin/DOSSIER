// Text-Ziel der Oberleisten-Formatierung ([163], aus App.tsx herausgelöst): der Stempel-Text des
// einzeln gewählten Raums oder ein gewählter freier Text, mit einem Setter, der live ins Projekt
// schreibt. Ohne passendes Element `null` (die Leiste setzt dann nur Vorgaben). Aufgerufen von
// `App.tsx`; das Ergebnis geht an `ViewRibbonTab`.

import { useMemo } from "react";
import type { Project, Room } from "../model/types";
import { docFromText, plainText } from "../text/richText";
import type { RichTextDoc } from "../text/richText";
import { useEventBundle } from "./useEvent";
import type { useProjectActions } from "./useProjectActions";

type ProjectActions = ReturnType<typeof useProjectActions>;

export function useTextTarget(opts: {
  project: Project;
  selectedRoom: Room | null;
  selectedDrawingId: string | null;
  setRoomStampDoc: ProjectActions["setRoomStampDoc"];
  updateDrawing2D: ProjectActions["updateDrawing2D"];
}) {
  const { project, selectedRoom, selectedDrawingId, setRoomStampDoc, updateDrawing2D } = opts;
  // Text-Ziel der Oberleisten-Text-Gruppe: der Stempel-Text des (einzeln)
  // gewählten Raums. Ohne aktive Editor-Auswahl wirkt Formatierung auf das ganze
  // Doc (range: null). Ist kein Raum gewählt → null (Controls setzen nur
  // Defaults). Der Setter schreibt live in den Store.
  // Store-Aktionen mit stabiler Identität ([121]): sonst wäre `textTarget` je Render neu.
  const textActions = useEventBundle({ setRoomStampDoc, updateDrawing2D });
  const textTarget = useMemo(() => {
    if (selectedRoom) {
      return {
        doc: selectedRoom.stampDoc ?? docFromText(selectedRoom.name),
        range: null,
        apply: (doc: RichTextDoc) => textActions.setRoomStampDoc(selectedRoom.id, doc),
      };
    }
    // Selektierter freier Text/Textspalte: die Oberleisten-Formatier-Gruppe wirkt
    // auf Schriftfamilie/fett/kursiv/Farbe des ganzen Texts. Die GRÖSSE bleibt
    // bewusst über die Modell-Höhe (Meter, height) geführt — nicht über sizePt,
    // damit der Text im Massstab bleibt (Punkt-Grössen wären massstabslos).
    if (selectedDrawingId) {
      const d = project.drawings2d.find((x) => x.id === selectedDrawingId);
      if (d && d.geom.shape === "text") {
        const g = d.geom;
        // Trägt das Element bereits ein reiches Doc (Doppelklick-Editor), wirkt
        // die Oberleiste per Bereichs-Operation (toggleMark/applyMark) DARAUF —
        // Mischformatierung anderer Runs bleibt erhalten. Ohne Doc (Alt-Element)
        // bleibt das bisherige Uniform-Verhalten (ein `marks`-Objekt fürs Ganze).
        const doc = g.doc ?? docFromText(g.text, g.marks ?? {});
        return {
          doc,
          range: null,
          apply: (newDoc: RichTextDoc) => {
            const runMarks = newDoc.paragraphs.flatMap((p) => p.runs)[0]?.marks ?? {};
            const marks = { ...runMarks };
            delete marks.sizePt; // Grösse folgt der Modell-Höhe, nicht dem pt-Wert.
            const patch = g.doc
              ? { doc: newDoc, text: plainText(newDoc), marks }
              : { text: plainText(newDoc), marks };
            textActions.updateDrawing2D(d.id, { geom: { ...g, ...patch } });
          },
        };
      }
    }
    return null;
  }, [selectedRoom, textActions, selectedDrawingId, project.drawings2d]);
  return textTarget;
}

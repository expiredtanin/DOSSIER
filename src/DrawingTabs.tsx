// Dokument-Tabs „Zeichnungen/Blätter" — Kopfzeile über der Zeichenfläche.
//
// Ersetzt die frühere Kopfzeile mit Geschosshöhe/Schnitthöhe (diese Werte
// werden jetzt ausschliesslich in den Geschoss-Einstellungen gepflegt, siehe
// den Editor `editor.floorHeight`/`editor.cutHeight` in App.tsx). Ein Tab
// entspricht heute immer dem Grundriss eines Geschosses; ein Klick aktiviert
// dessen Zeichnungsebene über denselben State, den auch das Panel
// „Zeichnungsebenen" (DrawingLevelsPanel) verwendet — beide bleiben so
// zwangsläufig synchron.
//
// Der Typ `Drawing` ist bewusst schlank gehalten, damit künftige Arten
// (Schnitt-Blatt, Layout) sich später einhängen können, ohne dass die
// Tab-Leiste selbst umgebaut werden muss — siehe `activate()` unten.
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import type { DrawingLevel } from "./model/types";
import { t } from "./i18n";

/** Art einer Dokument-Zeichnung. Heute nur der Grundriss eines Geschosses;
 *  Platz für künftige Arten (z. B. "section", "layout") bleibt offen. */
export type DrawingKind = "plan";

/** Ein Tab der Dokument-Leiste — leichtgewichtiger Verweis auf die Quelle
 *  (aktuell immer eine Zeichnungsebene vom Typ "floor"). */
export interface Drawing {
  id: string;
  title: string;
  kind: DrawingKind;
  /** Geschoss/Zeichnungsebene, deren Grundriss dieser Tab zeigt. */
  levelId: string;
}

/** Leitet die Dokument-Tabs aus den Geschossen des Projekts ab — ein Tab je
 *  Geschoss. Schnitte/Ansichten und freie Zeichnungen bleiben vorerst aussen
 *  vor (weiterhin nur über das Panel „Zeichnungsebenen" erreichbar). */
export function deriveDrawings(levels: DrawingLevel[]): Drawing[] {
  return levels
    .filter((level): level is DrawingLevel & { kind: "floor" } => level.kind === "floor")
    .map((level) => ({
      id: level.id,
      title: level.name,
      kind: "plan",
      levelId: level.id,
    }));
}

export function DrawingTabs({
  drawings,
  activeLevelId,
  onSelectLevel,
}: {
  drawings: Drawing[];
  /** Aktuell aktive Zeichnungsebene (globaler App-State, siehe App.tsx). */
  activeLevelId: string;
  /** Setter derselben Zeichnungsebene — identisch mit dem, den das Panel
   *  „Zeichnungsebenen" verwendet (kein paralleler State). */
  onSelectLevel: (id: string) => void;
}) {
  if (drawings.length === 0) return null;

  // Aktivierung nach Art dispatchen. Heute gibt es nur "plan" (→ Geschoss
  // aktivieren); künftige Arten hängen hier ihr eigenes Ziel ein, ohne dass
  // sich an der Tab-Leiste selbst etwas ändert.
  const activate = (drawing: Drawing) => {
    switch (drawing.kind) {
      case "plan":
        onSelectLevel(drawing.levelId);
        break;
    }
  };

  return (
    <div className="drawing-tabs" role="tablist" aria-label={t("tabs.drawings")}>
      {drawings.map((d) => (
        <button
          key={d.id}
          type="button"
          role="tab"
          aria-selected={d.levelId === activeLevelId}
          className={`drawing-tab${d.levelId === activeLevelId ? " active" : ""}`}
          onClick={() => activate(d)}
          title={d.title}
        >
          <span className="drawing-tab-label">{d.title}</span>
        </button>
      ))}
    </div>
  );
}

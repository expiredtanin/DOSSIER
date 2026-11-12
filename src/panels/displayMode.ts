// Darstellungsmodus — reiner Helfer.
//
// Übersetzt einen DisplayMode plus den Status eines Elements (aktiv? sichtbar?)
// in eine Render-Entscheidung: ob das Element gezeichnet wird, ob es ausgegraut
// erscheint und ob es gesperrt ist. Dieselbe Logik nutzen Navigator-Listen und
// die abgeleiteten Ansichten (3D, Grundriss), damit die Auswahl überall
// identisch wirkt. Die fünf Modi entsprechen DOSSIER (docs/design/context-menu.md).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md). Bewusst seiteneffektfrei.

import type { DisplayMode } from "./types";

/** Ergebnis von `itemDisplay`: zeichnen? ausgegraut? gesperrt? */
export interface ItemDisplay {
  /** Element zeichnen. */
  render: boolean;
  /** Element ausgegraut (gedimmt) darstellen. */
  greyed: boolean;
  /** Element gesperrt (nicht bearbeitbar) — nur im Modus „grey_locked". */
  locked: boolean;
}

/**
 * Entscheidet anhand des Modus und des Element-Status, wie ein Element
 * dargestellt wird — die fünf DOSSIER-Modi:
 *
 *   • "all_force"   — alle erzwungen zeichnen (Sichtbarkeits-Flag ignoriert),
 *                     nie ausgegraut.
 *   • "all"         — nur sichtbare zeichnen, nie ausgegraut.
 *   • "active"      — nur das aktive Element zeichnen, nie ausgegraut.
 *   • "grey"        — aktives normal; übrige nur, wenn sichtbar — dann
 *                     ausgegraut.
 *   • "grey_locked" — wie „grey", übrige (sichtbare, nicht aktive) zusätzlich
 *                     gesperrt.
 *   • "locked"      — aktives normal; übrige sichtbare UNVERÄNDERT farbig,
 *                     aber gesperrt (nicht anwählbar/bearbeitbar).
 *
 * Das aktive Element wird in "active"/"grey"/"grey_locked"/"locked" stets gezeichnet,
 * auch wenn seine Sichtbarkeit abgeschaltet ist — es ist der Arbeitsfokus. Ein
 * nicht aktives, unsichtbares Element wird (außer in "all_force") nie
 * gezeichnet.
 */
/** [196] Geschoss-ids, die die Zeichnungsebenen nach `display` nicht zeigen (Auge aus bzw. Modus) — fehlen auch im 3D. */
export function hiddenFloorIds(levels: readonly { id: string; kind: string }[], display: (id: string) => { render: boolean }): string[] {
  return levels.filter((l) => l.kind === "floor" && !display(l.id).render).map((l) => l.id);
}

/**
 * [196] Auge einer Zeichnungsebene in „Alle anzeigen"/„Nur aktive": Der Klick schaltet auf „Ausgewählte" um. Damit er nur
 * die eigene Ebene ändert, werden die Sichtbarkeits-Flags vorher auf das eingefroren, was der Modus gerade zeigt
 * (sonst erschienen alle Geschosse, deren Flag an war). `null` in den übrigen Modi (Flags gelten schon).
 */
export function frozenLevelFlags(mode: DisplayMode, levels: readonly { id: string }[], activeId: string): Record<string, boolean> | null {
  if (mode !== "all_force" && mode !== "active") return null;
  return Object.fromEntries(levels.map((l) => [l.id, itemDisplay(mode, l.id === activeId, true).render]));
}

export function itemDisplay(
  mode: DisplayMode,
  isActive: boolean,
  isVisible: boolean,
): ItemDisplay {
  switch (mode) {
    case "all_force":
      // Alles erzwungen sichtbar (Flags ignoriert), normal.
      return { render: true, greyed: false, locked: false };

    case "all":
      return { render: isVisible, greyed: false, locked: false };

    case "active":
      // Nur das aktive Element; andere werden nicht gezeichnet.
      return { render: isActive, greyed: false, locked: false };

    case "grey": {
      const other = isVisible && !isActive;
      return { render: isActive || isVisible, greyed: other, locked: false };
    }

    case "grey_locked": {
      // Wie „grey", übrige sichtbare zusätzlich gesperrt.
      const other = isVisible && !isActive;
      return { render: isActive || isVisible, greyed: other, locked: other };
    }

    case "locked": {
      // Wie „grey_locked", aber OHNE das Ausgrauen — übrige sichtbare bleiben
      // farbig, sind nur nicht mehr anwählbar/bearbeitbar.
      const other = isVisible && !isActive;
      return { render: isActive || isVisible, greyed: false, locked: other };
    }
  }
}

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

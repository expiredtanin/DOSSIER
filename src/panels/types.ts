// Panel-System — Kerntypen.
//
// Das Panel-System ist der erweiterbare Andockrahmen der App: links und rechts
// je ein Dock mit Tabs, jeder Tab ist ein registriertes Panel. Plugins/eigene
// Panels registrieren sich über die Registry (registry.ts) und tauchen dann in
// den Docks auf — der Rahmen kennt keine konkreten Panels.
//
// Bezeichner englisch, Kommentare/UI-Text deutsch (CONVENTIONS.md). Dieses Modul ist
// rein typdeklarativ plus der React-Context-Träger; es hat keine Laufzeitlogik
// außer createContext und ist daher SSR-/test-sicher.

import { createContext } from "react";
import type { ReactNode } from "react";

// ── Dock-Identität & Layout ────────────────────────────────────────────────

/** Welches der beiden Docks (links/rechts) gemeint ist. */
export type DockId = "left" | "right";

/**
 * Eine vertikal gestapelte Gruppe innerhalb eines Docks: ein eigener
 * Tab-Stapel mit eigenem aktivem Tab. Mehrere Gruppen übereinander ergeben das
 * Vectorworks-Bild (z. B. links Werkzeuge OBEN, Attribute UNTEN). Jede Gruppe
 * trägt ein Höhen-Gewicht (relativer flex-Anteil im Dock); die Splitter
 * zwischen den Gruppen verschieben diese Gewichte.
 */
export interface DockGroup {
  /** Geordnete Liste der Panel-IDs in dieser Gruppe (Tab-Reihenfolge). */
  tabs: string[];
  /** Aktiver Tab (Panel-ID) oder `null`, wenn die Gruppe leer ist. */
  activeTab: string | null;
  /**
   * Relatives Höhen-Gewicht der Gruppe im Dock (flex-grow-Anteil). Nur die
   * Verhältnisse zählen; ein Splitter-Zug verteilt Gewicht zwischen Nachbarn.
   */
  weight: number;
}

/**
 * Zustand eines einzelnen Docks: eine geordnete Liste vertikal gestapelter
 * Gruppen (oben → unten) plus die Dock-Breite. Ein leeres Dock hat `groups: []`
 * und wird nicht gerendert (die Mitte nutzt den Platz).
 */
export interface DockState {
  /** Vertikal gestapelte Gruppen (oben → unten). */
  groups: DockGroup[];
  /**
   * Breite des Docks in CSS-Pixeln. Persistiert, damit die Aufteilung über
   * Sitzungen erhalten bleibt.
   */
  size: number;
}

/**
 * Ein schwebendes (frei positioniertes) Panel: weder im linken noch im rechten
 * Dock, sondern als eigenes Fenster über der Mitte. Position/Größe sind
 * CSS-Pixel relativ zum Anwendungsbereich; `z` ist die Stapelreihenfolge
 * (höher = weiter vorne), damit zuletzt fokussierte Fenster oben liegen.
 */
export interface FloatingPanel {
  /** Panel-ID (Registry-Schlüssel) — wie in DockState.tabs eindeutig. */
  panelId: string;
  /** Linke Kante in CSS-Pixeln (relativ zum Anwendungsbereich). */
  x: number;
  /** Obere Kante in CSS-Pixeln (relativ zum Anwendungsbereich). */
  y: number;
  /** Breite in CSS-Pixeln. */
  w: number;
  /** Höhe in CSS-Pixeln. */
  h: number;
  /** Stapelindex (höher = weiter vorne). */
  z: number;
}

/**
 * Gesamter Layout-Zustand des Panel-Rahmens: beide Docks, die Liste der
 * schwebenden Panels plus eine Schema-Version (für Migrationen beim Laden aus
 * localStorage).
 *
 * INVARIANTE: Jede registrierte Panel-ID erscheint an GENAU EINER Stelle —
 * in einer Gruppe des linken Docks, in einer Gruppe des rechten Docks oder in
 * `floating` (als `panelId`). Die Helfer in layout.ts wahren diese Invariante
 * (sie entfernen ein Panel überall, bevor sie es am Ziel einfügen, und werfen
 * leer gewordene Gruppen weg).
 */
export interface LayoutState {
  left: DockState;
  right: DockState;
  /** Frei positionierte Panels (nicht in einem Dock). */
  floating: FloatingPanel[];
  /** Schema-Version des Layouts (für künftige Migrationen). */
  version: number;
}

// ── Darstellungsmodus ──────────────────────────────────────────────────────

/**
 * Darstellungsmodus für ortsabhängige Inhalte (Navigator-Listen, 3D, Grundriss).
 * Steuert, welche Elemente bezogen auf die aktive Auswahl gezeigt werden — die
 * fünf DOSSIER-Modi (siehe docs/design/context-menu.md), für Ebenen UND
 * Zeichnungsebenen identisch:
 *   • "all_force"   — alle erzwungen sichtbar; Augen gedimmt; Klick aufs Auge
 *                     wechselt zu „Ausgewählte".
 *   • "all"         — sichtbar nach per-Zeile-Flag (Standard).
 *   • "active"      — nur das aktive Element; andere stark gedimmt.
 *   • "grey"        — aktives normal, andere 45 % (Sichtbarkeits-Flags gelten).
 *   • "grey_locked" — wie „grey", andere zusätzlich gesperrt.
 */
export type DisplayMode = "all_force" | "all" | "active" | "grey" | "grey_locked";

// ── Panel-Definition & Kontext ─────────────────────────────────────────────

/**
 * Was ein Panel beim Rendern erhält. Bewusst generisch gehalten: konkrete
 * App-Daten (Projekt, Handler, aktive Auswahl) reicht der Host stattdessen über
 * den React-Context `PanelHostContext` durch — so bleiben Panels von der
 * Props-Signatur des Hosts entkoppelt und Plugins müssen diesen Typ nicht
 * kennen. Die Index-Signatur erlaubt es, bei Bedarf trotzdem ad-hoc-Werte
 * mitzugeben, ohne den Typ zu brechen.
 */
export interface PanelContext {
  [key: string]: unknown;
}

/**
 * Definition eines Panels — die Einheit, die in der Registry registriert und in
 * einem Dock als Tab dargestellt wird.
 */
export interface PanelDef {
  /** Stabile, eindeutige ID (Registry-Schlüssel, in Layouts persistiert). */
  id: string;
  /**
   * Im Tab angezeigter Titel — als i18n-Key (z. B. „nav.layers"). Der Rahmen
   * (TabStrip/PanelFrame) löst ihn über `t()` auf, sodass der Titel der
   * gewählten Sprache folgt. Ist der String kein bekannter Key, gibt `t()` ihn
   * unverändert zurück (Plugins können also auch einen fertigen Text setzen).
   */
  title: string;
  /** Rendert den Panel-Inhalt. Erhält den (generischen) PanelContext. */
  render: (ctx: PanelContext) => ReactNode;
  /**
   * Ob das Panel den Darstellungsmodus-Umschalter (DisplayMode) in seiner
   * Kopfzeile anbieten soll. Default: kein Umschalter.
   */
  hasDisplayMode?: boolean;
}

// ── Host-Context (App-Zustand + Handler für Panels) ────────────────────────

/**
 * Träger des App-Zustands und der Mutations-Handler, den die App über einen
 * Provider bereitstellt und den Panels per `useContext(PanelHostContext)`
 * abgreifen. Bewusst lose typisiert (Record), damit dieses Kernmodul nicht vom
 * konkreten Projekt-/Handler-Modell abhängt und Plugins frei darauf zugreifen
 * können. Die App liefert hier u. a. `project`, die aktive Auswahl, die
 * Ressourcen-Handler und die Darstellungsmodi hinein.
 *
 * `null` bedeutet „außerhalb eines Providers gerendert" — Consumer sollten das
 * abfangen (siehe usePanelHost in einem späteren Schritt).
 */
export type PanelHost = Record<string, unknown>;

/** React-Context, über den der Host seinen Zustand an Panels durchreicht. */
export const PanelHostContext = createContext<PanelHost | null>(null);

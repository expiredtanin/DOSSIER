// Command-Engine — Verallgemeinerung des `Tool`-Interfaces (src/tools/types.ts)
// zu einem Rhino-artigen Befehlsmodell (docs/design/rhino-command-system.md §3.1).
//
// Ein `Command` ist eine kleine State-Machine: jeder Schritt zeigt einen Prompt,
// nimmt bestimmte Eingabe-Arten an (Punkt | Zahl | Option | Auswahl) und liefert
// aus (state, input) den nächsten Zustand + ein `CommandResult` (Vorschau +
// optional commit/done). Damit speisen Maus-Picks UND getippte Koordinaten/
// Optionen DENSELBEN Schritt — es gibt nur einen Eingabepfad.
//
// Bezeichner englisch, sichtbarer Text via t() (i18n-Keys, Namespace `cmd.*`).

import type { Project, Vec2 } from "../model/types";
import type { TranslationKey } from "../i18n";
import type { DrawingLevel } from "../model/types";
import type { SnapResult, ToolDraft } from "../tools/types";

export type { DraftShape, SnapResult, ToolDraft } from "../tools/types";
export { segmentHud, angleDegOf } from "../tools/types";

// ── Eingabe-Arten ────────────────────────────────────────────────────────────

/** Arten von Eingaben, die ein Schritt annehmen kann. */
export type AcceptKind = "point" | "number" | "option" | "selection";

/**
 * Geparste, noch nicht aufgelöste Roh-Eingabe aus der Command-Line bzw. der
 * Maus. Discriminated Union (§2.7). Die Engine löst `point`-bezogene Varianten
 * mit `lastPoint` + Cursor-Richtung zu einem konkreten Modellpunkt auf, bevor
 * sie den Schritt aufruft.
 */
export type CmdInput =
  | { kind: "point"; point: Vec2; snap?: SnapResult | null }
  | { kind: "number"; value: number }
  | { kind: "option"; id: string }
  | { kind: "text"; text: string }
  | { kind: "selection"; wallIds: string[]; drawingIds: string[] };

// ── Optionen (klickbare Inline-Klammern, §2.4) ───────────────────────────────

/**
 * Eine Inline-Option eines Schritts. `value` (gesetzt) → wird als „Name=Value"
 * angezeigt und ist togglebar/abfragbar; ohne `value` ist es eine Action-Option
 * (verzweigt sofort). `id` ist der englische Schlüssel (auch zum Tippen, Präfix).
 */
export interface CmdOption {
  id: string;
  /** Sichtbares Label (i18n). */
  labelKey: TranslationKey;
  /** Aktueller Wert (Toggle/Value-Option); fehlt → Action-Option. */
  value?: string;
}

// ── Kontext + Ergebnis ───────────────────────────────────────────────────────

/**
 * Die aktuelle Auswahl (Rhino: erst selektieren, dann Befehl). Editierbefehle
 * (Move/Copy/Offset) lesen sie hieraus, statt sie selbst zu picken. `wallIds`
 * sind die gewählten Wände, `drawingId` ist das gewählte 2D-Element (sich
 * gegenseitig ausschließend, wie in selectionSlice).
 */
export interface CommandSelection {
  wallIds: string[];
  drawingId: string | null;
  /**
   * ALLE gewählten 2D-Elemente (Mehrfachauswahl). `drawingId` bleibt das einzeln
   * selektierte Element (Move/Copy/Mirror operieren darauf); Mengen-Aktionen wie
   * Join/Split lesen `drawingIds`. Optional/abwärtskompatibel: fehlt es, gilt
   * `drawingId` (falls gesetzt) als einziges Element.
   */
  drawingIds?: string[];
}

/** Live-Kontext, den ein Befehl bei jedem Schritt erhält (analog ToolContext). */
export interface CommandContext {
  project: Project;
  /** Aktive Zeichnungsebene (Ziel neuer Elemente). */
  level: DrawingLevel;
  /** Default-Kategorie-Code für neue Elemente. */
  defaultCategoryCode: string;
  /** Aktiver Linienstil-Code für 2D-Primitive. */
  activeLineStyleId: string;
  /**
   * Aktiver Wandtyp (für den `wall`-Befehl). Liefert Schichtaufbau + Dicke neuer
   * Wände. Aus dem Store gefüllt (analog ToolContext.activeWallTypeId).
   */
  activeWallTypeId: string;
  /**
   * Letzter gesetzter Punkt im laufenden Befehl (für `r`/polar-Auflösung); null
   * am ersten Punkt.
   */
  lastPoint: Vec2 | null;
  /**
   * Vorab gesetzte Auswahl (Wände + ein 2D-Element). Editierbefehle operieren
   * darauf (Rhino: erst selektieren, dann Befehl). Beim Befehlsstart aus dem
   * Store gefüllt.
   */
  selection: CommandSelection;
}

/** Was ein Befehls-Schritt nach außen meldet (analog ToolResult + commit/done). */
export interface CommandResult {
  /** Neuer Vorschau-Zustand; null = nichts zu zeigen. */
  draft: ToolDraft | null;
  /** Bei Abschluss: immutable Mutation, die die Engine über setProject anwendet. */
  commit?: (p: Project) => Project;
  /** true → Befehl ist fertig und kehrt in den Ruhezustand zurück. */
  done?: boolean;
}

// ── Befehls-Zustand ──────────────────────────────────────────────────────────

/**
 * Interner Zustand eines laufenden Befehls. Basis-Form (`phase` + `lastPoint`);
 * jeder Befehl verfeinert sie zu seiner eigenen Discriminated Union und castet
 * beim Eintritt. `lastPoint` lebt im Zustand, damit der Parser `r`/polar relativ
 * dazu auflösen kann.
 */
export interface CommandState {
  phase: string;
  /** Letzter gesetzter Punkt (für relative/polare Eingabe), null am Anfang. */
  lastPoint: Vec2 | null;
}

// ── Tab-Feld-Zyklus (Präzisionseingabe §2.7, erweitert) ──────────────────────

/**
 * Ein geordnetes Zahlenfeld eines Schritts (z. B. Länge, Winkel, Breite, Höhe,
 * Radius). Mit Tab zyklt der Nutzer durch die Felder; eine getippte Zahl LOCKT
 * das aktive Feld, ungelockte Felder folgen weiter der Maus.
 */
export interface CommandField {
  /** Englischer Schlüssel (Identität des Feldes, z. B. „length"). */
  id: string;
  /** Sichtbares Label (i18n, Namespace `cmd.field.*`). */
  labelKey: TranslationKey;
}

// ── Befehls-Schnittstelle ────────────────────────────────────────────────────

/** Die Command-Schnittstelle (reine Funktionen über einen internen State). */
export interface Command {
  /** Befehlsname (englisch, in der Command-Line getippt), z. B. „line". */
  name: string;
  /** UI-Label-Key (i18n). */
  labelKey: TranslationKey;
  /** Prompt-Text-Key des aktuellen Schritts. */
  prompt(state: CommandState): TranslationKey;
  /** Eingabe-Arten, die der aktuelle Schritt annimmt. */
  accepts(state: CommandState): AcceptKind[];
  /** Inline-Optionen des aktuellen Schritts (klickbar/tippbar). */
  options(state: CommandState): CmdOption[];
  /** Nur auf Geschossen aktiv? (analog floorOnly bei Tools.) */
  floorOnly?: boolean;
  /** Initialer Schritt-Zustand. */
  init(): CommandState;
  /** Eine Eingabe (Punkt/Zahl/Option/Auswahl) verarbeiten. */
  onInput(
    state: CommandState,
    input: CmdInput,
    ctx: CommandContext,
  ): [CommandState, CommandResult];
  /** Hover/Bewegung (roher bzw. gesnappter Cursor): nur Vorschau. */
  onMove(
    state: CommandState,
    point: Vec2,
    snap: SnapResult | null,
    ctx: CommandContext,
  ): [CommandState, CommandResult];
  /** Enter/Space/Rechtsklick: Schritt bestätigen / mehrteilig beenden. */
  onConfirm(state: CommandState, ctx: CommandContext): [CommandState, CommandResult];
  /** Esc: Entwurf verwerfen, Befehl beenden. */
  onCancel(state: CommandState): [CommandState, CommandResult];

  /**
   * Sofort-Befehl (optional): läuft direkt beim Start OHNE Punkt-Picken und liefert
   * sein Ergebnis (i. d. R. commit + done). Für Aktionen auf der bestehenden
   * Auswahl (z. B. Join/Split), die keine interaktive Geste brauchen. Ist diese
   * Methode gesetzt, ruft die Engine sie unmittelbar nach `init()` auf und der
   * Befehl kehrt (bei done) sofort in den Ruhezustand zurück. So ist „Ctrl+J" und
   * getipptes „join" derselbe Pfad. Fehlt sie, verhält sich der Befehl wie gehabt
   * (interaktiv, Punkt-getrieben).
   */
  autoRun?(ctx: CommandContext): CommandResult;

  // ── Optionaler Tab-Feld-Zyklus (additiv; Befehle ohne diese Methoden
  //    verhalten sich exakt wie bisher) ──────────────────────────────────────

  /**
   * Geordnete Zahlenfelder des AKTUELLEN Schritts (leer/undefined = kein
   * Feld-Modus). Beispiel Linie-Endschritt: [length, angle].
   */
  fields?(state: CommandState): CommandField[];

  /**
   * Berechnet den resultierenden Modellpunkt aus den gelockten Feldern + dem
   * Cursor. Ungelockte Felder folgen dem Cursor (Maus); gelockte Felder
   * überschreiben. Liefert null, wenn (noch) kein Punkt bestimmbar ist.
   */
  pointFromFields?(
    state: CommandState,
    locks: Record<string, number>,
    cursor: Vec2 | null,
  ): Vec2 | null;

  /**
   * LIVE-Zahlenwerte je Feld für die aktuelle Cursor-Position (Maus-Vorschau in
   * der Befehlszeile). Gelockte Felder behalten ihren Lock; ungelockte Felder
   * folgen der Maus — dieser Wert zeigt, was das Feld GERADE annimmt. Liefert die
   * Werte je Feld-ID; fehlt ein Feld (oder kein Cursor), zeigt die UI „—".
   * Additiv: Befehle ohne diese Methode zeigen ungelockte Felder als „—".
   */
  fieldValues?(
    state: CommandState,
    locks: Record<string, number>,
    cursor: Vec2 | null,
  ): Record<string, number>;
}

/** Convenience-Re-Export für Befehls-Module. */
export type { Project, Vec2 } from "../model/types";

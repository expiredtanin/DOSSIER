// [99] EIN Tasten-Verteiler für Esc/Enter eines laufenden Befehls — egal, wo der Fokus steht
// (Zeichenfläche, Schnitt/Ansicht, Layout-Blatt, 3D, nach Klick in ein Panel oder auf einen
// Werkzeug-Knopf). Vorher bekam die Engine Esc/Enter NUR über das fokussierte Befehlsfeld; nach
// einem Klick daneben gingen die Tasten verloren bzw. Enter löste den fokussierten Knopf aus.
//
// Fokus-Regeln:
//  • Befehlsfeld fokussiert → es behandelt Esc/Enter selbst (getippter Wert, Leer-Enter
//    wiederholt den letzten Befehl) und ruft dieselben Engine-Aktionen; hier nichts tun.
//  • anderes Eingabefeld (Panel-Zahl, Texteditor) oder offener Dialog → das Feld gehört der Taste.
//  • sonst (Körper, Zeichenfläche, Knopf, Panel-Fläche) → Esc = `engine.escape()`, Enter =
//    `engine.confirm()`; Standardaktion (Knopf-Klick) unterdrückt.
//  • gehaltene Taste (Wiederholung) zählt nicht — sonst wäre gehaltenes Esc ein Esc-Esc-Abbruch.
// Registriert auf `document` (Bubble): läuft NACH den React-Handlern (Befehlsfeld, Dialoge)
// und VOR den `window`-Handlern (Griff-Abbruch, Auswahl aufheben), die `defaultPrevented` achten.

import { useEffect } from "react";
import type { RefObject } from "react";
import type { CommandEngine } from "../commands/engine";

/** Gehört die Taste einem Eingabefeld oder Dialog (nicht dem Befehl)? */
export function keyBelongsToField(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  if (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) return true;
  return !!el.closest('[role="dialog"],[aria-modal="true"]');
}

/** Was tut der Verteiler mit dieser Taste? null = nicht zuständig. */
export function commandKeyAction(
  e: Pick<KeyboardEvent, "key" | "repeat" | "ctrlKey" | "metaKey" | "altKey" | "defaultPrevented" | "target">,
  commandActive: boolean,
): "escape" | "confirm" | "swallow" | null {
  if (!commandActive || e.defaultPrevented) return null;
  if (e.key !== "Escape" && e.key !== "Enter") return null;
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (keyBelongsToField(e.target)) return null;
  if (e.repeat) return "swallow";
  return e.key === "Escape" ? "escape" : "confirm";
}

/**
 * Weiterer Befehl ausserhalb der Engine (Auswahl-Transformation Bewegen/Drehen/Spiegeln …):
 * gleiche Esc-/Enter-Regeln.
 */
export interface CommandKeyTarget {
  active(): boolean;
  escape(): void;
  confirm(): void;
}

/** Hängt den Verteiler einmal an (liest Engine und Transformation über Refs). */
export function useCommandKeys(
  engineRef: RefObject<CommandEngine | null>,
  otherRef?: RefObject<CommandKeyTarget | null>,
): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const eng = engineRef.current;
      const other = otherRef?.current;
      const engActive = !!eng?.isActive();
      const action = commandKeyAction(e, engActive || !!other?.active());
      if (!action) return;
      if (engActive && eng) {
        e.preventDefault();
        if (action === "escape") eng.escape();
        else if (action === "confirm") eng.confirm();
      } else if (other) {
        e.preventDefault();
        if (action === "escape") other.escape();
        else if (action === "confirm") other.confirm();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [engineRef, otherRef]);
}

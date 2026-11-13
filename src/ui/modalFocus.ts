// [249] Gemeinsame Tastatur-/Fokus-Hülle der Overlay-Dialoge (Kürzel-Übersicht, Kamerafahrt, 3D-Bild, Rendering):
// Fokus beim Öffnen ins erste sinnvolle Feld, Tab bleibt im Dialog (Fokus-Falle, auch wenn der Fokus auf dem
// Dokument gelandet ist), Esc schliesst, Enter in einem Eingabefeld löst die Hauptaktion aus, nach dem Schliessen
// kehrt der Fokus zum Auslöser zurück. Verwendung: `<div className="imp-dialog" role="dialog" aria-modal="true"
// ref={useModalFocus({ onEscape, onEnter })}>`. Die Hintergrund-Kürzel sperrt `state/modalScope.ts` über `aria-modal`.

import { useCallback, useRef } from "react";

export const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Tab-Falle: Welches Element soll den Fokus bekommen? `index` = Position des fokussierten Elements in der Tab-Liste
 * (-1 = ausserhalb). `null` = der Browser darf selbst weiterspringen (Fokus bleibt innen); -1 bei leerer Liste.
 */
export function trapTarget(count: number, index: number, shift: boolean): number | null {
  if (count <= 0) return -1;
  if (index < 0) return shift ? count - 1 : 0;
  if (!shift && index === count - 1) return 0;
  if (shift && index === 0) return count - 1;
  return null;
}

/** Sichtbare, fokussierbare Elemente in Dokumentreihenfolge. */
export function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden",
  );
}

/** Erstes sinnvolles Feld: `[data-autofocus]`, sonst das erste fokussierbare Element ausser dem Schliessen-Kreuz. */
export function initialFocusTarget(root: HTMLElement): HTMLElement {
  const marked = root.querySelector<HTMLElement>("[data-autofocus]:not([disabled])");
  if (marked) return marked;
  const list = focusableIn(root);
  return list.find((el) => !el.classList.contains("imp-close")) ?? list[0] ?? root;
}

/** Enter in diesen Feldern löst die Hauptaktion aus (Knöpfe, Auswahlfelder und mehrzeilige Texte behalten Enter). */
export function enterTriggersPrimary(el: Element | null): boolean {
  if (!el || el.tagName !== "INPUT") return false;
  const type = (el as HTMLInputElement).type;
  return type === "text" || type === "number" || type === "search" || type === "email" || type === "url";
}

export interface ModalFocusOptions {
  /** Esc schliesst; läuft gerade eine Aktion, die Esc nicht verlassen soll, `undefined` lassen. */
  onEscape?: () => void;
  /** Hauptaktion bei Enter in einem Eingabefeld. */
  onEnter?: () => void;
}

/** Callback-Ref für das Dialog-Element (`role="dialog"`). Stabil über Renders; aktuelle Optionen werden mitgeführt. */
export function useModalFocus(opts: ModalFocusOptions): (node: HTMLElement | null) => void {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const cleanup = useRef<(() => void) | null>(null);
  return useCallback((node: HTMLElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    if (!node) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!node.hasAttribute("tabindex")) node.tabIndex = -1;
    if (!node.contains(document.activeElement)) initialFocusTarget(node).focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const list = focusableIn(node);
        const active = document.activeElement as HTMLElement | null;
        const to = trapTarget(list.length, active ? list.indexOf(active) : -1, e.shiftKey);
        if (to === null) return;
        e.preventDefault();
        (list[to] ?? node).focus();
      } else if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const fn = optsRef.current.onEscape;
        if (!fn) return;
        e.preventDefault();
        fn();
      } else if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && !e.repeat) {
        const fn = optsRef.current.onEnter;
        if (fn && node.contains(e.target as Node) && enterTriggersPrimary(e.target as Element)) {
          e.preventDefault();
          fn();
        }
      }
    };
    // Wandert der Fokus von aussen in die Seite zurück (z. B. holt sich die Befehlszeile nach dem Befehl, der den
    // Dialog öffnete, per Zeitgeber den Fokus), kommt er in den Dialog zurück. Ein anderer modaler Dialog darüber ist ausgenommen.
    let lastInside: HTMLElement | null = null;
    const onFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (node.contains(target)) {
        lastInside = target;
      } else if (!target.closest?.('[aria-modal="true"]')) {
        (lastInside?.isConnected ? lastInside : initialFocusTarget(node)).focus({ preventScroll: true });
      }
    };
    document.addEventListener("focusin", onFocusIn);
    window.addEventListener("keydown", onKey, true);
    cleanup.current = () => {
      document.removeEventListener("focusin", onFocusIn);
      window.removeEventListener("keydown", onKey, true);
      // Fokus zum Auslöser zurück (nur wenn er noch da ist und der Fokus nicht schon woanders in der Seite liegt).
      const a = document.activeElement;
      if (previous && previous.isConnected && (!a || a === document.body || node.contains(a) || !a.isConnected)) {
        previous.focus({ preventScroll: true });
      }
    };
  }, []);
}

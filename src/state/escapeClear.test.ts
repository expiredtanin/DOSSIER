import { describe, expect, it } from "vitest";
import { clearSelectionAfterEscape } from "./useKeyboardShortcuts";
import { EMPTY_SELECTION, fromIds, mergeSelection } from "./selection";

// [204] Esc hebt die Auswahl erst nach dem Ereignis auf; ein Klick unmittelbar nach Esc (E2E: Playwright
// sendet die Ereignisse ohne Pause) darf von diesem späten Esc nicht wieder gelöscht werden.
describe("clearSelectionAfterEscape", () => {
  const line1 = mergeSelection(EMPTY_SELECTION, fromIds("drawings", ["a"]));

  it("hebt die Auswahl auf, wenn sie seit Esc unverändert ist", () => {
    const calls: unknown[] = [];
    expect(clearSelectionAfterEscape(line1, line1, (p) => calls.push(p))).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("lässt eine seit Esc neu gewählte Auswahl stehen", () => {
    const line2 = mergeSelection(EMPTY_SELECTION, fromIds("drawings", ["b"]));
    const calls: unknown[] = [];
    expect(clearSelectionAfterEscape(line1, line2, (p) => calls.push(p))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("tut bei leerer Auswahl nichts", () => {
    const calls: unknown[] = [];
    expect(clearSelectionAfterEscape(EMPTY_SELECTION, EMPTY_SELECTION, (p) => calls.push(p))).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

/**
 * Notify-Slice (`src/state/notifySlice.ts`) — nicht-blockierende
 * Kurzmeldungen (Ersatz für `window.alert`, das im Tauri-WKWebView deaktiviert
 * ist). Getestet wird nur der reine State (Hinzufügen/Entfernen); der
 * Auto-Dismiss-Timer lebt bewusst in der Toast-Komponente (src/ui/Toast.tsx),
 * nicht in der Slice, und ist hier daher kein Thema.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getState, setState } from "./appStore";

beforeEach(() => {
  setState({ notifications: [] });
});

describe("notifySlice", () => {
  it("notify fügt eine Meldung hinzu (Default-Art: info)", () => {
    getState().notify("Hallo");

    const notes = getState().notifications;
    expect(notes.length).toBe(1);
    expect(notes[0].message).toBe("Hallo");
    expect(notes[0].kind).toBe("info");
    expect(notes[0].id).toBeTruthy();
  });

  it("notify übernimmt die übergebene Art", () => {
    getState().notify("Achtung", "warning");
    expect(getState().notifications[0].kind).toBe("warning");
  });

  it("mehrere notify()-Aufrufe erzeugen unterschiedliche ids, in Reihenfolge angehängt", () => {
    getState().notify("A");
    getState().notify("B");

    const notes = getState().notifications;
    expect(notes.map((n) => n.message)).toEqual(["A", "B"]);
    expect(new Set(notes.map((n) => n.id)).size).toBe(2);
  });

  it("dismissNotify entfernt genau die Meldung mit der gegebenen id", () => {
    getState().notify("A");
    getState().notify("B");
    const [first, second] = getState().notifications;

    getState().dismissNotify(first.id);

    const remaining = getState().notifications;
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(second.id);
  });

  it("dismissNotify bei unbekannter id ist ein No-Op", () => {
    getState().notify("A");
    const before = getState().notifications;

    getState().dismissNotify("unbekannte-id");

    expect(getState().notifications).toEqual(before);
  });
});

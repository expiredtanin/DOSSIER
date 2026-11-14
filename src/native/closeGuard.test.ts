// Schliess-Wächter ([116]): Fenster schliessen / Cmd+Q mit ungespeicherten Änderungen fragt über den
// Overlay-Dialog nach (kein window.confirm) und lässt das Fenster erst nach Bestätigung zugehen.

import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

const load = () => import("./projectFile");

describe("handleCloseRequested", () => {
  it("sauberes Projekt: durchlassen, kein Dialog", async () => {
    const m = await load();
    const prevent = vi.fn();
    const ask = vi.fn();
    const close = vi.fn();
    const blocked = m.handleCloseRequested({ preventDefault: prevent }, { getPath: () => null, isDirty: () => false, requestClose: ask }, close);
    expect(blocked).toBe(false);
    expect(prevent).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled(); // das System schliesst selbst
  });

  it("ungespeichert: Schliessen verhindert, Dialog gefragt, geschlossen erst nach Bestätigung", async () => {
    const m = await load();
    const prevent = vi.fn();
    let proceed: (() => void) | null = null;
    const close = vi.fn();
    const blocked = m.handleCloseRequested(
      { preventDefault: prevent },
      { getPath: () => null, isDirty: () => true, requestClose: (p) => (proceed = p) },
      close,
    );
    expect(blocked).toBe(true);
    expect(prevent).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    proceed!();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("Abbrechen im Dialog: proceed wird nie gerufen, Fenster bleibt", async () => {
    const m = await load();
    const close = vi.fn();
    m.handleCloseRequested({ preventDefault: () => {} }, { getPath: () => "/a.obp", isDirty: () => true, requestClose: () => {} }, close);
    expect(close).not.toHaveBeenCalled();
  });
});

describe("registerCloseGuard", () => {
  it("Tauri: onCloseRequested hält das Schliessen an und zerstört das Fenster erst nach Bestätigung", async () => {
    vi.resetModules();
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    let handler: ((e: { preventDefault: () => void }) => void) | null = null;
    const destroy = vi.fn();
    vi.doMock("@tauri-apps/api/window", () => ({
      getCurrentWindow: () => ({
        onCloseRequested: async (cb: typeof handler) => {
          handler = cb;
          return () => {};
        },
        destroy,
      }),
    }));
    const m = await load();
    let dirty = true;
    let proceed: (() => void) | null = null;
    m.registerCloseGuard({ getPath: () => null, isDirty: () => dirty, requestClose: (p) => (proceed = p) });
    await vi.waitFor(() => expect(handler).not.toBeNull());
    const prevent = vi.fn();
    handler!({ preventDefault: prevent });
    expect(prevent).toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    proceed!();
    expect(destroy).toHaveBeenCalledTimes(1);
    // sauber: kein Eingriff
    dirty = false;
    const prevent2 = vi.fn();
    handler!({ preventDefault: prevent2 });
    expect(prevent2).not.toHaveBeenCalled();
  });

  it("Browser: beforeunload fragt nur bei ungespeicherten Änderungen", async () => {
    const listeners = new Map<string, (e: unknown) => void>();
    vi.stubGlobal("window", {
      addEventListener: (n: string, f: (e: unknown) => void) => listeners.set(n, f),
      removeEventListener: (n: string) => listeners.delete(n),
    });
    const m = await load();
    let dirty = false;
    const off = m.registerCloseGuard({ getPath: () => null, isDirty: () => dirty, requestClose: () => {} });
    const ev = () => ({ preventDefault: vi.fn(), returnValue: undefined as unknown });
    const clean = ev();
    listeners.get("beforeunload")!(clean);
    expect(clean.preventDefault).not.toHaveBeenCalled();
    dirty = true;
    const dirtyEv = ev();
    listeners.get("beforeunload")!(dirtyEv);
    expect(dirtyEv.preventDefault).toHaveBeenCalled();
    expect(dirtyEv.returnValue).toBe("");
    off();
    expect(listeners.has("beforeunload")).toBe(false);
  });

  it("Electron: Hauptprozess-Brücke; Rückfrage statt Schliessen, forceClose nach Bestätigung, sauber: sofort", async () => {
    let onReq: (() => void) | null = null;
    const api = {
      setCloseGuard: vi.fn(),
      onCloseRequested: (cb: () => void) => {
        onReq = cb;
        return () => {};
      },
      forceClose: vi.fn(),
    };
    vi.stubGlobal("window", { dossierWindow: api, addEventListener: vi.fn() });
    const m = await load();
    let dirty = true;
    let proceed: (() => void) | null = null;
    m.registerCloseGuard({ getPath: () => null, isDirty: () => dirty, requestClose: (p) => (proceed = p) });
    expect(api.setCloseGuard).toHaveBeenCalledWith(true);
    onReq!();
    expect(api.forceClose).not.toHaveBeenCalled();
    proceed!();
    expect(api.forceClose).toHaveBeenCalledTimes(1);
    dirty = false;
    onReq!();
    expect(api.forceClose).toHaveBeenCalledTimes(2);
  });
});

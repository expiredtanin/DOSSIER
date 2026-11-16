// [262] Update-Prüfung beim Start: Vorgabe AUS (Datenschutz zuerst), nur mit Einstellung, nie offline.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetOfflineForTests, setOffline } from "../net/net";

const check = vi.fn(async () => null);
vi.mock("../native/projectFile", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), message: vi.fn(async () => undefined) }));

const store = new Map<string, string>();

beforeEach(async () => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  (await import("./checkForUpdate")).resetStartupCheckForTests();
});
afterEach(() => {
  resetOfflineForTests();
  check.mockClear();
  vi.unstubAllGlobals();
});

describe("[262] Update-Prüfung beim Start", () => {
  it("Vorgabe aus: kein Aufruf beim Start", async () => {
    const m = await import("./checkForUpdate");
    expect(m.getUpdateCheckOnStart()).toBe(false);
    await m.checkForUpdateOnStart();
    expect(check).not.toHaveBeenCalled();
  });

  it("eingeschaltet: ein Aufruf beim Start, nicht mehr bei erneutem Start der App (Sprachwechsel)", async () => {
    const m = await import("./checkForUpdate");
    m.setUpdateCheckOnStart(true);
    expect(m.getUpdateCheckOnStart()).toBe(true);
    await m.checkForUpdateOnStart();
    await m.checkForUpdateOnStart();
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("wieder ausgeschaltet: kein Aufruf", async () => {
    const m = await import("./checkForUpdate");
    m.setUpdateCheckOnStart(true);
    m.setUpdateCheckOnStart(false);
    await m.checkForUpdateOnStart();
    expect(check).not.toHaveBeenCalled();
  });

  it("offline: nie, auch wenn eingeschaltet", async () => {
    const m = await import("./checkForUpdate");
    m.setUpdateCheckOnStart(true);
    setOffline(true);
    await m.checkForUpdateOnStart();
    expect(check).not.toHaveBeenCalled();
  });

  it("der Knopf „Nach Updates suchen“ fragt immer (online), unabhängig von der Einstellung", async () => {
    const m = await import("./checkForUpdate");
    await m.checkForUpdate(false);
    expect(check).toHaveBeenCalledTimes(1);
  });
});

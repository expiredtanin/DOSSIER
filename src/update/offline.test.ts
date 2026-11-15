// [262] Update-Check und Versionsverlauf gehen am Tauri-Plugin vorbei an `netFetch` und prüfen den Offline-Modus selbst.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OVERPASS } from "../io/osm";
import { netFetch, resetOfflineForTests, setOffline } from "../net/net";

const check = vi.fn(async () => null);
const tauriFetch = vi.fn(async () => new Response("[]"));
vi.mock("../native/projectFile", () => ({ isTauriRuntime: () => true }));
vi.mock("@tauri-apps/plugin-updater", () => ({ check }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: tauriFetch }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: vi.fn(), message: vi.fn(async () => undefined) }));

afterEach(() => {
  resetOfflineForTests();
  check.mockClear();
  tauriFetch.mockClear();
  vi.unstubAllGlobals();
});

describe("[262] Offline-Modus", () => {
  it("stiller Start-Check fragt offline nicht nach Updates, online schon", async () => {
    vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {}, removeItem: () => {} });
    const { checkForUpdate } = await import("./checkForUpdate");
    setOffline(true);
    await checkForUpdate(true);
    await checkForUpdate(false);
    expect(check).not.toHaveBeenCalled();
    setOffline(false);
    await checkForUpdate(true);
    expect(check).toHaveBeenCalledTimes(1);
  });

  it("Versionsverlauf ruft offline nichts ab", async () => {
    const { fetchVersionHistory } = await import("./versionHistory");
    setOffline(true);
    expect(await fetchVersionHistory()).toEqual([]);
    expect(tauriFetch).not.toHaveBeenCalled();
    setOffline(false);
    await fetchVersionHistory();
    expect(tauriFetch).toHaveBeenCalledTimes(1);
  });
});

describe("[262] Overpass-Adresse", () => {
  it("steht auf der Host-Liste (sonst scheitert der OSM-Import ohne Proxy)", async () => {
    const f = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", f);
    setOffline(false);
    await netFetch(OVERPASS, { method: "POST" });
    expect(f).toHaveBeenCalledTimes(1);
  });
});

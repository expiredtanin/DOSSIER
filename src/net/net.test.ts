import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { HostNotAllowedError, OfflineError, allowHost, isLocalUrl, netFetch, resetOfflineForTests, setOffline } from "./net";

afterEach(() => {
  resetOfflineForTests();
  vi.unstubAllGlobals();
});

describe("netFetch", () => {
  it("lokale Quellen laufen immer durch, auch offline", async () => {
    const f = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", f);
    setOffline(true);
    await netFetch("data:text/plain,hi");
    await netFetch("blob:abc");
    await netFetch("/assets/x.png");
    expect(f).toHaveBeenCalledTimes(3);
    expect(isLocalUrl("https://api.ambientcg.com/x")).toBe(false);
  });

  it("offline blockiert entfernte URLs", async () => {
    const f = vi.fn();
    vi.stubGlobal("fetch", f);
    setOffline(true);
    await expect(netFetch("https://api3.geo.admin.ch/rest")).rejects.toBeInstanceOf(OfflineError);
    expect(f).not.toHaveBeenCalled();
  });

  it("online: bekannte Hosts ja, fremde Hosts nein, konfigurierter Proxy nach allowHost ja", async () => {
    const f = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", f);
    setOffline(false);
    await netFetch("https://api.ambientcg.com/v2/full_json");
    await netFetch("https://data.geo.admin.ch/x");
    await expect(netFetch("https://evil.example.com/steal")).rejects.toBeInstanceOf(HostNotAllowedError);
    await expect(netFetch("https://notgeo.admin.ch.evil.com/")).rejects.toBeInstanceOf(HostNotAllowedError);
    allowHost("https://proxy.meinbuero.ch/geo");
    await netFetch("https://proxy.meinbuero.ch/geo?u=x");
    expect(f).toHaveBeenCalledTimes(3);
  });
});

describe("kein fetch ausserhalb von src/net", () => {
  it("nur net/net.ts ruft fetch( direkt auf", () => {
    const SRC = join(process.cwd(), "src");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) {
          if (/^pkg/.test(n)) continue; // erzeugte WASM-Glue
          walk(p);
        } else if (/\.tsx?$/.test(n) && !/\.test\.tsx?$/.test(n)) {
          const rel = relative(SRC, p).split(sep).join("/");
          if (rel === "net/net.ts") continue;
          const src = readFileSync(p, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
          if (/(^|[^\w.])fetch\s*\(/.test(src)) hits.push(rel);
        }
      }
    };
    walk(SRC);
    expect(hits).toEqual([]);
  });
});

// [30] Release-Skript für Gitea: reine Teile (Tag, Rollen der Pakete, Prüfsummen, Manifeste).
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const lib = createRequire(import.meta.url)("../../scripts/release-gitea-lib.cjs");

describe("release-gitea-lib", () => {
  it("Tag und Vorabversion aus semver", () => {
    expect(lib.tagFor("1.0.0-beta.1")).toBe("v1.0.0-beta.1");
    expect(lib.tagFor("1.0.0")).toBe("v1.0.0");
    expect(lib.isPrerelease("1.0.0-beta.1")).toBe(true);
    expect(lib.isPrerelease("1.0.0")).toBe(false);
    expect(() => lib.tagFor("26.11.15.1")).toThrow();
  });

  it("Download-Adressen zeigen auf karim/dossier", () => {
    expect(lib.assetUrl("v1.0.0", "Dossier-1.0.0-x86_64.AppImage")).toBe(
      "https://git.openbureau.ch/karim/dossier/releases/download/v1.0.0/Dossier-1.0.0-x86_64.AppImage",
    );
  });

  it("erkennt die Pakete", () => {
    const a = lib.classifyAssets([
      "Dossier-1.0.0-beta.1-x86_64.AppImage", "dossier_1.0.0-beta.1_aarch64.dmg", "dossier.app.tar.gz",
      "dossier.app.tar.gz.sig", "builder-debug.yml", "latest-linux.yml",
    ]);
    expect(a.appImage).toBe("Dossier-1.0.0-beta.1-x86_64.AppImage");
    expect(a.dmg).toBe("dossier_1.0.0-beta.1_aarch64.dmg");
    expect(a.updater).toBe("dossier.app.tar.gz");
    expect(a.updaterSig).toBe("dossier.app.tar.gz.sig");
    expect(a.all).not.toContain("builder-debug.yml");
    expect(a.all).toHaveLength(4);
  });

  it("SHA256SUMS sortiert im sha256sum-Format", () => {
    expect(lib.sha256sums({ b: "22", a: "11" })).toBe("11  a\n22  b\n");
  });

  it("latest.json nur mit Mac-Updater samt Signatur", () => {
    expect(lib.latestManifest({ version: "1.0.0", notes: "", pubDate: "x", tag: "v1.0.0", updater: null, signature: null })).toBeNull();
    const m = lib.latestManifest({ version: "1.0.0", notes: "n", pubDate: "2026-11-16T00:00:00Z", tag: "v1.0.0", updater: "dossier.app.tar.gz", signature: "SIG\n" });
    expect(m.platforms["darwin-aarch64"]).toEqual({
      signature: "SIG", url: "https://git.openbureau.ch/karim/dossier/releases/download/v1.0.0/dossier.app.tar.gz",
    });
  });

  it("versions.json: neu vorne, gleiche Version ersetzt, ohne DMG kein Eintrag", () => {
    const old = [{ version: "0.1.0", tag: "v0.1.0", dmg: "a.dmg" }];
    const e = { version: "1.0.0", tag: "v1.0.0", pub_date: "x", notes: "", dmg: "b.dmg" };
    expect(lib.mergeVersions(old, e).map((v: { version: string }) => v.version)).toEqual(["1.0.0", "0.1.0"]);
    expect(lib.mergeVersions([e, ...old], { ...e, notes: "neu" })[0].notes).toBe("neu");
    expect(lib.mergeVersions(old, { ...e, dmg: null })).toEqual(old);
  });

  // [268] Vorhandene Anhänge lesen: nur „gibt es nicht“ (404) gilt als leer. Bisher ergab jeder Fehler (Netz, 5xx, Proxy)
  // eine leere Liste — `--publish` überschrieb dann versions.json mit nur der neuen Version (Verlauf weg), und ein
  // nicht lesbares SHA256SUMS.txt der anderen Plattform fiel stillschweigend aus den Prüfsummen.
  it("fetchExisting: Text, null bei 404, sonst Fehler", async () => {
    const res = (status: number, body = "") => async () => new Response(body, { status });
    expect(await lib.fetchExisting(res(200, "[1]"), "u")).toBe("[1]");
    expect(await lib.fetchExisting(res(404), "u")).toBeNull();
    await expect(lib.fetchExisting(res(502, "bad gateway"), "u")).rejects.toThrow(/502/);
    await expect(lib.fetchExisting(async () => { throw new TypeError("fetch failed"); }, "u")).rejects.toThrow(/fetch failed/);
  });

  it("parseSums liest sha256sum-Zeilen, ignoriert Fremdes", () => {
    const h = "a".repeat(64);
    expect(lib.parseSums(`${h}  x.AppImage\n\nkaputt\n${"b".repeat(64)}  y.dmg\n`)).toEqual({ "x.AppImage": h, "y.dmg": "b".repeat(64) });
  });

  // [268] Ersetzen eines Anhangs: erst hochladen (temporärer Name), dann löschen und umbenennen — nie ohne `latest.json`.
  it("tempAssetName: anderer Name als das Original, Stempel enthalten", () => {
    expect(lib.tempAssetName("latest.json", 7)).toBe("latest.json.upload-7");
  });

  it("preflight: ohne --publish nicht auf ein veröffentlichtes Release", () => {
    const base = { localFiles: ["a.AppImage"], publish: false, replacePublished: false, linuxOnly: false };
    expect(lib.preflight({ ...base, release: { tag_name: "v1", draft: false, assets: [] } })).toMatch(/--replace-published/);
    expect(lib.preflight({ ...base, release: { tag_name: "v1", draft: false, assets: [] }, replacePublished: true })).toBeNull();
    expect(lib.preflight({ ...base, release: { tag_name: "v1", draft: true, assets: [] } })).toBeNull();
    expect(lib.preflight({ ...base, release: null })).toBeNull();
  });

  it("preflight: --publish nur mit Mac-Paketen (lokal oder am Release), sonst --linux-only", () => {
    const base = { publish: true, replacePublished: false, linuxOnly: false };
    const draft = (names: string[]) => ({ draft: true, assets: names.map((name) => ({ name })) });
    expect(lib.preflight({ ...base, localFiles: ["a.AppImage"], release: draft([]) })).toMatch(/--linux-only/);
    expect(lib.preflight({ ...base, localFiles: ["a.AppImage"], release: null })).toMatch(/--linux-only/);
    expect(lib.preflight({ ...base, localFiles: ["a.AppImage"], release: draft([]), linuxOnly: true })).toBeNull();
    expect(lib.preflight({ ...base, localFiles: ["a.AppImage", "b.dmg"], release: draft([]) })).toBeNull();
    expect(lib.preflight({ ...base, localFiles: ["a.AppImage"], release: draft(["b.dmg"]) })).toBeNull();
    // --publish auf ein veröffentlichtes Release bleibt erlaubt (Nachführen), wenn Mac-Pakete da sind
    expect(lib.preflight({ ...base, localFiles: ["b.dmg"], release: { draft: false, assets: [] } })).toBeNull();
    expect(lib.hasMacPackages(["x.AppImage", "SHA256SUMS.txt"])).toBe(false);
    expect(lib.hasMacPackages(["x.app.tar.gz"])).toBe(true);
  });
});

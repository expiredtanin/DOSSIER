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
});

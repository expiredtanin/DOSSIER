// [268] Electron: externe Links im System-Browser, keine Kindfenster, keine fremde Navigation (reine Entscheide).
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const links = createRequire(import.meta.url)("../../scripts/electron-links.cjs");
const ORIGINS = ["dossier://app", "http://localhost:5187"];

describe("[268] Electron-Links", () => {
  it("window.open: nie ein Kindfenster; https/mailto gehen in den System-Browser", () => {
    expect(links.windowOpenDecision("https://git.openbureau.ch/karim/dossier/issues/new")).toEqual({
      action: "deny",
      external: "https://git.openbureau.ch/karim/dossier/issues/new",
    });
    expect(links.windowOpenDecision("mailto:a@b.ch").external).toBe("mailto:a@b.ch");
    for (const bad of ["http://example.org", "file:///etc/passwd", "javascript:alert(1)", "dossier://app/x", "data:text/html,x", "", "kaputt"]) {
      expect(links.windowOpenDecision(bad), bad).toEqual({ action: "deny", external: null });
    }
  });

  it("Navigation: nur App-Ursprung und Dev-Server, fremde https gehen extern", () => {
    expect(links.navigationDecision("dossier://app/index.html", ORIGINS).allow).toBe(true);
    expect(links.navigationDecision("http://localhost:5187/?x=1", ORIGINS).allow).toBe(true);
    expect(links.navigationDecision("https://example.org/", ORIGINS)).toEqual({ allow: false, external: "https://example.org/" });
    expect(links.navigationDecision("http://localhost:5188/", ORIGINS)).toEqual({ allow: false, external: null });
    expect(links.navigationDecision("file:///etc/passwd", ORIGINS)).toEqual({ allow: false, external: null });
    expect(links.navigationDecision("dossier://evil/", ORIGINS).allow).toBe(false);
  });

  it("CSP nur für den App-Ursprung", () => {
    expect(links.shouldSetCsp("dossier://app/assets/x.js", ORIGINS)).toBe(true);
    expect(links.shouldSetCsp("https://example.org/", ORIGINS)).toBe(false);
    expect(links.shouldSetCsp("devtools://devtools/x", ORIGINS)).toBe(false);
  });

  it("Hauptprozess verdrahtet Handler, Navigation und Weiterleitung", () => {
    const main = readFileSync(join(__dirname, "..", "..", "scripts", "electron-main.cjs"), "utf8");
    expect(main).toMatch(/setWindowOpenHandler/);
    expect(main).toMatch(/"will-navigate"/);
    expect(main).toMatch(/"will-redirect"/);
    expect(main).toMatch(/shell\.openExternal/);
  });
});

// [240] 3D-Werkzeugleiste: Zustände (Begehen an/aus), Texte über t() (de + en), Status des Pathtracers, Tastenhilfe.
// Ohne DOM: Server-Render der Komponente.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { getLanguage, setLanguage, t } from "../i18n";
import { ViewportToolbar3d, pathtraceProgress } from "./ViewportToolbar3d";

const noop = () => {};
const html = (walkMode: boolean, pathtrace: { samples: number; rate: number; done: boolean } | null = null) =>
  renderToStaticMarkup(createElement(ViewportToolbar3d, { walkMode, onToggleWalk: noop, onCreateCamera: noop, pathtrace }));

const lang = getLanguage();
afterEach(() => setLanguage(lang));

describe("ViewportToolbar3d", () => {
  it("Begehen aus: nicht gedrückt, Tooltip und aria-label über t(), keine Tastenhilfe", () => {
    setLanguage("de");
    const h = html(false);
    expect(h).toContain('role="toolbar"');
    expect(h).toContain('aria-pressed="false"');
    expect(h).toContain(`aria-label="${t("walk.tip.on")}"`);
    expect(h).toContain(`data-tip="${t("walk.tip.on")}"`);
    expect(h).not.toContain("walk-help");
    expect(h).not.toContain("is-on");
  });

  it("Begehen an: gedrückt, aktiver Zustand, Tastenhilfe vorhanden", () => {
    const h = html(true);
    expect(h).toContain('aria-pressed="true"');
    expect(h).toContain("vp3t-btn is-on");
    expect(h).toContain(t("walk.tip.off"));
    expect(h).toContain('data-testid="walk-help"');
    for (const k of ["W A S D", "Q / E", "Esc"]) expect(h).toContain(k);
  });

  it("[245] Geist: Knopf nur im Begehen und mit Handler, Taste G in der Tastenhilfe", () => {
    setLanguage("de");
    const withGhost = (walkMode: boolean, ghost: boolean) =>
      renderToStaticMarkup(createElement(ViewportToolbar3d, { walkMode, onToggleWalk: noop, ghost, onToggleGhost: noop, onCreateCamera: noop, pathtrace: null }));
    expect(withGhost(false, false)).not.toContain("walk-ghost");
    expect(html(true)).not.toContain("walk-ghost");
    const on = withGhost(true, true);
    expect(on).toContain('data-testid="walk-ghost"');
    expect(on).toContain(t("walk.tip.ghostOff"));
    expect(withGhost(true, false)).toContain(t("walk.tip.ghostOn"));
    expect(on).toContain(t("walk.help.ghost"));
    expect(on).toContain("<kbd>G</kbd>");
  });

  it("Kamera-Knopf hat Label und Test-ID", () => {
    const h = html(false);
    expect(h).toContain('data-testid="camera-create-3d"');
    expect(h).toContain(`aria-label="${t("viewport3d.camera.create")}"`);
  });

  it("Texte folgen der Sprache", () => {
    setLanguage("en");
    expect(html(false)).toContain("Start walking");
    setLanguage("de");
    expect(html(false)).toContain("Begehen einschalten");
  });

  it("Pathtracer-Status nur bei Pathtracing, mit Fortschrittsbalken", () => {
    expect(html(false)).not.toContain("pathtrace-status");
    const h = html(false, { samples: 256, rate: 3.2, done: false });
    expect(h).toContain('data-testid="pathtrace-status"');
    expect(h).toContain('role="progressbar"');
    expect(h).toContain('aria-valuenow="256"');
    expect(h).toContain("width:25%");
    expect(h).toContain("3.2");
  });

  it("Fertig: Hinweis ohne Rate, Balken voll", () => {
    const h = html(false, { samples: 1024, rate: 0, done: true });
    expect(h).toContain("is-done");
    expect(h).toContain("width:100%");
  });

  it("pathtraceProgress klemmt auf 0..1 und verwirft Unsinn", () => {
    expect(pathtraceProgress(512)).toBe(0.5);
    expect(pathtraceProgress(5000)).toBe(1);
    expect(pathtraceProgress(-3)).toBe(0);
    expect(pathtraceProgress(Number.NaN)).toBe(0);
  });
});

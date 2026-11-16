// [265] „Vorschau“-Marke: eine gemeinsame Komponente, in beiden Sprachen, mit Tooltip; nur Pathtracing im
// Darstellungsarten-Menü, Rendering mit Blender im Ansichtsmenü, Kamerafahrt (Knöpfe, Dialog), Geist-Knopf.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { setLanguage } from "../i18n/translate";
import { DropdownRows, optionRows } from "./Dropdown";
import { renderModeOptions } from "./TopBar";
import { PreviewBadge, previewHint, previewTitle, withPreview } from "./PreviewBadge";

afterEach(() => setLanguage("de"));

const rowsHtml = (rows: ReturnType<typeof optionRows>) =>
  renderToStaticMarkup(createElement(DropdownRows, { rows, activeIdx: -1, onHover: () => {}, onSelect: () => {} }));

describe("[265] PreviewBadge", () => {
  it("Marke und Tooltip in Deutsch und English", () => {
    expect(renderToStaticMarkup(createElement(PreviewBadge))).toContain(">Vorschau<");
    expect(previewHint()).toBe("Noch nicht fertig — Ergebnisse können abweichen");
    setLanguage("en");
    const h = renderToStaticMarkup(createElement(PreviewBadge));
    expect(h).toContain(">Preview<");
    expect(h).toContain('title="Not finished yet — results may differ"');
    expect(withPreview("Render")).toBe("Render · Preview");
    expect(previewTitle("Hinweis")).toBe("Hinweis — Not finished yet — results may differ");
  });

  it("Darstellungsarten: nur Pathtracing trägt die Marke", () => {
    const h = rowsHtml(optionRows(renderModeOptions()));
    expect(h.match(/class="preview-badge"/g)).toHaveLength(1);
    const pt = rowsHtml(optionRows(renderModeOptions().filter((o) => o.value === "pathtrace")));
    expect(pt).toContain("preview-badge");
    expect(pt).toContain(previewHint());
  });

  it("Quellen-Wächter: Rendering-Menü, Dialogtitel, Kamerafahrt und Geist-Knopf nutzen die gemeinsame Marke", () => {
    const has = (file: string, ...needles: string[]) => {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      for (const n of needles) expect(src, `${file}: ${n}`).toContain(n);
    };
    has("./AppMenuBar.tsx", 'label: t("menu.view.rendering"), onSelect: openRenderDialog, preview: true');
    has("../native/appMenu.ts", 'withPreview(t("menu.view.rendering"))');
    has("./RenderDialog.tsx", "<PreviewBadge />");
    has("./CameraTourDialog.tsx", "<PreviewBadge />");
    has("../panels/CamerasGroup.tsx", "<PreviewBadge />", "previewTitle(");
    has("../viewport/ViewportToolbar3d.tsx", 'testId="walk-ghost"\n              preview', "PreviewBadge");
  });
});

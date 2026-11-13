// [244] Dropdown: Gruppen, Icons, Zweitzeile, Kürzel; ohne diese Felder unverändert. Darstellungsarten im 3D gruppiert.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DropdownRows, optionRows } from "./Dropdown";
import { renderModeOptions } from "./TopBar";
import { t } from "../i18n";

const html = (rows: ReturnType<typeof optionRows>) =>
  renderToStaticMarkup(createElement(DropdownRows, { rows, activeIdx: -1, onHover: () => {}, onSelect: () => {} }));

describe("Dropdown [244]", () => {
  it("ohne Gruppen: keine Überschrift, kein Icon, kein Trenner (rückwärtskompatibel)", () => {
    const rows = optionRows([{ value: "a", label: "A" }, { value: "b", label: "B" }], "b");
    expect(rows).toHaveLength(2);
    const h = html(rows);
    expect(h).not.toContain("tb-dd-heading");
    expect(h).not.toContain("tb-dd-icon");
    expect(h).not.toContain("separator");
    expect(h).toContain('aria-selected="true"');
  });

  it("Gruppen: Überschrift je Gruppe, Trenner nur dazwischen", () => {
    const rows = optionRows([
      { value: "a", label: "A", group: "G1" }, { value: "b", label: "B", group: "G1" }, { value: "c", label: "C", group: "G2" },
    ]);
    expect(rows.filter((r) => r.divider)).toHaveLength(1);
    expect(rows.filter((r) => r.heading !== undefined).map((r) => r.heading)).toEqual(["G1", "G2"]);
    const h = html(rows);
    expect(h.match(/role="separator"/g)).toHaveLength(1);
    expect(h).toContain(">G1<");
  });

  it("Icon, Zweitzeile, Tooltip, Kürzel und Häkchen", () => {
    const h = html(optionRows([{ value: "a", label: "A", icon: "view_in_ar", hint: "Erklärung", shortcut: "W" }], "a"));
    expect(h).toContain("material-symbols-outlined tb-dd-icon");
    expect(h).toContain(">view_in_ar<");
    expect(h).toContain('class="tb-dd-hint">Erklärung<');
    expect(h).toContain('title="Erklärung"');
    expect(h).toContain(">W</kbd>");
    expect(h).toContain("tb-dd-check");
  });

  it("3D-Darstellungsarten: alle acht, drei Gruppen, Pathtracing erklärt", () => {
    const opts = renderModeOptions();
    expect(opts.map((o) => o.value).sort()).toEqual(
      ["contour", "hidden", "pathtrace", "shaded", "shaded-edges", "textured", "white", "wireframe"],
    );
    expect(new Set(opts.map((o) => o.group)).size).toBe(3);
    expect(opts.every((o) => o.icon && o.hint)).toBe(true);
    const h = html(optionRows(opts, "pathtrace"));
    expect(h).toContain(t("display.style.pathtrace.tip"));
    expect(h).toContain(t("display.group.lines"));
  });
});

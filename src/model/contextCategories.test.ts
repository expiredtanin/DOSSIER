/**
 * `ensureContextCategories` — ergänzt fehlende Kontext-Kategorien in
 * `project.layers`, ohne vorhandene (auch vom Nutzer umbenannte) Codes
 * anzutasten. Grundlage der Ebenen-Zuordnung importierter Kontext-Objekte
 * (Gebäude/Terrain/Konturen/Luftbild), s. Kopfkommentar in
 * `contextCategories.ts`. Seit 2026-08-31 landen die meisten dieser
 * Kategorien als KINDER von "05 Kontext" statt als Top-Level-Geschwister —
 * ausser "31 Dächer" (bleibt Top-Level, teilt sich den Code mit modellierten
 * `Roof`-Objekten).
 */
import { describe, it, expect } from "vitest";
import {
  ensureContextCategories,
  GEO_CATEGORY_DEFS,
  IMAGE_CATEGORY,
  TERRAIN_CATEGORY,
  IMPORTED_ROOF_CATEGORY,
  CONTEXT_PARENT_CATEGORY,
  GENERIC_IMPORT_CATEGORY,
} from "./contextCategories";
import type { LayerCategory } from "./types";

const layer = (code: string, name = code): LayerCategory => ({
  code,
  name,
  color: "#000000",
  lw: 0.13,
  visible: true,
  locked: false,
});

describe("ensureContextCategories", () => {
  it("legt '05 Kontext' neu an und hängt eine fehlende (nested) Kategorie als Kind ein", () => {
    const out = ensureContextCategories([], [TERRAIN_CATEGORY.code]);
    expect(out.length).toBe(1);
    expect(out[0]).toMatchObject({
      code: CONTEXT_PARENT_CATEGORY.code,
      name: CONTEXT_PARENT_CATEGORY.name,
    });
    expect(out[0].children).toMatchObject([
      { code: TERRAIN_CATEGORY.code, name: TERRAIN_CATEGORY.name, visible: true, locked: false },
    ]);
  });

  it("lässt eine bereits vorhandene (auch umbenannte) Kategorie unverändert", () => {
    const existing = [layer(TERRAIN_CATEGORY.code, "Mein Gelände")];
    const out = ensureContextCategories(existing, [TERRAIN_CATEGORY.code]);
    expect(out).toEqual(existing);
    expect(out[0].name).toBe("Mein Gelände"); // NICHT auf den Default zurückgesetzt
  });

  it("ist ein No-op (dieselbe Referenz), wenn nichts fehlt", () => {
    const existing = [layer(GEO_CATEGORY_DEFS.building.code)];
    const out = ensureContextCategories(existing, [GEO_CATEGORY_DEFS.building.code]);
    expect(out).toBe(existing);
  });

  it("findet vorhandene Codes auch in verschachtelten Unterkategorien", () => {
    const existing: LayerCategory[] = [
      { ...layer("20", "Wände"), children: [layer(GEO_CATEGORY_DEFS.road.code, "Strasse")] },
    ];
    const out = ensureContextCategories(existing, [GEO_CATEGORY_DEFS.road.code]);
    expect(out).toBe(existing); // "11" existiert bereits als Kind -> kein Duplikat oben
  });

  it("hängt mehrere fehlende nested Codes gebündelt unter EIN '05 Kontext' (kein Duplikat), in einem Schritt", () => {
    const out = ensureContextCategories([], [
      TERRAIN_CATEGORY.code,
      IMAGE_CATEGORY.code,
      GEO_CATEGORY_DEFS.building.code,
    ]);
    expect(out.map((l) => l.code)).toEqual([CONTEXT_PARENT_CATEGORY.code]);
    const childCodes = (out[0].children ?? []).map((c) => c.code).sort();
    expect(childCodes).toEqual(
      [TERRAIN_CATEGORY.code, IMAGE_CATEGORY.code, GEO_CATEGORY_DEFS.building.code].sort(),
    );
  });

  it("ergänzt fehlende Kinder in ein bereits vorhandenes '05 Kontext' (kein zweites '05')", () => {
    const existing: LayerCategory[] = [
      { ...layer(CONTEXT_PARENT_CATEGORY.code, "Kontext"), children: [layer(IMAGE_CATEGORY.code, "Luftbild")] },
    ];
    const out = ensureContextCategories(existing, [IMAGE_CATEGORY.code, TERRAIN_CATEGORY.code]);
    expect(out.map((l) => l.code)).toEqual([CONTEXT_PARENT_CATEGORY.code]); // kein zweiter Top-Level-Eintrag
    const childCodes = (out[0].children ?? []).map((c) => c.code).sort();
    expect(childCodes).toEqual([IMAGE_CATEGORY.code, TERRAIN_CATEGORY.code].sort());
    // vorhandenes Kind (Luftbild, ggf. umbenannt) bleibt unangetastet.
    expect(out[0].children?.find((c) => c.code === IMAGE_CATEGORY.code)?.name).toBe("Luftbild");
  });

  it("'31 Dächer' bleibt TOP-LEVEL (nicht unter '05 Kontext' verschachtelt)", () => {
    const out = ensureContextCategories([], [IMPORTED_ROOF_CATEGORY.code]);
    expect(out).toMatchObject([
      { code: IMPORTED_ROOF_CATEGORY.code, name: IMPORTED_ROOF_CATEGORY.name },
    ]);
    expect(out[0].children).toBeUndefined();
  });

  it("mischt nested + Top-Level-Ausnahme korrekt in einem Aufruf", () => {
    const out = ensureContextCategories([], [TERRAIN_CATEGORY.code, IMPORTED_ROOF_CATEGORY.code]);
    const topCodes = out.map((l) => l.code).sort();
    expect(topCodes).toEqual([CONTEXT_PARENT_CATEGORY.code, IMPORTED_ROOF_CATEGORY.code].sort());
    const kontext = out.find((l) => l.code === CONTEXT_PARENT_CATEGORY.code);
    expect(kontext?.children).toMatchObject([{ code: TERRAIN_CATEGORY.code }]);
  });

  it("ignoriert unbekannte Codes (kein Eintrag in den bekannten Definitionen) statt zu crashen", () => {
    const out = ensureContextCategories([], ["zz-unknown"]);
    expect(out).toEqual([]);
  });

  it("Tabelle im Kern = Definitionen hier (alle Codes)", () => {
    const nested = [TERRAIN_CATEGORY, IMAGE_CATEGORY, GENERIC_IMPORT_CATEGORY, ...Object.values(GEO_CATEGORY_DEFS)];
    const cat = (c: { code: string; name: string; color: string; lw: number }) => ({ code: c.code, name: c.name, color: c.color, lw: c.lw, visible: true, locked: false });
    const out = ensureContextCategories([], [...nested.map((c) => c.code), IMPORTED_ROOF_CATEGORY.code]);
    expect(out).toEqual([{ ...cat(CONTEXT_PARENT_CATEGORY), children: nested.map(cat) }, cat(IMPORTED_ROOF_CATEGORY)]);
  });
});

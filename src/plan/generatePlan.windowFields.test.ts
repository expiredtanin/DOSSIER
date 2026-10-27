/**
 * Unit-Tests für die NEUEN Fenster-Modellfelder im Grundriss (generatePlan +
 * geometry/opening.windowSymbol):
 *  • `WindowType.sashes` (Flügeltabelle) — ersetzt die gleichmäßige
 *    `wingCount`-Ableitung durch echte Flügel-/Pfostenbreiten, sobald ein
 *    Fenstertyp referenziert ist. Alt-Fall (keine `sashes`/kein `typeId`)
 *    bleibt UNVERÄNDERT (reines `Opening.wingCount`, siehe
 *    generatePlan.openings.test.ts).
 *  • `WindowType.glazingPanes` — steuert die Anzahl paralleler Glaslinien.
 *  • `WindowType.shading` — zeichnet eine zusätzliche, gestrichelte
 *    Kastenkontur über der Öffnung.
 *  • Öffnungsandeutung je Flügel (`SashDef.opening`/`hingeSide`).
 */

import { describe, it, expect } from "vitest";
import { generatePlan } from "./generatePlan";
import type { Opening, Project, Wall, WindowType } from "../model/types";

/** Minimalprojekt: eine Wand (Dicke 0.3 m, Achse mittig, horizontal entlang x)
 *  + eine Fenster-Öffnung + optionale Fenstertyp-Bibliothek. */
function project(opening: Opening, windowTypes?: WindowType[]): Project {
  const wall: Wall = {
    id: "W1",
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start: { x: 0, y: 0 },
    end: { x: 4, y: 0 },
    wallTypeId: "aw",
    height: 2.6,
  };
  return {
    id: "t",
    name: "T",
    lineStyles: [{ id: "thin", name: "d", weight: 0.13, color: "#111", dash: null }],
    hatches: [{ id: "none", name: "Ohne", pattern: "none", scale: 1, angle: 0, color: "#111" }],
    components: [{ id: "a", name: "A", color: "#d8d2c7", hatchId: "none", joinPriority: 10 }],
    wallTypes: [{ id: "aw", name: "AW", layers: [{ componentId: "a", thickness: 0.3 }] }],
    windowTypes,
    drawingLevels: [
      {
        id: "eg",
        name: "EG",
        kind: "floor",
        visible: true,
        locked: false,
        floorHeight: 2.6,
        cutHeight: 1.0,
        baseElevation: 0,
      },
    ],
    layers: [
      { code: "20", name: "Wände", color: "#0a0a0a", lw: 0.5, visible: true, locked: false },
      { code: "21", name: "Öffnungen", color: "#0a0a0a", lw: 0.3, visible: true, locked: false },
    ],
    walls: [wall],
    openings: [opening],
    ceilings: [],
    stairs: [],
    rooms: [],
    drawings2d: [],
    context: [],
  };
}

const visible = new Set(["20", "21"]);

/** Basis-Fenster (Brüstung 0, damit keine Sill-Linie mitzählt), position 1.0, width 1.2. */
const baseWindow: Opening = {
  id: "F1",
  type: "opening",
  hostWallId: "W1",
  categoryCode: "21",
  kind: "window",
  position: 1.0,
  width: 1.2,
  height: 1.2,
  sillHeight: 0,
};

/** Minimaler Fenstertyp (Grunddaten, Felder je Test überschrieben/ergänzt). */
const baseWindowType: WindowType = {
  id: "wt1",
  name: "Test-Fenster",
  kind: "dreh",
  wingCount: 1,
  glazing: "einfach",
  frameThickness: 0.06,
  defaultSillHeight: 0.8,
  defaultWidth: 1.2,
  defaultHeight: 1.2,
};

function linesOfClass(p: Project, cls: string, detail: "grob" | "mittel" | "fein" = "mittel") {
  return generatePlan(p, "eg", visible, undefined, detail).primitives.filter(
    (pr) => pr.kind === "line" && pr.cls === cls,
  );
}

/** Mittelpunkt (x) jedes Rahmenblocks (4 Linien = ein Rechteck, s. windowSymbol
 *  meetingMarks) unter den `window-stulp`-Primitiven, sortiert. */
function stulpBlockCenters(p: Project, detail: "grob" | "mittel" | "fein" = "mittel"): number[] {
  const lines = linesOfClass(p, "window-stulp", detail);
  const centers: number[] = [];
  for (let i = 0; i < lines.length; i += 4) {
    const group = lines.slice(i, i + 4);
    const xs = group.flatMap((pr) => (pr.kind === "line" ? [pr.a.x, pr.b.x] : []));
    centers.push((Math.min(...xs) + Math.max(...xs)) / 2);
  }
  return centers.sort((a, b) => a - b);
}

describe("generatePlan — Flügeleinteilung aus sashes (Item 1)", () => {
  it("Alt-Fall (kein typeId/sashes, nur wingCount=3) erzeugt genau 2 Pfostenlinien — Regression", () => {
    const p = project({ ...baseWindow, wingCount: 3 });
    expect(linesOfClass(p, "window-mullion").length).toBe(2);
  });

  it("WindowType MIT sashes (3 feste Flügelbreiten 0.4 m) erzeugt Rahmenblöcke (keine Linie mehr) exakt an den Flügelgrenzen", () => {
    // Öffnung 1.2 m breit, jambStart bei x=1.0 (position 1.0) -> jambEnd x=2.2.
    // 3 Flügel à 0.4 m (autoWidth:false) -> Stoss-Blöcke bei x=1.4 und x=1.8.
    // KEINE separate window-mullion-Linie mehr (Nutzer-Feedback: nur der Block
    // markiert den Stoss, keine zusätzliche dünne Trennlinie daneben).
    const wt: WindowType = {
      ...baseWindowType,
      sashes: [
        { kind: "fluegel", autoWidth: false, width: 0.4, opening: "dreh", hingeSide: "left" },
        { kind: "fluegel", autoWidth: false, width: 0.4, opening: "kipp" },
        { kind: "fluegel", autoWidth: false, width: 0.4, opening: "dreh", hingeSide: "right" },
      ],
    };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    expect(linesOfClass(p, "window-mullion").length).toBe(0);
    // 2 Laibungs-Blöcke (Enden, nahe x=1.0/2.2) + 2 Flügelstoss-Blöcke (1.4/1.8).
    const junctionCenters = stulpBlockCenters(p, "mittel").filter((x) => x > 1.2 && x < 2.0);
    expect(junctionCenters.length).toBe(2);
    expect(junctionCenters[0]).toBeCloseTo(1.4, 6);
    expect(junctionCenters[1]).toBeCloseTo(1.8, 6);
  });

  it("WindowType MIT sashes, aber alle autoWidth (kein fixes width/pfosten) -> Rahmenblöcke an denselben Positionen wie die alte wingCount-Gleichverteilung", () => {
    // 3 gleichmässige Flügel über sashesOfWindowType (kein `sashes` am Typ,
    // nur `wingCount: 3`) müssen an denselben Achspositionen einen Stoss haben
    // wie der Alt-Fall ohne Typ (Regressionssicherheit der Ableitung) — der
    // Alt-Fall zeigt sie weiterhin als Linie, der typisierte Pfad als Block.
    const wt: WindowType = { ...baseWindowType, wingCount: 3 };
    const withType = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    const withoutType = project({ ...baseWindow, wingCount: 3 });
    const a = stulpBlockCenters(withType, "mittel").filter((x) => x > 1.2 && x < 2.0);
    const b = linesOfClass(withoutType, "window-mullion")
      .map((pr) => (pr.kind === "line" ? pr.a.x : NaN))
      .sort((x, y) => x - y);
    expect(a.length).toBe(b.length);
    a.forEach((v, i) => expect(v).toBeCloseTo(b[i], 9));
  });

  it("öffenbarer Flügel bekommt einen Flügelrahmen (window-sash, 4 Kanten) bei 'fein'; 'fest' keinen — SIA fig. 38 (verschachtelter Flügelrahmen nur bei fein, s. sia400-fenster-tueren.md)", () => {
    // Ein öffenbarer + ein fester Flügel: genau EIN Flügelrahmen-Rechteck = 4
    // Kanten-Linien (der feste Flügel bekommt keinen; Glas sitzt direkt im
    // Blendrahmen). So liest man fest vs. öffenbar direkt im Grundriss.
    // Nur bei „fein" (SIA fig. 38) — „mittel" (fig. 37) bleibt beim reinen
    // Blendrahmen-Band ohne verschachtelten Flügelrahmen.
    const wt: WindowType = {
      ...baseWindowType,
      sashes: [
        { kind: "fluegel", autoWidth: true, opening: "dreh", hingeSide: "left" },
        { kind: "fluegel", autoWidth: true, opening: "fest" },
      ],
    };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    expect(linesOfClass(p, "window-sash", "fein").length).toBe(4);
    expect(linesOfClass(p, "window-sash", "mittel").length).toBe(0);

    // Nur feste Flügel -> gar kein Flügelrahmen.
    const wtFixed: WindowType = {
      ...baseWindowType,
      sashes: [{ kind: "fluegel", autoWidth: true, opening: "fest" }],
    };
    const pFixed = project({ ...baseWindow, typeId: "wt1" }, [wtFixed]);
    expect(linesOfClass(pFixed, "window-sash", "fein").length).toBe(0);
  });

  it("Alt-Fall (kein typeId) erzeugt KEINEN Flügelrahmen", () => {
    const p = project({ ...baseWindow });
    expect(linesOfClass(p, "window-sash", "fein").length).toBe(0);
  });
});

describe("generatePlan — Verglasung glazingPanes (Item 2)", () => {
  const glassLineCount = (p: Project, detail: "grob" | "mittel" | "fein" = "mittel") =>
    linesOfClass(p, "window-glass", detail).length;

  it("glazingPanes beeinflusst die 2D-Glaslinienzahl NICHT mehr — typisierte Fenster zeigen GAR KEINE Glaslinie im Grundriss (Nutzer-Feedback: keine Haarlinie mittig im Feld, unabhängig von Detailgrad/Fensterposition)", () => {
    const wt3: WindowType = { ...baseWindowType, id: "wt3", glazingPanes: 3 };
    const wt1: WindowType = { ...baseWindowType, id: "wt1", glazingPanes: 1 };
    const p3 = project({ ...baseWindow, typeId: "wt3" }, [wt3]);
    const p1 = project({ ...baseWindow, typeId: "wt1" }, [wt1]);
    expect(glassLineCount(p3, "mittel")).toBe(0);
    expect(glassLineCount(p1, "mittel")).toBe(0);
    expect(glassLineCount(p3, "fein")).toBe(0);
    expect(glassLineCount(p1, "fein")).toBe(0);
  });

  it("ohne typeId bleibt die alte Detailgrad-Regel (grob/mittel=1, fein=2) unverändert — Regression", () => {
    const p = project({ ...baseWindow });
    expect(glassLineCount(p, "grob")).toBe(1);
    expect(glassLineCount(p, "mittel")).toBe(1);
    expect(glassLineCount(p, "fein")).toBe(2);
  });

  it("glazingPanes wirkt bei 'grob' NICHT (bleibt bei 1 Glaslinie)", () => {
    const wt: WindowType = { ...baseWindowType, glazingPanes: 3 };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    expect(glassLineCount(p, "grob")).toBe(1);
  });
});

describe("generatePlan — Stulp-/Flügelstoss-Marken (SIA fig. 37/38, window-stulp)", () => {
  const stulpLineCount = (p: Project, detail: "grob" | "mittel" | "fein") =>
    linesOfClass(p, "window-stulp", detail).length;
  const twoSashType: WindowType = {
    ...baseWindowType,
    sashes: [
      { kind: "fluegel", autoWidth: true, opening: "dreh", hingeSide: "left" },
      { kind: "fluegel", autoWidth: true, opening: "dreh", hingeSide: "right" },
    ],
  };

  // Jeder Block ist ein Rechteck über die VOLLE Rahmentiefe (4 Linien) — je EIN
  // Block an JEDEM Laibungs-Ende (Blendrahmen-Querschnitt, immer vorhanden)
  // plus die Flügelstoss-Blöcke an inneren Junctions (mittel 1, fein 2).

  it("mittel: 2 Laibungs-Blöcke (Enden) + EIN Stulp-Block je Flügel-Junction", () => {
    const p = project({ ...baseWindow, typeId: "wt1" }, [twoSashType]);
    // 2 Laibungsenden + 1 Junction = 3 Blöcke × 4 Linien.
    expect(stulpLineCount(p, "mittel")).toBe(12);
  });

  it("fein: 2 Laibungs-Blöcke (Enden) + ZWEI Stulp-Blöcke je Flügel-Junction", () => {
    const p = project({ ...baseWindow, typeId: "wt1" }, [twoSashType]);
    // 2 Laibungsenden + 2 Junction-Blöcke = 4 Blöcke × 4 Linien.
    expect(stulpLineCount(p, "fein")).toBe(16);
  });

  it("grob: KEINE Rahmen-Blöcke", () => {
    const p = project({ ...baseWindow, typeId: "wt1" }, [twoSashType]);
    expect(stulpLineCount(p, "grob")).toBe(0);
  });

  it("Alt-Fall (kein typeId, nur wingCount) erzeugt KEINE Rahmen-Blöcke — keine echte Flügeltabelle", () => {
    const p = project({ ...baseWindow, wingCount: 3 });
    expect(stulpLineCount(p, "mittel")).toBe(0);
    expect(stulpLineCount(p, "fein")).toBe(0);
  });

  it("einflügliges Fenster (keine Junction) zeigt trotzdem die 2 Laibungs-Blöcke an den Enden", () => {
    const p = project({ ...baseWindow, typeId: "wt1" }, [baseWindowType]);
    expect(stulpLineCount(p, "mittel")).toBe(8);
    expect(stulpLineCount(p, "fein")).toBe(8);
  });
});

describe("generatePlan — Fensterbank (window-sill) folgt der eingezogenen Rahmenkante", () => {
  // Wand 0.3 m dick, Achse mittig (refOff=0). "Aussen" liegt bei der NEGATIVEN
  // Wandnormalen-Seite (erste Wandtyp-Schicht, s. addWallPoche/windowSymbol) —
  // volle Wandfläche aussen wäre also bei n=−0.15. Ein um 0.05 m eingezogener
  // Rahmen (insetFromFace) sitzt bei n=−0.10 (−halfT + inset) — die Fensterbank
  // muss DORT ansetzen (nicht an der vollen Wandfläche −0.15) und kragt von dort
  // WEITER nach aussen aus (−0.04, also bis −0.14) — Regression für den Nutzer-
  // Report "Sims sitzt falsch" (ursprünglich) bzw. "2D innen bündig, 3D aussen
  // bündig" (die zugrundeliegende aussen/innen-Vorzeichenverwechslung).
  it("Fensterbank sitzt an der eingezogenen Rahmen-Aussenkante, nicht an der vollen Wandfläche", () => {
    const wt: WindowType = {
      ...baseWindowType,
      sashes: [{ kind: "fluegel", autoWidth: true, opening: "fest" }],
      insetFromFace: 0.05,
      insetFace: "aussen",
      frameDepth: 0.07,
    };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    const sill = linesOfClass(p, "window-sill", "fein");
    expect(sill.length).toBe(4);
    const ys = sill
      .flatMap((pr) => (pr.kind === "line" ? [pr.a.y, pr.b.y] : []))
      .map((y) => Math.round(y * 1000) / 1000);
    // Näher Rand (wandseitig) = eingezogene Rahmen-Aussenkante (−0.10), NICHT
    // die volle Wandfläche (−0.15 — der alte, fehlerhafte Wert vor dem Fix).
    expect(Math.max(...ys)).toBeCloseTo(-0.1, 6);
    expect(Math.max(...ys)).not.toBeCloseTo(-0.15, 2);
    // Auskragung geht weiter nach aussen (algebraisch kleiner): −0.10 − 0.04.
    expect(Math.min(...ys)).toBeCloseTo(-0.14, 6);
  });
});

describe("generatePlan — Auf-/Untersicht-Andeutung (WindowType.sillLine)", () => {
  // "mittel" isoliert die sillLine-Linien sauber von der (fein-only) Fenster-
  // bank-Box (dieselbe cls, andere Bedingung) — bei mittel kann Letztere nicht
  // feuern, jede window-sill-Linie hier stammt also von sillLine.
  it("fehlt sillLine -> keine window-sill-Linie", () => {
    const p = project({ ...baseWindow, typeId: "wt1" }, [baseWindowType]);
    expect(linesOfClass(p, "window-sill", "mittel").length).toBe(0);
  });

  it("faces: 'aussen' -> genau EINE Linie, an der Rahmen-Aussenkante", () => {
    const wt: WindowType = { ...baseWindowType, sillLine: { faces: "aussen", view: "auf" } };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    const lines = linesOfClass(p, "window-sill", "mittel");
    expect(lines.length).toBe(1);
  });

  it("faces: 'beide' -> ZWEI Linien (aussen + innen)", () => {
    const wt: WindowType = { ...baseWindowType, sillLine: { faces: "beide", view: "auf" } };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    expect(linesOfClass(p, "window-sill", "mittel").length).toBe(2);
  });

  it("bei 'grob' nie sichtbar, unabhängig von faces", () => {
    const wt: WindowType = { ...baseWindowType, sillLine: { faces: "beide", view: "auf" } };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    expect(linesOfClass(p, "window-sill", "grob").length).toBe(0);
  });

  it("view: 'unter' nutzt die Überkopf-Strichelung (gestrichelt wie sonstige Überkopf-Projektionen)", () => {
    const wt: WindowType = { ...baseWindowType, sillLine: { faces: "aussen", view: "unter" } };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    const lines = linesOfClass(p, "window-sill", "mittel");
    expect(lines.length).toBe(1);
    expect(lines[0].kind === "line" && lines[0].dash).toEqual([0.4, 0.25]);
  });
});

describe("generatePlan — Linien-Übersteuerung je Kategorie (Opening.frameLine/sashLine/sillLineStyle)", () => {
  const twoSashType: WindowType = {
    ...baseWindowType,
    sashes: [
      { kind: "fluegel", autoWidth: true, opening: "dreh", hingeSide: "left" },
      { kind: "fluegel", autoWidth: true, opening: "dreh", hingeSide: "right" },
    ],
    sillLine: { faces: "aussen", view: "auf" },
  };

  it("ohne Übersteuerung: Stulp-/Sash-/Sims-Linien nutzen den Default (Opening.color bzw. Haarlinie)", () => {
    const p = project({ ...baseWindow, typeId: "wt1" }, [twoSashType]);
    const stulp = linesOfClass(p, "window-stulp", "mittel");
    expect(stulp.length).toBeGreaterThan(0);
    for (const l of stulp) expect(l.kind === "line" && l.weightMm).toBeCloseTo(0.02, 6);
  });

  it("frameLine übersteuert Farbe+Stärke der Laibungs-Blöcke (window-stulp, einflügliges Fenster ohne Flügelstoss)", () => {
    // Einflüglig -> nur jambMarks (Laibungs-Enden, "Rahmen"), keine
    // Flügelstoss-Blöcke -> eindeutig zuordenbar.
    const p = project(
      { ...baseWindow, typeId: "wt1", frameLine: { color: "#ff0000", weight: 0.5 } },
      [baseWindowType],
    );
    const stulp = linesOfClass(p, "window-stulp", "mittel");
    expect(stulp.length).toBeGreaterThan(0);
    for (const l of stulp) {
      expect(l.kind === "line" && l.color).toBe("#ff0000");
      expect(l.kind === "line" && l.weightMm).toBeCloseTo(0.5, 6);
    }
  });

  it("sashLine übersteuert Farbe+Stärke des Flügelrahmens (window-sash, fein) UND der Flügelstoss-Blöcke (window-stulp an der Junction) — NICHT die Laibungs-Enden", () => {
    const p = project(
      { ...baseWindow, typeId: "wt1", sashLine: { color: "#00ff00", weight: 0.3 } },
      [twoSashType],
    );
    const sash = linesOfClass(p, "window-sash", "fein");
    expect(sash.length).toBeGreaterThan(0);
    for (const l of sash) {
      expect(l.kind === "line" && l.color).toBe("#00ff00");
      expect(l.kind === "line" && l.weightMm).toBeCloseTo(0.3, 6);
    }
    // Öffnung 1.2 m breit ab x=1.0 -> Junction bei x=1.6 (Mitte), Laibungs-
    // Enden bei x≈1.03/2.17 (fw/2 vom Rand). Nur die Junction-Blöcke (Mitte)
    // reagieren auf sashLine; die Laibungs-Enden bleiben beim Default.
    const stulp = linesOfClass(p, "window-stulp", "mittel");
    const junction = stulp.filter((l) => l.kind === "line" && l.a.x > 1.3 && l.a.x < 1.9);
    const jamb = stulp.filter((l) => l.kind === "line" && (l.a.x < 1.3 || l.a.x > 1.9));
    expect(junction.length).toBeGreaterThan(0);
    expect(jamb.length).toBeGreaterThan(0);
    for (const l of junction) expect(l.kind === "line" && l.color).toBe("#00ff00");
    for (const l of jamb) expect(l.kind === "line" && l.color).toBe("#1a1a1a");
  });

  it("sillLineStyle übersteuert Farbe+Stärke der Auf-/Untersicht-Linie (window-sill)", () => {
    const p = project(
      { ...baseWindow, typeId: "wt1", sillLineStyle: { color: "#0000ff", weight: 0.4 } },
      [twoSashType],
    );
    const sill = linesOfClass(p, "window-sill", "mittel");
    expect(sill.length).toBe(1);
    expect(sill[0].kind === "line" && sill[0].color).toBe("#0000ff");
    expect(sill[0].kind === "line" && sill[0].weightMm).toBeCloseTo(0.4, 6);
  });

  it("frameViewLine ohne Übersteuerung: die Rahmen-Kontur (Aufsicht) fällt auf frameLine zurück", () => {
    const p = project(
      { ...baseWindow, typeId: "wt1", frameLine: { color: "#ff0000", weight: 0.5 } },
      [baseWindowType],
    );
    const frame = generatePlan(p, "eg", visible, undefined, "mittel").primitives.find(
      (pr) => pr.kind === "polygon" && pr.openingId === "F1" && pr.stroke !== "none",
    );
    expect(frame).toBeDefined();
    expect(frame!.kind === "polygon" && frame!.stroke).toBe("#ff0000");
    expect(frame!.kind === "polygon" && frame!.strokeWidthMm).toBeCloseTo(0.5, 6);
  });

  it("frameViewLine übersteuert NUR die Rahmen-Kontur (Aufsicht) — die Laibungs-Blöcke (Schnitt) bleiben beim frameLine-Default", () => {
    const p = project(
      {
        ...baseWindow,
        typeId: "wt1",
        frameLine: { color: "#ff0000", weight: 0.5 },
        frameViewLine: { color: "#00ffff", weight: 0.2 },
      },
      [baseWindowType],
    );
    const out = generatePlan(p, "eg", visible, undefined, "mittel").primitives;
    const frame = out.find((pr) => pr.kind === "polygon" && pr.openingId === "F1" && pr.stroke !== "none");
    expect(frame!.kind === "polygon" && frame!.stroke).toBe("#00ffff");
    expect(frame!.kind === "polygon" && frame!.strokeWidthMm).toBeCloseTo(0.2, 6);
    // Laibungs-Blöcke (window-stulp) bleiben unverändert bei frameLine, NICHT frameViewLine.
    const stulp = out.filter((pr) => pr.kind === "line" && pr.cls === "window-stulp");
    expect(stulp.length).toBeGreaterThan(0);
    for (const l of stulp) {
      expect(l.kind === "line" && l.color).toBe("#ff0000");
      expect(l.kind === "line" && l.weightMm).toBeCloseTo(0.5, 6);
    }
  });

  it("sashLine wirkt auch bei 'grob' (1:100) auf die einzige dort sichtbare Glaslinie", () => {
    const p = project(
      { ...baseWindow, typeId: "wt1", sashLine: { color: "#00ff00", weight: 0.3 } },
      [twoSashType],
    );
    const g = linesOfClass(p, "window-glass", "grob");
    expect(g.length).toBe(1);
    expect(g[0].kind === "line" && g[0].color).toBe("#00ff00");
    expect(g[0].kind === "line" && g[0].weightMm).toBeCloseTo(0.3, 6);
  });
});

describe("generatePlan — Rollladenkasten shading (Item 3)", () => {
  const shadingLineCount = (p: Project) => linesOfClass(p, "window-shading").length;

  it("shading.create: true erzeugt eine zusätzliche Kastenkontur (4 Linien)", () => {
    const wt: WindowType = {
      ...baseWindowType,
      shading: { create: true, kind: "rollladen", box: { width: 1.2, height: 0.2, depth: 0.15 } },
    };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    expect(shadingLineCount(p)).toBe(4);
  });

  it("shading.create: false erzeugt KEINE Kastenkontur", () => {
    const wt: WindowType = {
      ...baseWindowType,
      shading: { create: false, kind: "rollladen", box: { width: 1.2, height: 0.2, depth: 0.15 } },
    };
    const p = project({ ...baseWindow, typeId: "wt1" }, [wt]);
    expect(shadingLineCount(p)).toBe(0);
  });

  it("kein shading-Feld am Typ erzeugt KEINE Kastenkontur", () => {
    const p = project({ ...baseWindow, typeId: "wt1" }, [baseWindowType]);
    expect(shadingLineCount(p)).toBe(0);
  });

  it("ohne typeId (Alt-Fall) erzeugt KEINE Kastenkontur", () => {
    const p = project({ ...baseWindow });
    expect(shadingLineCount(p)).toBe(0);
  });
});

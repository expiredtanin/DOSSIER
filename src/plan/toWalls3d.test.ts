/**
 * Unit-Tests für {@link selectionHighlightLines} (Umriss-Linien der 3D-
 * Auswahl, s. Datei-Kommentar in toWalls3d.ts): korrekte Vertexanzahl je
 * Bauteilart (Wand-Quader = 12 Kanten, Slab-Prisma = 3·n Kanten) sowie die
 * Leerfälle (keine Auswahl / unbekannte Id).
 */

import { describe, it, expect } from "vitest";
import type { Project, Roof, Wall } from "../model/types";
import { sampleProject } from "../model/sampleProject";
import { selectionHighlightLines, projectToWalls3d, projectToModel3d, pickGeometry } from "./toWalls3d";
import { resolveHatch } from "./generatePlan";
import { roofGeometry, roofBaseElevation } from "../geometry/roof";

const RGB: [number, number, number] = [1, 0.5, 0.1];
const FLOATS_PER_VERTEX = 6; // [px,py,pz, r,g,b]
const VERTICES_PER_EDGE = 2;

describe("selectionHighlightLines", () => {
  it("leere Auswahl -> leeres Array", () => {
    const lines = selectionHighlightLines(sampleProject, [], [], RGB);
    expect(lines.length).toBe(0);
  });

  it("unbekannte Ids -> leeres Array (keine Übereinstimmung in der Geometrie)", () => {
    const lines = selectionHighlightLines(sampleProject, ["does-not-exist"], [], RGB);
    expect(lines.length).toBe(0);
  });

  it("ein Dach -> Draht-Kanten der Dachflächen/Giebel (nicht leer, mit Farbe)", () => {
    // sampleProject enthält das Demo-Satteldach RF1.
    const lines = selectionHighlightLines(sampleProject, [], [], RGB, [], [], ["RF1"]);
    expect(lines.length).toBeGreaterThan(0);
    // Farbe in jedem Vertex (erstes Vertex: [px,py,pz,r,g,b]).
    expect(lines[3]).toBeCloseTo(RGB[0], 6);
    expect(lines[5]).toBeCloseTo(RGB[2], 6);
  });

  it("eine Wand ohne Öffnungen -> je Materiallage ein Quader, Kern-Band unter der Decke gespalten (5·12 Kanten)", () => {
    // W2 (EG, Ost) trägt keine Tür/kein Fenster im Sample-Projekt (nur W1/W3
    // haben Öffnungen, s. sampleProject.ts) -> ein Achsen-Teilquader. Wandtyp
    // "aw" hat 4 Schichten (render-ext/insulation/brick/render-int), die
    // TS-seitig je als eigene Box gestapelt werden (Option B).
    // NEU (per-Schicht-Decken-Dominanz): W2 steht unter der Geschossdecke C1
    // (dg-massiv: screed 30 / insulation 20 / concrete 100). Der Backstein (50)
    // wird NUR von der Beton-Schicht (100) im z-Band [2.3,2.5] gekappt und läuft
    // darüber (bis Wandkopf 2.6) durch -> ZWEI Backstein-Boxen [0,2.3] + [2.5,2.6].
    // Die anderen Bänder bleiben je 1 Box (Aussenputz/Dämmung aussen: ungeschnitten;
    // Innenputz 10 < alle Deckenschichten: bis 2.3). Also 5 Quader = 5·12 Kanten.
    const lines = selectionHighlightLines(sampleProject, ["W2"], [], RGB);
    expect(lines.length).toBe(5 * 12 * VERTICES_PER_EDGE * FLOATS_PER_VERTEX);
  });

  it("eine Wand mit Farbwerten in jedem Vertex", () => {
    const lines = selectionHighlightLines(sampleProject, ["W2"], [], RGB);
    // Erstes Vertex: Position (3) + Farbe (3) = [px,py,pz,r,g,b].
    expect(lines[3]).toBeCloseTo(RGB[0], 6);
    expect(lines[4]).toBeCloseTo(RGB[1], 6);
    expect(lines[5]).toBeCloseTo(RGB[2], 6);
  });

  it("eine Decke (Slab) -> je Schicht 3·n Kanten (geschichteter Bodenaufbau)", () => {
    // C1 hat einen 4-eckigen Umriss (5x4m Rechteck) -> 3*4 = 12 Kanten JE SCHICHT.
    // Deckentyp "dg-massiv" hat 3 Schichten (Estrich/Dämmung/Beton) -> je ein
    // eigener Slab, damit der 3D-Schnitt den Aufbau geschichtet zeigt (wie 2D).
    const lines = selectionHighlightLines(sampleProject, [], ["C1"], RGB);
    const n = 4;
    const layers = 3; // dg-massiv: screed + insulation + concrete
    expect(lines.length).toBe(layers * 3 * n * VERTICES_PER_EDGE * FLOATS_PER_VERTEX);
  });

  it("Mehrfachauswahl (Wand + Decke) -> Summe der Einzelgeometrien", () => {
    const wallOnly = selectionHighlightLines(sampleProject, ["W2"], [], RGB);
    const ceilingOnly = selectionHighlightLines(sampleProject, [], ["C1"], RGB);
    const both = selectionHighlightLines(sampleProject, ["W2"], ["C1"], RGB);
    expect(both.length).toBe(wallOnly.length + ceilingOnly.length);
  });

  it("mehrere gewählte Wände -> Kantenzahl skaliert linear", () => {
    const one = selectionHighlightLines(sampleProject, ["W2"], [], RGB);
    const two = selectionHighlightLines(sampleProject, ["W2", "W4"], [], RGB);
    expect(two.length).toBe(one.length * 2);
  });

  it("Öffnungen allein multiplizieren die Bänder NICHT (ein Körper je Schicht-Band mit Löchern)", () => {
    // 3D-Pfad (layered=true): eine Wand mit Öffnungen wird NICHT in Pfeiler/
    // Brüstung/Sturz zerlegt, sondern als EIN Körper pro Schicht-Band mit echten
    // Löchern emittiert — die Löcher fügen im Highlight keine Kanten hinzu.
    // Isoliert von Verschneidungen getestet: OHNE die Querwand W9 (deren T-Stoss
    // sonst die innerste Putzschicht von W1 span-cutout-splittet, s. eigener
    // Test unten) hat W1 (Tür D1 + Fenster O1) dieselbe Bänder-Zahl wie die
    // öffnungslose Wand W2 desselben Typs "aw" — die Löcher fügen keine Körper
    // hinzu. Beide stehen unter der Geschossdecke C1, deren Beton-Schicht (100)
    // den Backstein (50) im z-Band [2.3,2.5] spaltet -> 5 Körper (per-Schicht-
    // Decken-Dominanz, s. Backstein-Boxen [0,2.3] + [2.5,2.6]).
    const noW9: Project = { ...sampleProject, walls: sampleProject.walls.filter((w) => w.id !== "W9") };
    const w1 = selectionHighlightLines(noW9, ["W1"], [], RGB);
    const w2 = selectionHighlightLines(noW9, ["W2"], [], RGB);
    expect(w1.length).toBe(5 * 12 * VERTICES_PER_EDGE * FLOATS_PER_VERTEX);
    expect(w1.length).toBe(w2.length);
  });
});

describe("selectionHighlightLines — Kontext-Objekte", () => {
  // Ein einzelnes Dreieck als Kontext-Mesh (importiertes Gebäude): das
  // Highlight zeichnet dessen achsenparallele Bounding-Box (12 Kanten), NICHT
  // das volle Dreiecks-Wireframe (s. Kommentar in toWalls3d.ts).
  const withContext: Project = {
    ...sampleProject,
    context: [
      {
        id: "CTX1",
        type: "importedMesh",
        name: "Testgebäude",
        positions: [0, 0, 0, 2, 0, 0, 2, 3, 4],
        indices: [0, 1, 2],
      },
    ],
  };

  it("leere Kontext-Auswahl -> leeres Array", () => {
    const lines = selectionHighlightLines(withContext, [], [], RGB, [], [], [], []);
    expect(lines.length).toBe(0);
  });

  it("unbekannte Kontext-Id -> leeres Array", () => {
    const lines = selectionHighlightLines(withContext, [], [], RGB, [], [], [], ["does-not-exist"]);
    expect(lines.length).toBe(0);
  });

  it("ein Kontext-Objekt -> Bounding-Box-Umriss (12 Kanten)", () => {
    const lines = selectionHighlightLines(withContext, [], [], RGB, [], [], [], ["CTX1"]);
    expect(lines.length).toBe(12 * VERTICES_PER_EDGE * FLOATS_PER_VERTEX);
    expect(lines[3]).toBeCloseTo(RGB[0], 6);
    expect(lines[5]).toBeCloseTo(RGB[2], 6);
  });

  it("Kontext-Objekt zusammen mit einer Wand -> Summe der Einzelgeometrien", () => {
    const wallOnly = selectionHighlightLines(withContext, ["W2"], [], RGB);
    const ctxOnly = selectionHighlightLines(withContext, [], [], RGB, [], [], [], ["CTX1"]);
    const both = selectionHighlightLines(withContext, ["W2"], [], RGB, [], [], [], ["CTX1"]);
    expect(both.length).toBe(wallOnly.length + ctxOnly.length);
  });
});

describe("Öffnungen als echte Löcher in EINEM Körper (3D-Pfad, layeredWalls:true)", () => {
  // Wand W1 (EG, Wandtyp "aw" = 4 Schichten) mit ZWEI Fenstern, deren Achsen-
  // Intervalle sich ÜBERLAPPEN, aber auf UNTERSCHIEDLICHER Höhe liegen:
  //   Fenster A: u=[1.0,2.0] (position 1.0, width 1.0), z=[0.9,2.1] (sill 0.9, h 1.2)
  //   Fenster B: u=[1.5,2.5] (position 1.5, width 1.0), z=[0.3,0.7] (sill 0.3, h 0.4)
  // Die alte Segment-Zerlegung kann diesen versetzt-überlappenden Fall nicht
  // abbilden; als Löcher in EINEM Körper müssen beide sauber als `holes`
  // erscheinen. W1: start (0,0)->(5,0), floor "eg" (baseElevation 0).
  const twoOffsetWindows: Project = {
    ...sampleProject,
    doors: [],
    openings: [
      {
        id: "WA",
        type: "opening",
        hostWallId: "W1",
        categoryCode: "21",
        kind: "window",
        position: 1.0,
        width: 1.0,
        height: 1.2,
        sillHeight: 0.9,
      },
      {
        id: "WB",
        type: "opening",
        hostWallId: "W1",
        categoryCode: "21",
        kind: "window",
        position: 1.5,
        width: 1.0,
        height: 0.4,
        sillHeight: 0.3,
      },
    ],
  };

  it("layered=true: BEIDE Fenster als holes je Band, Loch-Positionen bleiben nach Join-Rebase korrekt", () => {
    const w1 = projectToWalls3d(twoOffsetWindows, true).filter((w) => w.wallId === "W1");
    // W1 ist Durchgangswand für die Querwand W9 (T-Stoss): die innerste Putz-
    // schicht wird durch den Span-Cutout entlang der Achse in ZWEI Teilstücke
    // gebrochen. NEU (per-Schicht-Decken-Dominanz): W1 steht unter der Decke C1,
    // deren Beton (100) den Backstein (50) im z-Band [2.3,2.5] spaltet -> der
    // Backstein kommt als ZWEI Boxen [0,2.3] + [2.5,2.6]. Die obere Backstein-Box
    // liegt ÜBER beiden Fenstern (z ≤ 2.1) und trägt daher KEINE Löcher.
    // Körper gesamt: render-ext(1) + insulation(1) + brick[0,2.3](1) +
    // brick[2.5,2.6](1, ohne Loch) + render-int-Span(2) = 6.
    expect(w1.length).toBe(6);
    // Nur die Körper, die die Fenster-z-Bänder schneiden, tragen Löcher (5 Stück);
    // die obere Backstein-Box (über den Fenstern) hat keine.
    const withHoles = w1.filter((b) => b.holes && b.holes.length > 0);
    expect(withHoles.length).toBe(5);
    // W1-Achse: (0,0)->(5,0), u=(1,0) -> Box-Achsenstart = box.start[0]. Die Loch-
    // Achsenkoordinaten sind je Körper auf DESSEN Box-Start rebased; die ABSOLUTE
    // Position (Box-Start + from) muss wieder exakt auf den Öffnungs-Intervallen liegen.
    for (const body of withHoles) {
      expect(body.holes).toBeDefined();
      expect(body.holes!.length).toBe(2);
      const axis0 = body.start[0];
      const byFrom = [...body.holes!].sort((a, b) => a.from - b.from);
      // Fenster A: u=[1,2], z=[0.9,2.1] (absolut rekonstruiert).
      expect(axis0 + byFrom[0].from).toBeCloseTo(1.0, 6);
      expect(axis0 + byFrom[0].to).toBeCloseTo(2.0, 6);
      expect(byFrom[0].zBottom).toBeCloseTo(0.9, 6);
      expect(byFrom[0].zTop).toBeCloseTo(2.1, 6);
      // Fenster B: u=[1.5,2.5], z=[0.3,0.7] — überlappt A in u, liegt tiefer.
      expect(axis0 + byFrom[1].from).toBeCloseTo(1.5, 6);
      expect(axis0 + byFrom[1].to).toBeCloseTo(2.5, 6);
      expect(byFrom[1].zBottom).toBeCloseTo(0.3, 6);
      expect(byFrom[1].zTop).toBeCloseTo(0.7, 6);
    }
  });

  it("layered=false (Schnitt-Pfad): unverändert segmentiert, KEINE holes", () => {
    const w1 = projectToWalls3d(twoOffsetWindows, false).filter((w) => w.wallId === "W1");
    // Der Schnitt-Pfad zerlegt weiter in Pfeiler/Brüstung/Sturz-Segmente (mehr
    // Boxen als die 4 Schicht-Bänder des 3D-Pfads) und setzt NIE `holes`.
    expect(w1.length).toBeGreaterThan(4);
    for (const seg of w1) expect(seg.holes).toBeUndefined();
  });

  it("Tür = Loch bis zur Wand-UK (zBottom == baseElevation)", () => {
    // Eine Tür (D1 auf W1) muss im 3D-Pfad als Loch bis zum Boden erscheinen:
    // zBottom des Lochs == Wand-UK (0), NICHT ab einer Brüstung.
    const p: Project = { ...sampleProject, openings: [] };
    const w1 = projectToWalls3d(p, true).filter((w) => w.wallId === "W1");
    // W1 ist Durchgangswand für W9 (T-Stoss) -> innerste Putzschicht span-cutout-
    // gebrochen. Zusätzlich spaltet die Decke C1 (Beton 100) den Backstein (50) im
    // z-Band [2.3,2.5] -> obere Backstein-Box [2.5,2.6] ohne Loch. Körper: render-ext
    // + insulation + brick[0,2.3] + brick[2.5,2.6] + render-int-Span(2) = 6.
    expect(w1.length).toBe(6);
    // Der erste Körper (Aussenputz-Band, volle Achse) trägt die Tür als Loch bis UK.
    const door = w1[0].holes?.find((h) => h.zBottom < 1e-6);
    expect(door).toBeDefined();
    expect(door!.zBottom).toBeCloseTo(0, 6); // Loch bis zur Wand-UK.
  });
});

describe("Bauteil-/Materialfarbe statt Einheits-Grau (Wände + Decken)", () => {
  it("Wand -> je Materiallage eine Box in ihrer Component-Farbe (Option B)", () => {
    // Wandtyp "aw" (s. sampleProject) hat 4 Schichten mit eigenen Farben:
    //   render-ext 0.02 #d8d2c7, insulation 0.16 #ffffff,
    //   brick 0.15 #8c5544, render-int 0.015 #efece6  (Σ = 0.345 m).
    // W2 ist öffnungslos, steht aber unter der Geschossdecke C1: die Beton-Schicht
    // (100) spaltet den Backstein (50) im z-Band [2.3,2.5] -> der Backstein kommt
    // als ZWEI Boxen [0,2.3] + [2.5,2.6] (per-Schicht-Decken-Dominanz), die drei
    // übrigen Bänder je 1 Box = 5 Boxen. Die Farbzuordnung je Schicht bleibt.
    const walls = projectToWalls3d(sampleProject);
    const w2 = walls.filter((w) => w.wallId === "W2");
    expect(w2.length).toBe(5);

    // Alle Schicht-Boxen tragen die gemeinsame wallId (Klick selektiert ganze Wand)
    // und sind Vollkörper (layers leer -> render3d zeichnet in `color`).
    for (const seg of w2) {
      expect(seg.wallId).toBe("W2");
      expect(seg.layers.length).toBe(0);
    }

    // Die vier Materialfarben kommen vor; der Backstein (#8c5544) zweimal (gespalten).
    const hex = (c: [number, number, number]) =>
      c.map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("");
    const colors = w2.map((s) => hex(s.color)).sort();
    expect(colors).toEqual(["8c5544", "8c5544", "d8d2c7", "efece6", "ffffff"]);
    expect([...new Set(colors)].sort()).toEqual(["8c5544", "d8d2c7", "efece6", "ffffff"]);

    // Die Schichtdicken (je EINDEUTIGEM Querversatz, damit die gespaltene Backstein-
    // Box nur EINMAL zählt) summieren zur Gesamt-Wanddicke (keine Lücken/Overlaps).
    const byOffset = new Map<number, number>();
    for (const seg of w2) byOffset.set(Math.round((seg.start[0] - 5) * 1e6) / 1e6, seg.thickness);
    const totalT = [...byOffset.values()].reduce((s, t) => s + t, 0);
    expect(totalT).toBeCloseTo(0.345, 6);
  });

  it("Schicht-Offsets kacheln die Wanddicke lückenlos um die Achse", () => {
    // W2-Achse (5,0)->(5,4): u=(0,1), Normale n=(1,0) -> der Schicht-Versatz
    // wirkt rein auf x (Box-Start.x = 5 + offset). Sortiert man die Boxen nach
    // Versatz, müssen sich benachbarte Flächen exakt berühren und der Stapel
    // symmetrisch um die Achse liegen: min = -T/2, max = +T/2.
    // Nach EINDEUTIGEM Querversatz zusammenfassen: der unter der Decke gespaltene
    // Backstein ([0,2.3] + [2.5,2.6]) liegt zweimal am SELBEN Versatz vor und darf
    // die Dicken-Bilanz nicht doppelt zählen (per-Schicht-Decken-Dominanz).
    const w2raw = projectToWalls3d(sampleProject).filter((w) => w.wallId === "W2");
    const byOffset = new Map<number, number>();
    for (const s of w2raw) byOffset.set(Math.round((s.start[0] - 5) * 1e6) / 1e6, s.thickness);
    const bands = [...byOffset.entries()]
      .map(([offset, t]) => ({ offset, t }))
      .sort((a, b) => a.offset - b.offset);
    const T = bands.reduce((s, b) => s + b.t, 0);
    expect(bands[0].offset - bands[0].t / 2).toBeCloseTo(-T / 2, 6);
    expect(bands[bands.length - 1].offset + bands[bands.length - 1].t / 2).toBeCloseTo(T / 2, 6);
    for (let i = 1; i < bands.length; i++) {
      // Oberkante der Vorlage == Unterkante der nächsten (keine Lücke/Overlap).
      expect(bands[i - 1].offset + bands[i - 1].t / 2).toBeCloseTo(bands[i].offset - bands[i].t / 2, 6);
    }
  });

});

describe("Fenster-Glasscheiben (emitOpeningGlass)", () => {
  it("1 Fenster + 1 Tür -> 2 Glas-Meshes (Typ 'window-standard' = Zweifachverglasung) mit korrekter vertikaler Ausdehnung", () => {
    // Sample-Projekt auf EINE Öffnung (Fenster O1) + EINE Tür (D1) reduzieren,
    // beide auf W1 (EG, baseElevation 0). Kontext ist leer -> `meshes` enthält
    // ausschliesslich die Glasscheiben.
    //
    // ANGEPASST (glazingPanes-Feature): O1 referenziert den Typ "window-standard"
    // (`glazing: "zweifach"` -> `glazingPanesOf` = 2). `glassPanesForOpening`
    // zeichnet jetzt render-wirksam so viele Scheiben, statt wie bisher immer
    // fix EINE — bewusste, korrekte Verhaltensänderung (Aufgabe: 2D/3D-Renderer
    // sollen die neuen Fenster-Verglasungsfelder konsumieren).
    const p: Project = {
      ...sampleProject,
      openings: (sampleProject.openings ?? []).filter((o) => o.id === "O1"),
      doors: sampleProject.doors,
      context: [],
    };
    const { meshes } = projectToModel3d(p);
    // `meshes` enthält jetzt auch die glatte Betontreppen-Laufplatte (ST1, Mesh);
    // die Glasscheiben tragen die bläuliche Glasfarbe → danach filtern.
    const glassMeshes = meshes.filter(
      (m) => m.color[0] === 0.62 && m.color[1] === 0.76 && m.color[2] === 0.85,
    );
    expect(glassMeshes.length).toBe(2);
    // Vertikale Ausdehnung (z = 3. Komponente jeder Ecke, MODELL-Höhe) — BEIDE
    // Scheiben sitzen INNERHALB desselben Rahmens (Schwelle/Sturz ziehen je
    // frameWidth ab): O1 sillHeight 0.9, height 1.2, Wand-UK 0 -> Öffnung UK
    // 0.9 .. OK 2.1, Rahmen 0.06 -> Scheiben 0.96 .. 2.04.
    for (const glass of glassMeshes) {
      // Quader: 8 Ecken (24 Floats) + 12 Dreiecke (36 Indizes), leicht bläuliches Glas.
      expect(glass.positions.length).toBe(24);
      expect(glass.indices.length).toBe(36);
      expect(glass.color).toEqual([0.62, 0.76, 0.85]);
      const zs: number[] = [];
      for (let i = 2; i < glass.positions.length; i += 3) zs.push(glass.positions[i]);
      expect(Math.min(...zs)).toBeCloseTo(0.96, 6);
      expect(Math.max(...zs)).toBeCloseTo(2.04, 6);
    }
    // Quer zur Wand (y-Achse, da W1 entlang x läuft) sitzen die beiden Scheiben
    // MIT Luftraum versetzt (Isolierverglasung) — sie überlappen sich nicht.
    const yRange = (m: { positions: number[] }): { min: number; max: number } => {
      let min = Infinity;
      let max = -Infinity;
      for (let i = 1; i < m.positions.length; i += 3) {
        min = Math.min(min, m.positions[i]);
        max = Math.max(max, m.positions[i]);
      }
      return { min, max };
    };
    const [a, b] = glassMeshes.map(yRange).sort((r1, r2) => r1.min - r2.min);
    expect(a.max).toBeLessThanOrEqual(b.min + 1e-9);
  });

  it("Türen bekommen keine Scheibe; je Fenster genau 2 (window-standard = zweifach verglast)", () => {
    // Volles Sample-Projekt: 2 Fenster (O1, O2, beide Typ "window-standard" =
    // Zweifachverglasung) + 1 Tür (D1), Kontext leer. Neben den Glasscheiben
    // liegt jetzt auch das Betontreppen-Mesh in `meshes` → nach Glasfarbe
    // filtern: 2 Fenster × 2 Scheiben = 4, Tür ohne Scheibe.
    const { meshes } = projectToModel3d(sampleProject);
    const glassMeshes = meshes.filter(
      (m) => m.color[0] === 0.62 && m.color[1] === 0.76 && m.color[2] === 0.85,
    );
    expect(glassMeshes.length).toBe(4);
  });

  it("glazingPanes: 3 erzeugt mehr Glas-Meshes als glazingPanes: 1 (glazingPanesOf)", () => {
    const glassMeshCount = (glazingPanes: 1 | 2 | 3): number => {
      const p: Project = {
        ...sampleProject,
        windowTypes: [
          {
            id: "win-panes-test",
            name: "Test Verglasung",
            kind: "fest",
            wingCount: 1,
            glazing: "einfach",
            glazingPanes,
            frameThickness: 0.06,
            frameWidth: 0.06,
            defaultSillHeight: 0.9,
            defaultWidth: 1.0,
            defaultHeight: 1.2,
          },
        ],
        openings: [
          {
            id: "OG",
            type: "opening",
            hostWallId: "W1",
            categoryCode: "21",
            kind: "window",
            typeId: "win-panes-test",
            position: 3.0,
            width: 1.0,
            height: 1.2,
            sillHeight: 0.9,
          },
        ],
        doors: [],
        context: [],
      };
      const { meshes } = projectToModel3d(p);
      return meshes.filter((m) => m.color[0] === 0.62 && m.color[1] === 0.76 && m.color[2] === 0.85)
        .length;
    };
    expect(glassMeshCount(1)).toBe(1);
    expect(glassMeshCount(3)).toBe(3);
    expect(glassMeshCount(3)).toBeGreaterThan(glassMeshCount(1));
  });
});

describe("Rahmen-/Sprossen-Riegel typisierter Öffnungen (emitOpeningFrames)", () => {
  // Farbfilter analog GLASS_RGB oben: FRAME_RGB (toWalls3d.ts) ist bewusst NICHT
  // exportiert -> Tests filtern per Literalwert, wie es der bestehende Glas-Test
  // schon für GLASS_RGB tut.
  const isFrame = (m: { color: [number, number, number] }): boolean =>
    m.color[0] === 0.85 && m.color[1] === 0.85 && m.color[2] === 0.83;
  const isGlass = (m: { color: [number, number, number] }): boolean =>
    m.color[0] === 0.62 && m.color[1] === 0.76 && m.color[2] === 0.85;
  const zRange = (m: { positions: number[] }): { min: number; max: number } => {
    const zs: number[] = [];
    for (let i = 2; i < m.positions.length; i += 3) zs.push(m.positions[i]);
    return { min: Math.min(...zs), max: Math.max(...zs) };
  };

  it("typisiertes Fenster (O1, Typ window-standard) -> Rahmen-Riegel mit endlichen Positionen innerhalb der Öffnungshöhe", () => {
    // O1: sillHeight 0.9, height 1.2 -> Öffnung UK 0.9 .. OK 2.1. Typ "window-
    // standard" hat wingCount 1, kein mullionRows/transomHeight -> 4 Basis-Riegel
    // (2 Pfosten + Sturz + Schwelle). "drehkipp" ist ÖFFENBAR -> zusätzlich ein
    // Flügelrahmen-Ring (4 Riegel) im Blendrahmen = 8 Riegel gesamt (fein).
    const p: Project = {
      ...sampleProject,
      openings: (sampleProject.openings ?? []).filter((o) => o.id === "O1"),
      doors: [],
      context: [],
    };
    const { meshes } = projectToModel3d(p);
    const frames = meshes.filter(isFrame);
    expect(frames.length).toBe(8);
    for (const f of frames) {
      expect(f.positions.every((v) => Number.isFinite(v))).toBe(true);
      const { min, max } = zRange(f);
      expect(min).toBeGreaterThanOrEqual(0.9 - 1e-6);
      expect(max).toBeLessThanOrEqual(2.1 + 1e-6);
    }
  });

  it("Detailgrad steuert Rahmen/Sprossen im 3D (grob=0, mittel=Rahmen+Flügel, fein=+Mittelpfosten+Sprossen)", () => {
    // O1 mit erzwungenem wingCount 2 (window-standard "drehkipp", öffenbar).
    const o1 = (sampleProject.openings ?? []).find((o) => o.id === "O1");
    if (!o1) throw new Error("O1 fehlt im sampleProject");
    const p: Project = {
      ...sampleProject,
      openings: [{ ...o1, wingCount: 2 }],
      doors: [],
      context: [],
    };
    const frameCount = (detail: "grob" | "mittel" | "fein"): number =>
      projectToModel3d(p, { detail }).meshes.filter(isFrame).length;
    expect(frameCount("grob")).toBe(0); // keine Rahmen/Sprossen
    // mittel: 4 Basis (2 Pfosten + Sturz + Schwelle) + 2 öffenbare Flügel × 4
    // verschachtelte Flügelrahmen-Riegel = 4 + 8 = 12 (keine Mittelpfosten/Sprossen).
    expect(frameCount("mittel")).toBe(12);
    // fein: mittel + 1 Flügel-Mittelpfosten (wingCount 2) = 12 + 1 = 13.
    expect(frameCount("fein")).toBe(13);
  });

  it("transomHeight > 0 -> zusätzlicher Kämpfer-Riegel + zweite Glasscheibe im Oberlicht-Band", () => {
    const p: Project = {
      ...sampleProject,
      windowTypes: [
        ...(sampleProject.windowTypes ?? []),
        {
          id: "win-transom-test",
          name: "Test Oberlicht",
          kind: "fest",
          wingCount: 1,
          glazing: "einfach",
          frameThickness: 0.06,
          frameWidth: 0.06,
          transomHeight: 0.4,
          defaultSillHeight: 0.9,
          defaultWidth: 1.0,
          defaultHeight: 1.2,
        },
      ],
      openings: [
        {
          id: "OT",
          type: "opening",
          hostWallId: "W1",
          categoryCode: "21",
          kind: "window",
          typeId: "win-transom-test",
          position: 3.0,
          width: 1.0,
          height: 1.2,
          sillHeight: 0.9,
        },
      ],
      doors: [],
      context: [],
    };
    const { meshes } = projectToModel3d(p);
    const frames = meshes.filter(isFrame);
    const glass = meshes.filter(isGlass);
    // 2 Pfosten + Sturz + Schwelle + Kämpfer = 5 Riegel (gegenüber 4 ohne Oberlicht).
    expect(frames.length).toBe(5);
    // Hauptscheibe (unterhalb des Kämpfers) + Oberlicht-Scheibe (oberhalb) = 2.
    expect(glass.length).toBe(2);
    // Kämpfer sitzt bei zTop - transomHeight = 2.1 - 0.4 = 1.7 und muss diese
    // Höhe im eigenen z-Intervall einschliessen.
    const splitZ = 1.7;
    const kaempfer = frames.find((f) => {
      const { min, max } = zRange(f);
      return min < splitZ && max > splitZ;
    });
    expect(kaempfer).toBeDefined();
    // Eine der beiden Scheiben liegt VOLLSTÄNDIG oberhalb des Kämpfers (Oberlicht).
    const hasUpperPane = glass.some((g) => zRange(g).min > splitZ);
    expect(hasUpperPane).toBe(true);
  });

  it("wingCount=2 + mullionRows=2 -> je ein zusätzlicher Mittelpfosten (vertikal) und Kämpfer (horizontal)", () => {
    // Baseline: FESTES Einzelfenster (kein Flügelrahmen), damit nur die
    // Mittelpfosten/Kämpfer den Unterschied ausmachen (nicht die Flügelrahmen
    // öffenbarer Flügel). Beide Typen "fest".
    const baseline: Project = {
      ...sampleProject,
      windowTypes: [
        ...(sampleProject.windowTypes ?? []),
        {
          id: "win-fixed-base",
          name: "Test Fest 1-flg",
          kind: "fest",
          wingCount: 1,
          mullionRows: 1,
          glazing: "einfach",
          frameThickness: 0.06,
          frameWidth: 0.06,
          defaultSillHeight: 0.9,
          defaultWidth: 1.0,
          defaultHeight: 1.2,
        },
      ],
      openings: [
        {
          id: "OB",
          type: "opening",
          hostWallId: "W1",
          categoryCode: "21",
          kind: "window",
          typeId: "win-fixed-base",
          position: 3.0,
          width: 1.0,
          height: 1.2,
          sillHeight: 0.9,
        },
      ],
      doors: [],
      context: [],
    };
    const withMullions: Project = {
      ...sampleProject,
      windowTypes: [
        ...(sampleProject.windowTypes ?? []),
        {
          id: "win-mullion-test",
          name: "Test Fenster 2-flg",
          kind: "fest",
          wingCount: 2,
          mullionRows: 2,
          glazing: "einfach",
          frameThickness: 0.06,
          frameWidth: 0.06,
          defaultSillHeight: 0.9,
          defaultWidth: 1.0,
          defaultHeight: 1.2,
        },
      ],
      openings: [
        {
          id: "OB",
          type: "opening",
          hostWallId: "W1",
          categoryCode: "21",
          kind: "window",
          typeId: "win-mullion-test",
          position: 3.0,
          width: 1.0,
          height: 1.2,
          sillHeight: 0.9,
        },
      ],
      doors: [],
      context: [],
    };
    const baselineFrames = projectToModel3d(baseline).meshes.filter(isFrame);
    const withMullionsFrames = projectToModel3d(withMullions).meshes.filter(isFrame);
    // Mit den Mittelpfosten (wingCount-1) und Kämpfern (mullionRows-1):
    //   1 Flügelpfosten (wingCount−1)
    //   1 Kämpfer (mullionRows−1)
    // → zusammen 2 Riegel mehr als Basis (1×1 =1).
    expect(withMullionsFrames.length).toBe(baselineFrames.length + 2);
  });

  it("wingCount=2 + mullionCols=2 -> je ein zusätzlicher Sprossen-Spalte", () => {
    // Test um mullionCols zu prüfen (analog obigem mullionRows-Test).
    const baseline: Project = {
      ...sampleProject,
      windowTypes: [
        ...(sampleProject.windowTypes ?? []),
        {
          id: "win-fixed-base",
          name: "Test Fest 1-flg",
          kind: "fest",
          wingCount: 1,
          mullionCols: 1,
          glazing: "einfach",
          frameThickness: 0.06,
          frameWidth: 0.06,
          defaultSillHeight: 0.9,
          defaultWidth: 1.0,
          defaultHeight: 1.2,
        },
      ],
      openings: [
        {
          id: "OB",
          type: "opening",
          hostWallId: "W1",
          categoryCode: "21",
          kind: "window",
          typeId: "win-fixed-base",
          position: 3.0,
          width: 1.0,
          height: 1.2,
          sillHeight: 0.9,
        },
      ],
      doors: [],
      context: [],
    };
    const withMullions: Project = {
      ...sampleProject,
      windowTypes: [
        ...(sampleProject.windowTypes ?? []),
        {
          id: "win-mullion-test",
          name: "Test Fest 1-flg mit Sprossen-Spalte",
          kind: "fest",
          wingCount: 1,
          mullionCols: 2,
          glazing: "einfach",
          frameThickness: 0.06,
          frameWidth: 0.06,
          defaultSillHeight: 0.9,
          defaultWidth: 1.0,
          defaultHeight: 1.2,
        },
      ],
      openings: [
        {
          id: "OB",
          type: "opening",
          hostWallId: "W1",
          categoryCode: "21",
          kind: "window",
          typeId: "win-mullion-test",
          position: 3.0,
          width: 1.0,
          height: 1.2,
          sillHeight: 0.9,
        },
      ],
      doors: [],
      context: [],
    };
    const baselineFrames = projectToModel3d(baseline).meshes.filter(isFrame);
    const withMullionsFrames = projectToModel3d(withMullions).meshes.filter(isFrame);
    // wingCount bleibt in beiden Fällen 1 (isoliert den mullionCols-Effekt von
    // wingCount, s. separater Mittelpfosten-Test oben): nur die Sprossen-Spalte
    // (mullionCols−1) macht den Unterschied -> 1 Riegel mehr als Basis.
    expect(withMullionsFrames.length).toBe(baselineFrames.length + 1);
  });

  it("öffenbarer Flügel bekommt einen Flügelrahmen-Ring (4 Riegel) im 3D; fest keinen", () => {
    // Gleiches Fenster einmal 'fest', einmal 'dreh' (öffenbar). Der öffenbare
    // Flügel erzeugt zusätzlich einen Flügelrahmen-Ring (4 Riegel) INNERHALB des
    // Blendrahmens (Schachtelung Blendrahmen → Flügelrahmen → Glas).
    const win = (kind: "fest" | "dreh"): Project => ({
      ...sampleProject,
      windowTypes: [
        {
          id: "win-sash-test",
          name: `Test ${kind}`,
          kind,
          wingCount: 1,
          glazing: "einfach",
          frameThickness: 0.06,
          frameWidth: 0.06,
          defaultSillHeight: 0.9,
          defaultWidth: 1.0,
          defaultHeight: 1.2,
        },
      ],
      openings: [
        {
          id: "OSF",
          type: "opening",
          hostWallId: "W1",
          categoryCode: "21",
          kind: "window",
          typeId: "win-sash-test",
          position: 3.0,
          width: 1.0,
          height: 1.2,
          sillHeight: 0.9,
        },
      ],
      doors: [],
      context: [],
    });
    const fixedCount = projectToModel3d(win("fest")).meshes.filter(isFrame).length;
    const operableCount = projectToModel3d(win("dreh")).meshes.filter(isFrame).length;
    expect(fixedCount).toBe(4); // nur Blendrahmen (2 Pfosten + Sturz + Schwelle)
    expect(operableCount).toBe(8); // + 4 Flügelrahmen-Riegel
  });

  it("Glastür mit glazingRatio < 1: Glas nur im oberen Blattanteil (Teilverglasung)", () => {
    const glassDoor = (glazingRatio?: number): Project => ({
      ...sampleProject,
      doorTypes: [
        {
          id: "dt-glass",
          name: "Glastür Test",
          kind: "dreh",
          leafCount: 1,
          leafStyle: "glas",
          glazingRatio,
          frameThickness: 0.06,
          frameWidth: 0.06,
          defaultWidth: 0.9,
          defaultHeight: 2.0,
        },
      ],
      openings: [
        {
          id: "DG",
          type: "opening",
          hostWallId: "W1",
          categoryCode: "21",
          kind: "door",
          typeId: "dt-glass",
          position: 3.0,
          width: 0.9,
          height: 2.0,
          sillHeight: 0,
        },
      ],
      doors: [],
      context: [],
    });
    // Vollglas (ratio 1 / fehlt): Glas über (fast) die ganze Blatthöhe.
    const full = projectToModel3d(glassDoor(1)).meshes.filter(isGlass);
    expect(full.length).toBe(1);
    const fullR = zRange(full[0]);
    // Halbglas (ratio 0.5): Glas nur in der oberen Hälfte -> Unterkante deutlich höher.
    const half = projectToModel3d(glassDoor(0.5)).meshes.filter(isGlass);
    expect(half.length).toBe(1);
    const halfR = zRange(half[0]);
    expect(halfR.max).toBeCloseTo(fullR.max, 6); // Oberkante gleich (an OK/Sturz)
    expect(halfR.min).toBeGreaterThan(fullR.min + 0.5); // Unterkante klar angehoben
  });

  it("insetFromFace verschiebt Rahmen-Position entlang der Wand-Normalen gegenüber bündig (kein Einzug)", () => {
    // W1-Achse (0,0)->(5,0): u=(1,0) -> Normale n=(0,-1); der Quer-Versatz
    // bildet sich rein in der Y-Koordinate ab (y = -t). insetFromFace 0.1 muss
    // die Rahmen-Aussenkante (min y, s. resolveFrameNormalRange) um ~0.1 m
    // gegenüber bündig (insetFromFace 0) verschieben.
    const flushWindow = (project: Project): Project => ({
      ...project,
      windowTypes: [
        ...(project.windowTypes ?? []),
        {
          id: "win-flush-test",
          name: "Test bündig",
          kind: "fest",
          wingCount: 1,
          glazing: "einfach",
          frameThickness: 0.06,
          frameWidth: 0.06,
          insetFromFace: 0,
          insetFace: "aussen",
          defaultSillHeight: 0.9,
          defaultWidth: 1.0,
          defaultHeight: 1.2,
        },
      ],
    });
    const insetWindow = (project: Project): Project => ({
      ...project,
      windowTypes: [
        ...(project.windowTypes ?? []),
        {
          id: "win-inset-test",
          name: "Test Schichteinzug",
          kind: "fest",
          wingCount: 1,
          glazing: "einfach",
          frameThickness: 0.06,
          frameWidth: 0.06,
          insetFromFace: 0.1,
          insetFace: "aussen",
          defaultSillHeight: 0.9,
          defaultWidth: 1.0,
          defaultHeight: 1.2,
        },
      ],
    });
    const openingWithType = (typeId: string): Project["openings"] => [
      {
        id: "OI",
        type: "opening",
        hostWallId: "W1",
        categoryCode: "21",
        kind: "window",
        typeId,
        position: 3.0,
        width: 1.0,
        height: 1.2,
        sillHeight: 0.9,
      },
    ];
    const pFlush: Project = { ...flushWindow(sampleProject), openings: openingWithType("win-flush-test"), doors: [], context: [] };
    const pInset: Project = { ...insetWindow(sampleProject), openings: openingWithType("win-inset-test"), doors: [], context: [] };

    const minY = (meshes: { positions: number[]; color: [number, number, number] }[]): number => {
      let m = Infinity;
      for (const mesh of meshes.filter(isFrame)) {
        for (let i = 1; i < mesh.positions.length; i += 3) m = Math.min(m, mesh.positions[i]);
      }
      return m;
    };
    const flushMinY = minY(projectToModel3d(pFlush).meshes);
    const insetMinY = minY(projectToModel3d(pInset).meshes);
    // Bündig sitzt die Rahmen-Aussenkante weiter aussen (negativeres y); mit
    // Einzug rückt sie um insetFromFace (0.1 m) Richtung Wandmitte (grösseres y).
    expect(insetMinY - flushMinY).toBeCloseTo(0.1, 6);
  });

  it("Öffnung ohne auflösbaren Typ -> KEIN Rahmen-Mesh (Rückwärtskompatibilität)", () => {
    const p: Project = {
      ...sampleProject,
      openings: [
        {
          id: "OX",
          type: "opening",
          hostWallId: "W1",
          categoryCode: "21",
          kind: "window",
          // Kein typeId -> kein auflösbarer WindowType.
          position: 3.0,
          width: 1.0,
          height: 1.2,
          sillHeight: 0.9,
        },
      ],
      doors: [],
      context: [],
    };
    const { meshes } = projectToModel3d(p);
    expect(meshes.some(isFrame)).toBe(false);
    // Alt-Verhalten bleibt unverändert: weiterhin genau EINE Vollscheibe.
    expect(meshes.filter(isGlass).length).toBe(1);
  });
});

describe("VW-fein-Öffnungsdetails: Fensterbank, DIN-Symbole, verschachtelte Flügelrahmen, Zargen-Umgriff", () => {
  const isFrame = (m: { color: [number, number, number] }): boolean =>
    m.color[0] === 0.85 && m.color[1] === 0.85 && m.color[2] === 0.83;
  // SILL_RGB [0.8,0.8,0.78] und SYMBOL_RGB [0.25,0.27,0.3] sind bewusst nicht
  // exportiert -> Filter per Literalwert, wie bei GLASS_RGB/FRAME_RGB.
  const isSill = (m: { color: [number, number, number] }): boolean =>
    m.color[0] === 0.8 && m.color[1] === 0.8 && m.color[2] === 0.78;
  const isSymbol = (m: { color: [number, number, number] }): boolean =>
    m.color[0] === 0.25 && m.color[1] === 0.27 && m.color[2] === 0.3;

  // Ein Fenster (O1-Geometrie) mit gegebenem Fenstertyp auf W1.
  const winProject = (
    wt: NonNullable<Project["windowTypes"]>[number],
  ): Project => ({
    ...sampleProject,
    windowTypes: [...(sampleProject.windowTypes ?? []), wt],
    openings: [
      {
        id: "OS",
        type: "opening",
        hostWallId: "W1",
        categoryCode: "21",
        kind: "window",
        typeId: wt.id,
        position: 3.0,
        width: 1.0,
        height: 1.2,
        sillHeight: 0.9,
      },
    ],
    doors: [],
    context: [],
  });

  const baseWin = {
    id: "win-detail-test",
    name: "Test Detail",
    kind: "fest" as const,
    wingCount: 1,
    glazing: "einfach" as const,
    frameThickness: 0.06,
    frameWidth: 0.06,
    defaultSillHeight: 0.9,
    defaultWidth: 1.0,
    defaultHeight: 1.2,
  };

  it("Fensterbank (Sims): 2 Bänder (Bank + Tropfkante) unter der Öffnung, Gating sillBoard + DetailLevel", () => {
    // Default (kein sillBoard) -> zeichnen (wie 2D-Ansicht): 2 Sims-Bänder.
    const pDefault = winProject({ ...baseWin });
    const sills = projectToModel3d(pDefault).meshes.filter(isSill);
    expect(sills.length).toBe(2);
    // Beide Bänder liegen UNTER der Öffnungs-UK (sillHeight 0.9).
    for (const s of sills) {
      for (let i = 2; i < s.positions.length; i += 3) {
        expect(s.positions[i]).toBeLessThanOrEqual(0.9 + 1e-6);
      }
    }
    // sillBoard-Gating: "keine"/"innen" -> keine Bank; "aussen"/"beide" -> Bank.
    const count = (sb: "keine" | "innen" | "aussen" | "beide"): number =>
      projectToModel3d(winProject({ ...baseWin, id: `win-sb-${sb}`, sillBoard: sb })).meshes.filter(isSill).length;
    expect(count("keine")).toBe(0);
    expect(count("innen")).toBe(0);
    expect(count("aussen")).toBe(2);
    expect(count("beide")).toBe(2);
    // DetailLevel: grob -> keine Bank; mittel/fein -> Bank.
    const byDetail = (detail: "grob" | "mittel" | "fein"): number =>
      projectToModel3d(pDefault, { detail }).meshes.filter(isSill).length;
    expect(byDetail("grob")).toBe(0);
    expect(byDetail("mittel")).toBe(2);
    expect(byDetail("fein")).toBe(2);
  });

  it("DIN-Öffnungssymbole: nur fein, nur je NICHT-festem Flügel; Dreh=V, Kipp=V, Dreh-Kipp=beide", () => {
    // Dreh-Kipp (öffenbar): Dreh (2 Diagonalen) + Kipp (2 Diagonalen) = 4 Symbol-Boxen.
    const pDrehkipp = winProject({ ...baseWin, id: "win-drehkipp", kind: "drehkipp" });
    expect(projectToModel3d(pDrehkipp).meshes.filter(isSymbol).length).toBe(4);
    // Dreh -> 2, Kipp -> 2.
    expect(
      projectToModel3d(winProject({ ...baseWin, id: "win-dreh", kind: "dreh" })).meshes.filter(isSymbol).length,
    ).toBe(2);
    expect(
      projectToModel3d(winProject({ ...baseWin, id: "win-kipp", kind: "kipp" })).meshes.filter(isSymbol).length,
    ).toBe(2);
    // Fest -> kein Symbol.
    expect(
      projectToModel3d(winProject({ ...baseWin, id: "win-fest2", kind: "fest" })).meshes.filter(isSymbol).length,
    ).toBe(0);
    // Symbole nur bei „fein" (mittel/grob: keine).
    expect(projectToModel3d(pDrehkipp, { detail: "mittel" }).meshes.filter(isSymbol).length).toBe(0);
    expect(projectToModel3d(pDrehkipp, { detail: "grob" }).meshes.filter(isSymbol).length).toBe(0);
    // Symbol-Boxen sind sehr dünn (endliche, gültige Positionen) und liegen im
    // Öffnungs-Höhenintervall (UK 0.9 .. OK 2.1).
    for (const sym of projectToModel3d(pDrehkipp).meshes.filter(isSymbol)) {
      expect(sym.positions.every((v) => Number.isFinite(v))).toBe(true);
      for (let i = 2; i < sym.positions.length; i += 3) {
        expect(sym.positions[i]).toBeGreaterThanOrEqual(0.9 - 1e-6);
        expect(sym.positions[i]).toBeLessThanOrEqual(2.1 + 1e-6);
      }
    }
  });

  it("Verschachtelter Flügelrahmen: ~5 mm zurückgesetztes Band, kein Vorstand vor den Blendrahmen", () => {
    // Fest vs. öffenbar, sonst identisch (flush, frameThickness gleich). Der
    // Flügelrahmen sitzt in einem ~5 mm HINTER die Blendrahmen-Vorderkante
    // (nMax) zurückgesetzten Band — er ragt also nirgends weiter nach aussen
    // als der Blendrahmen (kein Fassaden-Vorstand; bei W1 zeigt aussen in
    // Richtung negatives world-y, s. Inset-Test).
    const meshMinY = (mesh: { positions: number[] }): number => {
      let m = Infinity;
      for (let i = 1; i < mesh.positions.length; i += 3) m = Math.min(m, mesh.positions[i]);
      return m;
    };
    const frameMeshes = (p: Project) => projectToModel3d(p).meshes.filter(isFrame);
    const fixed = frameMeshes(winProject({ ...baseWin, id: "win-proud-fixed", kind: "fest", sillBoard: "keine" }));
    const open = frameMeshes(winProject({ ...baseWin, id: "win-proud-open", kind: "drehkipp", sillBoard: "keine" }));
    const blendFront = Math.min(...fixed.map(meshMinY));
    // Kein Vorstand: öffenbares Fenster reicht nicht weiter nach aussen.
    expect(Math.min(...open.map(meshMinY))).toBeCloseTo(blendFront, 6);
    // Die 4 zusätzlichen Flügelrahmen-Riegel liegen mit ihrer Vorderkante
    // exakt 5 mm hinter der Blendrahmen-Vorderkante (zurückgesetzte Stufe).
    const sashMeshes = open.filter((m) => meshMinY(m) > blendFront + 1e-6);
    expect(sashMeshes.length).toBe(4);
    for (const m of sashMeshes) expect(meshMinY(m)).toBeCloseTo(blendFront + 0.005, 6);
  });

  it("Türblatt: Vollblatt füllt das Feld, Teilverglasung nur den blinden Rest, Fenster nie", () => {
    const isLeaf = (m: { color: [number, number, number] }): boolean =>
      m.color[0] === 0.93 && m.color[1] === 0.9 && m.color[2] === 0.85;
    const doorProject = (dt: NonNullable<Project["doorTypes"]>[number]): Project => ({
      ...sampleProject,
      doorTypes: [dt],
      openings: [
        {
          id: "DL",
          type: "opening",
          hostWallId: "W1",
          categoryCode: "31",
          kind: "door",
          typeId: dt.id,
          position: 3.0,
          width: 0.9,
          height: 2.0,
          sillHeight: 0,
        },
      ],
      doors: [],
      context: [],
    });
    const baseDoor = {
      id: "door-leaf-test",
      name: "Blatt-Test",
      kind: "dreh" as const,
      leafCount: 1 as const,
      leafStyle: "glatt" as const,
      frameThickness: 0.05,
      frameWidth: 0.06,
      defaultWidth: 0.9,
      defaultHeight: 2.0,
    };
    const zTop = (meshes: { positions: number[] }[]): number => {
      let m = -Infinity;
      for (const mesh of meshes) for (let i = 2; i < mesh.positions.length; i += 3) m = Math.max(m, mesh.positions[i]);
      return m;
    };
    // Vollblatt (glatt): genau EIN Blatt-Panel, bis unter den Sturz (2.0 − fw).
    const solid = projectToModel3d(doorProject(baseDoor)).meshes.filter(isLeaf);
    expect(solid.length).toBe(1);
    expect(zTop(solid)).toBeCloseTo(2.0 - 0.06, 6);
    // Auch bei grob vorhanden (Füllung ist kein „fein"-Detail).
    expect(projectToModel3d(doorProject(baseDoor), { detail: "grob" }).meshes.filter(isLeaf).length).toBe(1);
    // Teilverglasung (glas, glazingRatio 0.4): Blatt nur im unteren 60%-Rest.
    const glazed = projectToModel3d(
      doorProject({ ...baseDoor, id: "door-leaf-glas", leafStyle: "glas", glazingRatio: 0.4 }),
    ).meshes.filter(isLeaf);
    expect(glazed.length).toBe(1);
    const fieldTop = 2.0 - 0.06;
    expect(zTop(glazed)).toBeCloseTo(fieldTop - 0.4 * fieldTop, 6);
    // Ganzglastür (glazingRatio 1): kein blinder Rest -> kein Blatt.
    expect(
      projectToModel3d(doorProject({ ...baseDoor, id: "door-leaf-vollglas", leafStyle: "glas" })).meshes.filter(isLeaf)
        .length,
    ).toBe(0);
    // Fenster: nie ein Blatt.
    expect(projectToModel3d(winProject({ ...baseWin, id: "win-no-leaf" })).meshes.filter(isLeaf).length).toBe(0);
  });

  it("Tür-Zarge mit Umgriff: zarge -> 6 Bekleidungs-Riegel mehr als blockrahmen", () => {
    const doorProject = (frameKind: "zarge" | "blockrahmen"): Project => ({
      ...sampleProject,
      doorTypes: [
        {
          id: `door-${frameKind}-test`,
          name: `Test ${frameKind}`,
          kind: "dreh",
          leafCount: 1,
          leafStyle: "glatt",
          frameThickness: 0.05,
          frameKind,
          frameWidth: 0.06,
          defaultWidth: 0.9,
          defaultHeight: 2.0,
        },
      ],
      openings: [
        {
          id: "DT",
          type: "opening",
          hostWallId: "W1",
          categoryCode: "31",
          kind: "door",
          typeId: `door-${frameKind}-test`,
          position: 3.0,
          width: 0.9,
          height: 2.0,
          sillHeight: 0,
        },
      ],
      doors: [],
      context: [],
    });
    const frames = (frameKind: "zarge" | "blockrahmen"): number =>
      projectToModel3d(doorProject(frameKind)).meshes.filter(isFrame).length;
    // Zarge: Basis-Rahmen (2 Pfosten + Sturz, kein threshold) + 2 Wandseiten × 3
    // Bekleidungs-Riegel = 3 + 6 = 9. Blockrahmen: nur Basis = 3.
    expect(frames("blockrahmen")).toBe(3);
    expect(frames("zarge")).toBe(9);
    // Umgriff nur mittel/fein, nicht grob.
    expect(projectToModel3d(doorProject("zarge"), { detail: "grob" }).meshes.filter(isFrame).length).toBe(0);
    expect(projectToModel3d(doorProject("zarge"), { detail: "mittel" }).meshes.filter(isFrame).length).toBe(9);
  });
});

describe("Per-Schicht-Decken-Dominanz Wand/Decke (3D-Entsprechung der Schnitt-Boolean-Dominanz)", () => {
  // Sample-Projekt: W1-W4 (EG, Wandtyp "aw": render-ext 10, insulation 20,
  // brick 50, render-int 10) tragen Wandhöhe 2.6 m = Geschosshöhe. Decke C1
  // (EG, Deckentyp "dg-massiv", dominante Schicht "concrete" joinPriority 100)
  // hat OK bündig mit dem Wandkopf (zTop 2.6), Gesamtdicke 0.3 m -> zBottom 2.3.
  //
  // ENTSCHEIDEND (Nutzer-Bug „Kranz durch die Dämmung"): C1.outline ist der
  // Raumgrundriss auf den WAND-ACHSEN ((0,0)-(5,0)-(5,4)-(0,4)) — die Decke liegt
  // also nur auf dem INNEREN Halbquerschnitt jeder Aussenwand. Für W2 (Achse x=5)
  // liegen die Bandmittellinien bei x = 5 − offset:
  //   render-ext  x=5.1625  (AUSSEN, x>5) -> NICHT überdeckt -> läuft durch
  //   insulation  x=5.0725  (AUSSEN)      -> NICHT überdeckt -> läuft durch
  //   brick       x=4.9175  (INNEN, x<5)  -> überdeckt -> Decken-z-Schnitt
  //   render-int  x=4.8350  (INNEN)       -> überdeckt -> Decken-z-Schnitt
  // Die Decke schneidet ein Band also nur dort, wo ihre Outline die Footprint-
  // Mittellinie DIESES Bandes überdeckt (geometrischer Überlapp wie
  // toSection.ts::subtractDominantBands) — NICHT mehr per wandweitem BBox-Test.
  // (Frühere Tests erwarteten hier „ALLE Schichten geschnitten"; das kodierte das
  // falsche BBox-Verhalten und ist die Ursache des 3D-Kranzes. Korrigiert.)
  it("Decke schneidet nur die von ihrer Outline überdeckten (inneren) Bänder; Dämmung/Aussenputz laufen durch; Beton spaltet den Backstein PER SCHICHT", () => {
    const w2 = projectToWalls3d(sampleProject).filter((w) => w.wallId === "W2");
    // PER-SCHICHT-Decken-Dominanz (identisch zu toSection.ts::subtractDominantBands):
    // jede Deckenschicht (screed 30 / insulation 20 / concrete 100) schneidet nur
    // Wandbänder mit STRIKT niedrigerer Priorität in IHREM z-Band. Der Backstein (50)
    // wird also NUR von der Beton-Schicht (100, z-Band [2.3,2.5]) gekappt und läuft
    // darüber bis zum Wandkopf (2.6) durch -> ZWEI Boxen. So schneidet er im Schnitt
    // die schwimmenden Deckenschichten Estrich/Dämmung über sich weg (Nutzer-Bug).
    const zBoxes = (t: number) =>
      w2.filter((s) => Math.abs(s.thickness - t) < 1e-6)
        .map((s) => [s.baseElevation, s.baseElevation + s.height] as const)
        .sort((a, b) => a[0] - b[0]);
    // brick: [0,2.3] (unter Beton) + [2.5,2.6] (über Beton, bis Wandkopf).
    const brick = zBoxes(0.15);
    expect(brick.length).toBe(2);
    expect(brick[0][1]).toBeCloseTo(2.3, 6); // endet an Beton-UK
    expect(brick[1][0]).toBeCloseTo(2.5, 6); // beginnt an Beton-OK
    expect(brick[1][1]).toBeCloseTo(2.6, 6); // läuft bis Wandkopf durch
    // render-int (10 < allen Deckenschichten): über [2.3,2.6] komplett gekappt -> [0,2.3].
    const renderInt = zBoxes(0.015);
    expect(renderInt.length).toBe(1);
    expect(renderInt[0][1]).toBeCloseTo(2.3, 6);
    // AUSSEN liegende Schichten (Mittellinie ausserhalb der Decken-Outline): KEIN
    // Schnitt -> volle Höhe (behobener „Kranz"-Bug, wie im 2D-Schnitt).
    expect(zBoxes(0.16)).toEqual([[0, 2.6]]); // insulation läuft durch
    expect(zBoxes(0.02)).toEqual([[0, 2.6]]); // render-ext (Aussenputz) läuft durch
    expect(w2.length).toBe(5); // render-ext + insulation + brick(2) + render-int
  });

  it("PER-SCHICHT: nur überdeckte Bänder mit < Decken-Priorität werden geschnitten (Kern >= Prio läuft durch)", () => {
    // Deckentyp-Priorität (concrete) auf 40 senken. Von den ÜBERDECKTEN (inneren)
    // Bändern läuft brick (50 > 40) jetzt bis zum Wandkopf (2.6) durch; render-int
    // (10 < 40) wird im Decken-z-Band [2.3,2.6] geschnitten -> endet bei 2.3. Die
    // AUSSEN liegenden Bänder (insulation, render-ext) sind ohnehin nicht überdeckt
    // und laufen unabhängig von der Priorität durch (2.6). Priorität ALLEIN genügt
    // also nicht — es braucht zusätzlich den geometrischen Überlapp (wie die
    // „gestaffelte Kette" in toSection.boolean.test.ts, wo Beton die Dämmung trotz
    // höherer Prio NICHT schneidet, weil sie sich nicht überlappen).
    const p: Project = {
      ...sampleProject,
      components: sampleProject.components.map((c) =>
        c.id === "concrete" ? { ...c, joinPriority: 40 } : c,
      ),
    };
    const w2 = projectToWalls3d(p).filter((w) => w.wallId === "W2");
    expect(w2.length).toBe(4); // je 1 Box pro Band (Wand ragt nicht über die Decke)
    const top = (t: number) => {
      const b = w2.find((s) => Math.abs(s.thickness - t) < 1e-6)!;
      return b.baseElevation + b.height;
    };
    expect(top(0.15)).toBeCloseTo(2.6, 6); // brick (überdeckt, 50 > 40) läuft durch
    expect(top(0.015)).toBeCloseTo(2.3, 6); // render-int (überdeckt, 10 < 40) geschnitten
    expect(top(0.16)).toBeCloseTo(2.6, 6); // insulation (nicht überdeckt) läuft durch
    expect(top(0.02)).toBeCloseTo(2.6, 6); // render-ext (nicht überdeckt) läuft durch
  });

  it("Wand ragt über die Decke: überdecktes dominiertes Band spaltet vertikal, Aussenschichten bleiben ungeteilt", () => {
    // W2 auf 3.0 m erhöhen (über Decken-OK 2.6) und concrete-Priorität auf 25
    // senken. Von den ÜBERDECKTEN Bändern spaltet render-int (10 < 25) vertikal in
    // ZWEI Boxen [0,2.3] + [2.6,3.0] (Decken-z-Band [2.3,2.6] ausgespart); brick
    // (50 > 25) läuft als EINE Box [0,3.0] durch. Die NICHT überdeckten Aussen-
    // schichten (insulation, render-ext) bleiben je EINE volle Box [0,3.0] — sie
    // werden NICHT vertikal aufgespalten (kein Kranz).
    const p: Project = {
      ...sampleProject,
      walls: sampleProject.walls.map((w) => (w.id === "W2" ? { ...w, height: 3.0 } : w)),
      components: sampleProject.components.map((c) =>
        c.id === "concrete" ? { ...c, joinPriority: 25 } : c,
      ),
    };
    const w2 = projectToWalls3d(p).filter((w) => w.wallId === "W2");
    // render-int 2 Boxen + brick/insulation/render-ext je 1 Box = 5 Boxen.
    expect(w2.length).toBe(5);
    const zRanges = (t: number) =>
      w2
        .filter((s) => Math.abs(s.thickness - t) < 1e-6)
        .map((s) => [s.baseElevation, s.baseElevation + s.height] as const)
        .sort((a, b) => a[0] - b[0]);
    // brick (überdeckt, 50 > 25): EINE durchgehende Box.
    const brick = zRanges(0.15);
    expect(brick.length).toBe(1);
    expect(brick[0][0]).toBeCloseTo(0, 6);
    expect(brick[0][1]).toBeCloseTo(3.0, 6);
    // render-int (überdeckt, 10 < 25): ZWEI Boxen unter/über der Decke.
    const renderInt = zRanges(0.015);
    expect(renderInt.length).toBe(2);
    expect(renderInt[0][0]).toBeCloseTo(0, 6);
    expect(renderInt[0][1]).toBeCloseTo(2.3, 6);
    expect(renderInt[1][0]).toBeCloseTo(2.6, 6);
    expect(renderInt[1][1]).toBeCloseTo(3.0, 6);
    // insulation (nicht überdeckt): EINE volle Box, KEIN vertikaler Split.
    const insul = zRanges(0.16);
    expect(insul.length).toBe(1);
    expect(insul[0][0]).toBeCloseTo(0, 6);
    expect(insul[0][1]).toBeCloseTo(3.0, 6);
    // render-ext (nicht überdeckt): ebenfalls EINE volle Box.
    const renderExt = zRanges(0.02);
    expect(renderExt.length).toBe(1);
    expect(renderExt[0][0]).toBeCloseTo(0, 6);
    expect(renderExt[0][1]).toBeCloseTo(3.0, 6);
  });

  it("Decke überdeckt die VOLLE Wanddicke -> jede Schicht PER SCHICHT gegen die Deckenschichten verschnitten", () => {
    // Gegenprobe: verbreitert man C1 so, dass die Outline die ganze W2 überdeckt
    // (Aussenkante x=5.1725 < 5.5), liegen ALLE Bandmittellinien innerhalb der Decke.
    // PER-SCHICHT (statt pauschal): Deckenschichten screed(30, z[2.54,2.6]),
    // insulation(20, z[2.5,2.54]), concrete(100, z[2.3,2.5]).
    //  • render-ext/render-int (Prio 10 < allen): über [2.3,2.6] komplett gekappt -> [0,2.3].
    //  • brick (50): nur von concrete(100) gekappt -> [0,2.3] + [2.5,2.6].
    //  • insulation-Wand (20): von concrete(100) und screed(30) gekappt, aber NICHT
    //    von der gleichrangigen Decken-insulation(20) -> [0,2.3] + [2.5,2.54] (Sliver,
    //    wo gleichrangiges Material koexistiert — exakt wie „gleiche Prio koexistiert").
    const p: Project = {
      ...sampleProject,
      ceilings: (sampleProject.ceilings ?? []).map((c) =>
        c.id === "C1"
          ? {
              ...c,
              outline: [
                { x: 0, y: -0.5 },
                { x: 5.5, y: -0.5 },
                { x: 5.5, y: 4.5 },
                { x: 0, y: 4.5 },
              ],
            }
          : c,
      ),
    };
    const w2 = projectToWalls3d(p).filter((w) => w.wallId === "W2");
    expect(w2.length).toBe(6);
    const zBoxes = (t: number) =>
      w2.filter((s) => Math.abs(s.thickness - t) < 1e-6)
        .map((s) => [s.baseElevation, s.baseElevation + s.height] as const)
        .sort((a, b) => a[0] - b[0]);
    expect(zBoxes(0.02)).toEqual([[0, 2.3]]); // render-ext (10) voll gekappt
    expect(zBoxes(0.015)).toEqual([[0, 2.3]]); // render-int (10) voll gekappt
    const brick = zBoxes(0.15); // brick (50): nur Beton kappt
    expect(brick.length).toBe(2);
    expect(brick[0][1]).toBeCloseTo(2.3, 6);
    expect(brick[1][0]).toBeCloseTo(2.5, 6);
    expect(brick[1][1]).toBeCloseTo(2.6, 6);
    const insul = zBoxes(0.16); // insulation-Wand (20): Sliver [2.5,2.54] bleibt
    expect(insul.length).toBe(2);
    expect(insul[0][1]).toBeCloseTo(2.3, 6);
    expect(insul[1][0]).toBeCloseTo(2.5, 6);
    expect(insul[1][1]).toBeCloseTo(2.54, 6);
  });

  it("Decke überdeckt nur EINEN TEIL der Wandlänge -> überdecktes Kern-Band spaltet ENTLANG DER ACHSE", () => {
    // C1.outline auf die halbe Länge kürzen (y in [0,2] statt [0,4]): die Decke
    // überdeckt die inneren W2-Bänder nur auf dem Achsenstück y in [0,2]. Das
    // überdeckte Kern-Band (brick) wird dort z-geschnitten und läuft im Rest der
    // Wandlänge (y > 2) über die volle Höhe durch — die Überdeckungsgrenze (y=2)
    // wird aus der Bandmittellinien-Abtastung per Bisektion scharf ermittelt. Die
    // Aussenschichten (nicht überdeckt) bleiben ganz. So wird auch eine Decke
    // korrekt behandelt, die nur einen Teil der Wandlänge trägt.
    const p: Project = {
      ...sampleProject,
      ceilings: (sampleProject.ceilings ?? []).map((c) =>
        c.id === "C1"
          ? { ...c, outline: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 2 }, { x: 0, y: 2 }] }
          : c,
      ),
    };
    const w2 = projectToWalls3d(p).filter((w) => w.wallId === "W2");
    // Per-Schicht-Decken-Dominanz + Achsen-Überdeckung: der Backstein (50) wird nur
    // von der Beton-Schicht (100) UND nur auf dem überdeckten Achsenstück y∈[~0.08,2]
    // gekappt. Dort entstehen ZWEI z-Boxen [0,2.3] + [2.5,2.6]; das unbedeckte Stück
    // y∈[2,~3.92] läuft als EINE volle Box [0,2.6] durch -> 3 Backstein-Boxen.
    // render-int (10 < Beton) spaltet in [0,2.3] (überdeckt) + [0,2.6] (unbedeckt) = 2.
    // Aussenschichten (insulation, render-ext) nicht überdeckt -> je 1 volle Box.
    expect(w2.length).toBe(7);
    const brick = w2
      .filter((s) => Math.abs(s.thickness - 0.15) < 1e-6)
      .map((s) => ({ sy: s.start[1], zb: s.baseElevation, zt: s.baseElevation + s.height }))
      .sort((a, b) => a.zb - b.zb || a.sy - b.sy);
    expect(brick.length).toBe(3);
    // Überdecktes Stück y∈[~0.08,2]: untere Box [0,2.3] + obere Box [2.5,2.6].
    const covered = brick.filter((b) => b.sy < 1.0);
    expect(covered.length).toBe(2);
    expect(covered[0].zt).toBeCloseTo(2.3, 6); // unter Beton
    expect(covered[1].zb).toBeCloseTo(2.5, 6); // über Beton
    expect(covered[1].zt).toBeCloseTo(2.6, 6);
    // Unbedecktes Stück y∈[2,~3.92]: EINE volle Box [0,2.6].
    const uncovered = brick.filter((b) => b.sy > 1.5);
    expect(uncovered.length).toBe(1);
    expect(uncovered[0].zt).toBeCloseTo(2.6, 6);
    // insulation (aussen) bleibt EINE ungeteilte volle Box.
    const insul = w2.filter((s) => Math.abs(s.thickness - 0.16) < 1e-6);
    expect(insul.length).toBe(1);
    expect(insul[0].baseElevation + insul[0].height).toBeCloseTo(2.6, 6);
  });

  it("keine Deckensubtraktion, wenn keine Decke im selben Geschoss überlappt (z.B. OG-Wände ohne Dach-Decke)", () => {
    // W6 (OG) hat keine überlappende Decke im Sample-Projekt (C1 ist EG) -> keine
    // Deckenbedingte z-Aufteilung. Volle wall.height, AUSSER das Sample-Projekt
    // hat auch ein Dach (RF1) über W6 (s. "Dach-Wand-Verschneidung" unten) — eine
    // an der Gehrungsecke leicht über die Achse hinaus verlängerte, hauchdünne
    // Putzschicht (0.02 m) reicht dort minimal unter den Dachüberstand und wird
    // korrekt (nicht durch die Decken-, sondern die Dach-Logik) leicht gekappt.
    const w6 = projectToWalls3d(sampleProject).filter((w) => w.wallId === "W6");
    expect(w6.length).toBeGreaterThan(0);
    const offHeight = w6.filter((seg) => Math.abs(seg.height - 2.6) > 1e-6);
    expect(offHeight.length).toBe(1);
    expect(offHeight[0].thickness).toBeCloseTo(0.02, 6); // die dünne Putz-Gehrungsspitze
    expect(offHeight[0].height).toBeLessThan(2.6);
    expect(offHeight[0].height).toBeGreaterThan(2.5); // nur ein paar cm gekappt
    for (const seg of w6) {
      if (seg === offHeight[0]) continue;
      expect(seg.height).toBeCloseTo(2.6, 6);
    }
  });
});

describe("Dach-Wand-Verschneidung (clipPieceToRoofs) — Wand-Top folgt der Dach-Unterkante", () => {
  // Giebelwand entlang Y (0..4), unter einem Satteldach (First entlang X bei
  // y=2, Traufhöhe 3, Neigung 30°, Dicke 0.1). Wandhöhe 3.0 ⇒ an der Traufe
  // (y=0/4) reicht die Wand exakt bis zur Dachfläche (baseElevation=3), muss
  // dort also um die Dachdicke (0.1) gekappt werden; am First (y=2) liegt die
  // Dachunterkante weit darüber ⇒ unverändert volle Höhe.
  const gableRoof: Roof = {
    id: "RG",
    type: "roof",
    floorId: "eg",
    categoryCode: "35",
    outline: [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 4 },
      { x: 0, y: 4 },
    ],
    shape: "sattel",
    pitchDeg: 30,
    overhang: 0,
    ridgeAxis: "x",
    baseElevation: 3,
    thickness: 0.1,
  };
  const gableWall: Wall = {
    id: "WG",
    type: "wall",
    floorId: "eg",
    categoryCode: "20",
    start: { x: 3, y: 0 },
    end: { x: 3, y: 4 },
    wallTypeId: sampleProject.walls[0].wallTypeId,
    height: 3.0,
  };

  it("kappt die Wand nahe der Traufe, lässt sie am First unverändert", () => {
    const project: Project = {
      ...sampleProject,
      walls: [gableWall],
      roofs: [gableRoof],
      doors: [],
      openings: [],
      ceilings: [],
    };
    const walls = projectToWalls3d(project).filter((w) => w.wallId === "WG");
    expect(walls.length).toBeGreaterThan(0);
    // EXAKT an der Traufe (start.y = 0 bzw. end nahe 4): das erste ~0.15-m-
    // Achsenstück ist geklemmt (Dachunterkante dort knapp unter 3.0, s. o.); die
    // Neigung steigt schnell genug, dass bereits das ZWEITE Achsenstück wieder
    // unbeeinflusst ist — bewusst NUR das direkt an y=0 anliegende Stück prüfen.
    const atEave = walls.filter((s) => s.start[1] < 1e-6 || s.end[1] > 4 - 1e-6);
    expect(atEave.length).toBeGreaterThan(0);
    for (const seg of atEave) {
      expect(seg.height).toBeLessThan(3.0 - 0.05);
      expect(seg.height).toBeGreaterThan(2.8); // nicht mehr als die Dachdicke gekappt
    }
    // Am First (y nahe 2): unverändert volle Höhe (Dachunterkante liegt weit darüber).
    const nearRidge = walls.filter((s) => s.start[1] > 1.8 && s.start[1] < 2.2);
    expect(nearRidge.length).toBeGreaterThan(0);
    for (const seg of nearRidge) {
      expect(seg.height).toBeCloseTo(3.0, 6);
    }
  });

  it("ohne Dach im selben Geschoss: unverändertes Verhalten (volle Höhe, EIN Stück)", () => {
    const project: Project = {
      ...sampleProject,
      walls: [gableWall],
      roofs: [],
      doors: [],
      openings: [],
      ceilings: [],
    };
    const walls = projectToWalls3d(project).filter((w) => w.wallId === "WG");
    expect(walls.length).toBeGreaterThan(0);
    for (const seg of walls) {
      expect(seg.height).toBeCloseTo(3.0, 6);
    }
  });

  it("Dach auf einem ANDEREN Geschoss wirkt nicht (floorId-Filter)", () => {
    const project: Project = {
      ...sampleProject,
      walls: [gableWall],
      roofs: [{ ...gableRoof, floorId: "og" }],
      doors: [],
      openings: [],
      ceilings: [],
    };
    const walls = projectToWalls3d(project).filter((w) => w.wallId === "WG");
    expect(walls.length).toBeGreaterThan(0);
    for (const seg of walls) {
      expect(seg.height).toBeCloseTo(3.0, 6);
    }
  });
});

describe("Geschichteter Bodenaufbau Decke", () => {
  it("Decke -> je Schicht ein Slab, oben->unten gestapelt mit Bauteilfarbe/-schraffur", () => {
    // Deckentyp "dg-massiv": screed 0.06 (#c9c2b3), insulation 0.04 (#ffffff),
    // concrete 0.2 (#9aa0a6) — Reihenfolge OK->UK. C1: zTop 2.6, Gesamt 0.3 ->
    // zBottom 2.3. Proportional: Estrich 2.54..2.6, Dämmung 2.50..2.54,
    // Beton 2.30..2.50. Der 3D-Schnitt zeigt so den Aufbau geschichtet (wie 2D).
    const { slabs } = projectToModel3d(sampleProject);
    const c1 = slabs
      .filter((s) => s.ceilingId === "C1")
      .sort((a, b) => b.zTop - a.zTop); // oben zuerst
    expect(c1.length).toBe(3);

    // Oberste Schicht = Estrich (#c9c2b3), bündig mit OK der Decke (2.6).
    expect(c1[0].zTop).toBeCloseTo(2.6, 6);
    expect(c1[0].color[0]).toBeCloseTo(0xc9 / 255, 6);
    expect(c1[0].color[1]).toBeCloseTo(0xc2 / 255, 6);
    expect(c1[0].color[2]).toBeCloseTo(0xb3 / 255, 6);

    // Mittlere Schicht = Dämmung (#ffffff).
    expect(c1[1].color[0]).toBeCloseTo(1, 6);
    expect(c1[1].color[1]).toBeCloseTo(1, 6);
    expect(c1[1].color[2]).toBeCloseTo(1, 6);

    // Unterste Schicht = Betondecke (#9aa0a6), bündig mit UK der Decke (2.3).
    expect(c1[2].zBottom).toBeCloseTo(2.3, 6);
    expect(c1[2].color[0]).toBeCloseTo(0x9a / 255, 6);
    expect(c1[2].color[1]).toBeCloseTo(0xa0 / 255, 6);
    expect(c1[2].color[2]).toBeCloseTo(0xa6 / 255, 6);

    // Schichten schließen lückenlos aneinander (UK Schicht k == OK Schicht k+1).
    expect(c1[0].zBottom).toBeCloseTo(c1[1].zTop, 6);
    expect(c1[1].zBottom).toBeCloseTo(c1[2].zTop, 6);
  });
});

describe("sliceTermination: Wand endet an der Decke (Zuschnitt, nicht Priorität)", () => {
  // W2 (EG, aw) steht unter der Decke C1 (dg-massiv). Ohne Terminierung ("both")
  // spaltet der Beton (100) den Backstein (50) in [0,2.3] + [2.5,2.6] (heutiges,
  // prioritäts-korrektes Verhalten). "below" clippt die Wand an der Decken-UK →
  // nur die untere Backstein-Box [0,2.3] bleibt; "above" spiegelbildlich [2.5,2.6].
  const withTermination = (mode: "both" | "below" | "above") => ({
    ...sampleProject,
    walls: sampleProject.walls.map((w) =>
      w.id === "W2" ? { ...w, sliceTermination: mode === "both" ? undefined : mode } : w,
    ),
  });
  const brickBoxes = (mode: "both" | "below" | "above") =>
    projectToWalls3d(withTermination(mode))
      .filter((w) => w.wallId === "W2" && Math.abs(w.thickness - 0.15) < 1e-6)
      .map((w) => [w.baseElevation, w.baseElevation + w.height] as const)
      .sort((a, b) => a[0] - b[0]);

  it('Default/"both": Backstein bleibt als ZWEI Boxen [0,2.3] + [2.5,2.6] (heutiges Verhalten)', () => {
    const brick = brickBoxes("both");
    expect(brick.length).toBe(2);
    expect(brick[0][0]).toBeCloseTo(0, 6);
    expect(brick[0][1]).toBeCloseTo(2.3, 6);
    expect(brick[1][0]).toBeCloseTo(2.5, 6);
    expect(brick[1][1]).toBeCloseTo(2.6, 6);
  });

  it('"below": NUR die untere Backstein-Box [0,2.3] (Wand endet an der Decke, kein Rest oben)', () => {
    const brick = brickBoxes("below");
    expect(brick.length).toBe(1);
    expect(brick[0][0]).toBeCloseTo(0, 6);
    expect(brick[0][1]).toBeCloseTo(2.3, 6);
    // Auch der Innenputz (render-int, überdeckt) endet einheitlich an der Decken-UK 2.3.
    const renderInt = projectToWalls3d(withTermination("below"))
      .filter((w) => w.wallId === "W2" && Math.abs(w.thickness - 0.015) < 1e-6);
    expect(renderInt.length).toBe(1);
    expect(renderInt[0].baseElevation + renderInt[0].height).toBeCloseTo(2.3, 6);
    // Aussenschichten (nicht überdeckt) laufen weiter voll durch (2.6).
    const insul = projectToWalls3d(withTermination("below"))
      .filter((w) => w.wallId === "W2" && Math.abs(w.thickness - 0.16) < 1e-6);
    expect(insul[0].baseElevation + insul[0].height).toBeCloseTo(2.6, 6);
  });

  it('"above": NUR die obere Backstein-Box [2.5,2.6] (Brüstung/Attika von oben)', () => {
    const brick = brickBoxes("above");
    expect(brick.length).toBe(1);
    expect(brick[0][0]).toBeCloseTo(2.5, 6);
    expect(brick[0][1]).toBeCloseTo(2.6, 6);
  });
});

describe("Schnitt-Schraffur-Orientierung: relativeToWall dreht bei Wand, nicht bei Decke (2D-Parität)", () => {
  // 2D-Referenz (verbindlich): splitWallLayers ruft resolveHatch(…, 90, …) (Wand
  // steht vertikal, relativeToWall-Muster drehen mit), splitSlabLayers ruft
  // resolveHatch(…, undefined, …) (Decke liegt, absoluter Winkel). Der 3D-Pfad muss
  // EXAKT diesen Endwinkel je Kontext liefern (statt des rohen Hatch-Winkels) —
  // sonst läuft z. B. die Boden-Dämmung im 3D-Schnitt horizontal statt vertikal.
  const wallInsul = () =>
    projectToModel3d(sampleProject).walls.find(
      (w) => w.cut?.componentId === "insulation" && Math.abs(w.thickness - 0.16) < 1e-6,
    )!;
  const slabInsul = () =>
    projectToModel3d(sampleProject).slabs.find((s) => s.cut?.componentId === "insulation")!;

  it("WAND-Dämmung: 3D-Hatch-Winkel == resolveHatch(sia-insulation, 90)", () => {
    const expected = resolveHatch(sampleProject, "sia-insulation", 90).angle;
    expect(wallInsul().hatch?.angle).toBeCloseTo(expected, 6);
  });

  it("DECKEN-Dämmung: 3D-Hatch-Winkel == resolveHatch(sia-insulation, undefined) (absolut)", () => {
    const expected = resolveHatch(sampleProject, "sia-insulation", undefined).angle;
    expect(slabInsul().hatch?.angle).toBeCloseTo(expected, 6);
  });

  it("Wand- und Decken-Dämmung unterscheiden sich um den Wandachsenwinkel (relativeToWall dreht 90°)", () => {
    // sia-insulation ist relativeToWall -> Wand-Winkel = roh − 90, Decke = roh.
    // Die Differenz ist exakt 90° (der Boden-Aufbau läuft dadurch quer zur Wand).
    const diff = (slabInsul().hatch!.angle - wallInsul().hatch!.angle + 360) % 360;
    expect(diff).toBeCloseTo(90, 6);
  });

  it("WAND-Backstein (relativeToWall): 3D-Hatch-Winkel == resolveHatch(sia-brick, 90)", () => {
    const brick = projectToModel3d(sampleProject).walls.find(
      (w) => w.cut?.componentId === "brick" && Math.abs(w.thickness - 0.15) < 1e-6,
    )!;
    expect(brick.hatch?.angle).toBeCloseTo(resolveHatch(sampleProject, "sia-brick", 90).angle, 6);
  });

  it("Musterlinien-Stärke kommt aus dem LineStyle des Hatch durch (2D-Parität)", () => {
    // sia-insulation nutzt lineStyleId "hatch-hair" (0.02 mm). Der 3D-Hatch muss die
    // resolveHatch-lineWeight (aus dem LineStyle) tragen — für Wand UND Decke gleich.
    const expected = resolveHatch(sampleProject, "sia-insulation", 90).lineWeight;
    expect(wallInsul().hatch?.lineWeight).toBeCloseTo(expected, 6);
    expect(slabInsul().hatch?.lineWeight).toBeCloseTo(expected, 6);
    expect(expected).toBeCloseTo(0.02, 6); // hatch-hair
  });
});

describe("Wand-Joins im 3D (L-/T-Stösse, identisch zum 2D-Grundriss/Schnitt)", () => {
  // Die per-Schicht-Cut-Distanzen aus computeJoins (model/joins.ts) werden im
  // layered-3D-Pfad auf die Band-Achsenlängen angewandt — dieselben Zahlen, die
  // generatePlan.ts über clippedBand auf die 2D-Polygone anwendet (Band-Mittellinie
  // an der Gehrungs-/Anschluss-Linie geschnitten). Alle Erwartungswerte unten sind
  // aus der Join-Geometrie des Sample-Projekts von Hand hergeleitet.

  it("(a) L-Ecke gleicher Wandtyp: jede Schicht individuell gehrt (aussen länger, Kern kürzer)", () => {
    // W2 (5,0)->(5,4), Typ "aw", KEINE Öffnung/Querwand -> genau 4 Schicht-Bänder.
    // Beide Enden sind rechtwinklige L-Ecken (mit W1 bei (5,0), W3 bei (5,4)):
    // 45°-Gehrung x+y=5 (Start) bzw. y=x-1 (Ende). Die Mittellinie einer Schicht
    // bei Querversatz `offset` trifft die Gehrung bei Achsenmeter `offset` (Start)
    // bzw. `4-offset` (Ende). Aussenschichten (negativer offset) laufen ÜBER die
    // Ecke hinaus (wrappen), Innenschichten (positiver offset) enden kürzer.
    // Achse u=(0,1) -> Box-Achsenanfang/-ende = start[1]/end[1].
    // W2 steht unter der Decke C1: die Beton-Schicht (100) spaltet den Backstein (50)
    // z-mässig in [0,2.3] + [2.5,2.6] (per-Schicht-Decken-Dominanz) -> 5 Boxen. Die
    // Gehrung ist z-unabhängig, beide Backstein-Boxen tragen denselben Achsenschnitt.
    const w2 = projectToWalls3d(sampleProject).filter((w) => w.wallId === "W2");
    expect(w2.length).toBe(5);
    const band = (t: number) => w2.find((s) => Math.abs(s.thickness - t) < 1e-9)!;
    // offset je Schicht (aw, center): -0.1625 / -0.0725 / 0.0825 / 0.165.
    const cases: Array<[number, number]> = [
      [0.02, -0.1625], // render-ext (aussen) -> from=-0.1625, to=4.1625
      [0.16, -0.0725], // insulation
      [0.15, 0.0825], // brick (Kern)
      [0.015, 0.165], // render-int (innen) -> from=0.165, to=3.835 (am kürzesten)
    ];
    for (const [t, offset] of cases) {
      const b = band(t);
      expect(b.start[1]).toBeCloseTo(offset, 6); // Achsenanfang = offset
      expect(b.end[1]).toBeCloseTo(4 - offset, 6); // Achsenende = 4-offset
    }
    // Der Kern (brick) ist kürzer als die Aussenschicht (render-ext): die
    // per-Schicht-Gehrung ist also wirklich individuell (keine einheitliche Länge).
    const len = (t: number) => band(t).end[1] - band(t).start[1];
    expect(len(0.15)).toBeLessThan(len(0.02));
    expect(len(0.15)).toBeCloseTo(3.835, 6); // 3.9175 - 0.0825
    expect(len(0.02)).toBeCloseTo(4.325, 6); // 4.1625 - (-0.1625)
  });

  it("(b) T-Stoss: Abzweig-Kern läuft bis zur Rückgrat-Nahfläche durch, Putz-Band stoppt an der Wandfläche", () => {
    // Querwand W9 (2.4,0)->(2.4,4), Typ "iw" (render-int 0.015 / brick 0.12 /
    // render-int 0.015), stösst mittig auf W1 (unten) und W3 (oben) -> zwei
    // Mittelspannen-T-Stösse. W9-brick == W1/W3-Rückgrat (Komponente "brick",
    // Prio 50) -> MERGE: der brick-Kern sticht durch den 0.015-Nah-Putz der
    // Durchgangswand bis zu deren Rückgrat-Nahfläche, die render-int-Putzschichten
    // stoppen an der Wandoberfläche. Achse u=(0,1) -> Achsenmeter = start[1]/end[1].
    // W9 (iw) steht ebenfalls unter der Decke C1: die Beton-Schicht (100) spaltet den
    // Kern-Backstein (50) z-mässig in [0,2.3] + [2.5,2.6] -> 2 Kern-Boxen + 2 Putz = 4.
    // Die Gehrung/T-Stoss-Achse ist z-unabhängig, beide Kern-Boxen identisch.
    const w9 = projectToWalls3d(sampleProject).filter((w) => w.wallId === "W9");
    expect(w9.length).toBe(4);
    const brick = w9.find((s) => Math.abs(s.thickness - 0.12) < 1e-9)!;
    const renders = w9.filter((s) => Math.abs(s.thickness - 0.015) < 1e-9);
    expect(renders.length).toBe(2);
    // Putz stoppt an W1-Oberfläche (y=0.1725) bzw. W3-Oberfläche (y=3.8275).
    for (const r of renders) {
      expect(r.start[1]).toBeCloseTo(0.1725, 6);
      expect(r.end[1]).toBeCloseTo(3.8275, 6);
    }
    // Kern läuft 0.015 tiefer bis zur Rückgrat-Nahfläche (y=0.1575 bzw. 3.8425).
    expect(brick.start[1]).toBeCloseTo(0.1575, 6);
    expect(brick.end[1]).toBeCloseTo(3.8425, 6);
    expect(brick.start[1]).toBeLessThan(renders[0].start[1]); // Kern durchgesteckt
  });

  it("(b) T-Stoss Durchgangswand: Nah-Putz wird über die Kernbreite aufgebrochen (Span-Cutout splittet das Band)", () => {
    // W1 (Durchgangswand) verliert den Nah-Putz (innerstes render-int-Band) über
    // die Achsen-Breite des durchstechenden W9-Kerns: das Band zerfällt entlang
    // der Achse in zwei Teilstücke [0.165..2.34] und [2.46..4.835] (Lücke = die
    // 0.12 m Kernbreite um x=2.4). W1-Achse u=(1,0) -> Achsenmeter = start[0]/end[0].
    const w1 = projectToWalls3d(sampleProject).filter((w) => w.wallId === "W1");
    const innerPlaster = w1
      .filter((s) => Math.abs(s.thickness - 0.015) < 1e-9)
      .map((s) => [s.start[0], s.end[0]] as const)
      .sort((a, b) => a[0] - b[0]);
    expect(innerPlaster.length).toBe(2); // in zwei Teilstücke gebrochen
    // Lücke = Kernbreite-Projektion [2.34, 2.46] um die Querwand-Achse x=2.4.
    expect(innerPlaster[0][1]).toBeCloseTo(2.34, 6); // Ende Teilstück 1
    expect(innerPlaster[1][0]).toBeCloseTo(2.46, 6); // Anfang Teilstück 2
  });

  it("(c) Join-verschobenes Band: Öffnungs-Löcher bleiben absolut korrekt positioniert (rebased)", () => {
    // W1 trägt Fenster O1 (Achsenintervall [3.0,4.0]). Das Aussenputz-Band ist an
    // den L-Ecken über die Achse hinaus verlängert (Achsenanfang < 0) — die Loch-
    // `from`/`to` sind auf DIESEN Box-Start umgerechnet. Rekonstruiert man die
    // absolute Achsenposition (Box-Achsenanfang + `from`), liegt das Fenster wieder
    // exakt auf [3.0,4.0], unabhängig von der Join-Verschiebung. W1-Achse u=(1,0).
    const w1 = projectToWalls3d(sampleProject).filter((w) => w.wallId === "W1");
    const outer = w1.find((s) => Math.abs(s.thickness - 0.02) < 1e-9)!;
    expect(outer.start[0]).toBeLessThan(0); // Band über die Ecke hinaus verlängert
    const window = (outer.holes ?? [])
      .map((h) => [outer.start[0] + h.from, outer.start[0] + h.to] as const)
      .sort((a, b) => a[0] - b[0])
      .find(([a]) => a > 2); // das Fenster O1 (das andere Loch ist die Tür D1)
    expect(window).toBeDefined();
    expect(window![0]).toBeCloseTo(3.0, 6);
    expect(window![1]).toBeCloseTo(4.0, 6);
  });

  it("Joins wirken NUR im layered-3D-Pfad, nicht im Schnitt-Pfad (layered=false unverändert)", () => {
    // Der Schnitt-Pfad (computeSection, layeredWalls:false) darf KEINE Join-Cuts
    // bekommen: W2 bleibt eine Voll-Box über die ganze Dicke, ungehrt (Achse
    // 0..4), damit toSection.ts::subtractDominantBands seine eigene Dominanz auf
    // Rohgeometrie anwendet.
    const w2 = projectToWalls3d(sampleProject, false).filter((w) => w.wallId === "W2");
    expect(w2.length).toBe(1); // Voll-Box, keine Schicht-Bänder
    expect(w2[0].start[1]).toBeCloseTo(0, 6); // ungehrt: Achse 0..4
    expect(w2[0].end[1]).toBeCloseTo(4, 6);
  });
});

describe("emitStairMeshes (Betontreppe: glatte Laufplatte als Mesh)", () => {
  it("gerade Betontreppe -> Mesh mit 8 Ecken je Tritt, glatte schräge Untersicht", () => {
    // Sample-Treppe ST1: Typ "stair-standard" (Tragart "beton"), gerade,
    // stepCount 15 -> ein konvexes Prisma je Tritt = 8 Ecken. Das Mesh landet in
    // model.meshes (kind "extrusion").
    const model = projectToModel3d(sampleProject);
    const stairMesh = model.meshes.find((m) => m.positions.length / 3 === 8 * 15);
    expect(stairMesh).toBeTruthy();
    const m = stairMesh!;
    // Indizes bilden Dreiecke (6 Quads * 2 Tris * 3 = 36 Indizes je Tritt).
    expect(m.indices.length).toBe(15 * 36);
    expect(m.indices.length % 3).toBe(0);
    // Keine NaN/Inf in der Geometrie.
    expect(m.positions.every((v) => Number.isFinite(v))).toBe(true);
    // Höhen (jede 3. Komponente) liegen zwischen Treppen-UK (~0) und -OK (~2.6).
    const heights = m.positions.filter((_, i) => i % 3 === 2);
    expect(Math.min(...heights)).toBeGreaterThanOrEqual(-1e-6);
    expect(Math.max(...heights)).toBeLessThanOrEqual(2.6 + 1e-6);
    // Alle Index-Werte referenzieren existierende Vertices.
    const vcount = m.positions.length / 3;
    expect(m.indices.every((idx) => idx >= 0 && idx < vcount)).toBe(true);
  });
});

describe("emitRoofs (Dachflächen + Giebel als Meshes)", () => {
  // Dieselbe Terrakotta-Farbe wie ROOF_RGB in toWalls3d.ts — dient hier nur der
  // Isolation der Dach-Meshes von Kontext-/Öffnungs-/Treppen-Meshes im Test.
  const ROOF_RGB: [number, number, number] = [0.72, 0.45, 0.36];
  const isRoofMesh = (m: { color: readonly number[] }) =>
    m.color[0] === ROOF_RGB[0] && m.color[1] === ROOF_RGB[1] && m.color[2] === ROOF_RGB[2];

  const baseRoof: Roof = {
    id: "R1",
    type: "roof",
    floorId: "eg",
    categoryCode: "35",
    outline: [
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 4 },
      { x: 0, y: 4 },
    ],
    shape: "sattel",
    pitchDeg: 30,
    overhang: 0,
    ridgeAxis: "x",
    baseElevation: 3, // fix, unabhängig von Geschoss-Stapelung
    thickness: 0.3,
  };

  it("Satteldach: Flächen + Giebel als EIN Roof-Mesh, First-Höhe passt zur Traufhöhe + ridgeHeight", () => {
    const project: Project = { ...sampleProject, roofs: [baseRoof] };
    const { meshes } = projectToModel3d(project);
    const roofMeshes = meshes.filter(isRoofMesh);
    // Einschichtiges Dach (thickness-Fallback): 1 Schicht-Slab-Mesh (Flächen) +
    // 1 Giebel-Mesh (Endfüllung) = 2 Roof-Meshes (beide ROOF_RGB).
    expect(roofMeshes.length).toBe(2);
    for (const m of roofMeshes) {
      expect(m.positions.every((v) => Number.isFinite(v))).toBe(true);
      expect(m.indices.length % 3).toBe(0);
      expect(m.indices.length).toBeGreaterThan(0);
      const vcount = m.positions.length / 3;
      expect(m.indices.every((idx) => idx >= 0 && idx < vcount)).toBe(true);
    }
    // Firsthöhe: eavesZ (baseElevation) + ridgeHeight aus roofGeometry — über ALLE
    // Roof-Meshes (Oberseite der Flächen bzw. Giebelspitze).
    const g = roofGeometry(baseRoof, roofBaseElevation(project, baseRoof));
    const expectedRidgeZ = roofBaseElevation(project, baseRoof) + g.ridgeHeight;
    const allHeights = roofMeshes.flatMap((m) => m.positions.filter((_, i) => i % 3 === 2));
    expect(Math.max(...allHeights)).toBeCloseTo(expectedRidgeZ, 6);
  });

  it("Walmdach: vier Dachflächen (2 Quader + 2 Dreiecke) korrekt trianguliert", () => {
    const walmRoof: Roof = { ...baseRoof, id: "R2", shape: "walm" };
    const project: Project = { ...sampleProject, roofs: [walmRoof] };
    const { meshes } = projectToModel3d(project);
    const roofMeshes = meshes.filter(isRoofMesh);
    expect(roofMeshes.length).toBe(1);
    const m = roofMeshes[0];
    expect(m.positions.every((v) => Number.isFinite(v))).toBe(true);
    // Walm hat KEINE Giebel (gables: []). Jede Fläche ist jetzt ein SOLIDER Slab
    // (Oberseite + Unterseite + Seitenwände): Quader-Fläche (4 Ecken) = 2+2+8 =
    // 12 Dreiecke, Dreiecks-Fläche (3 Ecken) = 1+1+6 = 8 Dreiecke.
    // 2 Quader × 12 + 2 Dreiecke × 8 = 40 Dreiecke = 120 Indizes.
    expect(m.indices.length).toBe(120);
    const vcount = m.positions.length / 3;
    expect(m.indices.every((idx) => idx >= 0 && idx < vcount)).toBe(true);
  });

  it("Dach-Dicke: Slab erzeugt eine Unterseite unter der Oberfläche (thickness > 0)", () => {
    const project: Project = { ...sampleProject, roofs: [baseRoof] };
    const m = projectToModel3d(project).meshes.filter(isRoofMesh)[0];
    const heights = m.positions.filter((_, i) => i % 3 === 2);
    // Sattel 6×4, 30°, Traufe 3: Traufe-OK bei z=3, First höher. Die Unterseite
    // liegt um ~thickness (0.3, senkrecht) tiefer -> min height klar unter 3.
    expect(Math.min(...heights)).toBeLessThan(3 - 0.2);
  });

  it("Dach-Schichtaufbau (roofTypeId): je Schicht ein eigenes Mesh mit Bauteilfarbe, entlang der Normalen gestapelt", () => {
    // Dachtyp mit zwei Schichten (Eindeckung + Sparren/Dämmung), eigene Farben.
    const flatRoof: Roof = {
      ...baseRoof,
      shape: "flach", // Flachdach: eine Fläche, keine Giebel -> reine Schicht-Meshes
      roofTypeId: "rt-warm",
    };
    const project: Project = {
      ...sampleProject,
      components: [
        ...sampleProject.components,
        {
          id: "comp-tile",
          name: "Ziegel",
          color: "#a03a2a",
          hatchId: "",
          joinPriority: 1,
        },
        {
          id: "comp-rafter",
          name: "Sparren/Dämmung",
          color: "#caa15a",
          hatchId: "",
          joinPriority: 1,
        },
      ],
      roofTypes: [
        {
          id: "rt-warm",
          name: "Warmdach",
          layers: [
            { componentId: "comp-tile", thickness: 0.05 },
            { componentId: "comp-rafter", thickness: 0.24 },
          ],
        },
      ],
      roofs: [flatRoof],
    };
    const meshes = projectToModel3d(project).meshes;
    const tile = meshes.filter(
      (m) => Math.abs(m.color[0] - 0xa0 / 255) < 1e-6 && Math.abs(m.color[1] - 0x3a / 255) < 1e-6,
    );
    const rafter = meshes.filter(
      (m) => Math.abs(m.color[0] - 0xca / 255) < 1e-6 && Math.abs(m.color[1] - 0xa1 / 255) < 1e-6,
    );
    expect(tile.length).toBe(1); // Eindeckungs-Schicht als eigenes Mesh
    expect(rafter.length).toBe(1); // Sparren-Schicht als eigenes Mesh
    // Die Sparren-Schicht liegt UNTER der Eindeckung: ihre Oberkante = Traufe −
    // Eindeckungsdicke. Flachdach-Oberseite bei baseElevation 3.
    const topOf = (m: { positions: number[] }) =>
      Math.max(...m.positions.filter((_, i) => i % 3 === 2));
    expect(topOf(tile[0])).toBeCloseTo(3, 6);
    expect(topOf(rafter[0])).toBeCloseTo(3 - 0.05, 6);
  });

  it("Projekt ohne Dächer emittiert keine Roof-Meshes (Rückwärtskompatibilität)", () => {
    // Explizit leeres roofs-Feld -> keine Roof-Meshes.
    const project: Project = { ...sampleProject, roofs: [] };
    expect(projectToModel3d(project).meshes.filter(isRoofMesh).length).toBe(0);
    // Fehlt das Feld ganz (undefined), ebenfalls keine.
    const noField: Project = { ...sampleProject };
    delete (noField as { roofs?: unknown }).roofs;
    expect(projectToModel3d(noField).meshes.filter(isRoofMesh).length).toBe(0);
    // sampleProject enthält ein Demo-Satteldach (RF1, einschichtig) -> 2 Roof-
    // Meshes: Schicht-Slab (Flächen) + Giebel-Endfüllung.
    expect(projectToModel3d(sampleProject).meshes.filter(isRoofMesh).length).toBe(2);
  });
});

describe("emitOpeningShading (Rollladen-/Sonnenschutzkasten als 3D-Box)", () => {
  // SHADING_RGB in toWalls3d.ts — nur zur Isolation der Kasten-Meshes.
  const isShadingMesh = (m: { color: readonly number[] }) =>
    m.color[0] === 0.88 && m.color[1] === 0.88 && m.color[2] === 0.9;

  const withShading = (create: boolean): Project => ({
    ...sampleProject,
    windowTypes: [
      {
        id: "win-shade",
        name: "Test Rollladen",
        kind: "fest",
        wingCount: 1,
        glazing: "einfach",
        frameThickness: 0.06,
        frameWidth: 0.06,
        defaultSillHeight: 0.9,
        defaultWidth: 1.0,
        defaultHeight: 1.2,
        shading: create
          ? { create: true, kind: "rollladen", box: { width: 0, height: 0.24, depth: 0.2 } }
          : undefined,
      },
    ],
    openings: [
      {
        id: "OS",
        type: "opening",
        hostWallId: "W1",
        categoryCode: "21",
        kind: "window",
        typeId: "win-shade",
        position: 3.0,
        width: 1.0,
        height: 1.2,
        sillHeight: 0.9,
      },
    ],
    doors: [],
    context: [],
  });

  it("shading.create -> genau eine Kasten-Box (Quader: 24 Floats, 36 Indizes)", () => {
    const meshes = projectToModel3d(withShading(true)).meshes.filter(isShadingMesh);
    expect(meshes.length).toBe(1);
    expect(meshes[0].positions.length).toBe(24);
    expect(meshes[0].indices.length).toBe(36);
    // Der Kasten sitzt ÜBER der Öffnungs-OK (UK 0.9 + Höhe 1.2 = 2.1): alle
    // z-Werte >= 2.1 (nur nach oben), OK bei 2.1 + 0.24 = 2.34.
    const zs: number[] = [];
    for (let i = 2; i < meshes[0].positions.length; i += 3) zs.push(meshes[0].positions[i]);
    expect(Math.min(...zs)).toBeCloseTo(2.1, 6);
    expect(Math.max(...zs)).toBeCloseTo(2.34, 6);
  });

  it("kein shading / create:false -> keine Kasten-Box", () => {
    expect(projectToModel3d(withShading(false)).meshes.filter(isShadingMesh).length).toBe(0);
  });

  it("grob -> keine Kasten-Box (nur mittel/fein)", () => {
    expect(
      projectToModel3d(withShading(true), { detail: "grob" }).meshes.filter(isShadingMesh).length,
    ).toBe(0);
  });
});

describe("pickGeometry — Dächer (Ray-Dreieck-Pick)", () => {
  it("liefert je Dach World-Dreiecke (Flächen + Giebel), world=[x,Höhe,y]", () => {
    const { roofs } = pickGeometry(sampleProject);
    // sampleProject trägt das Demo-Satteldach RF1.
    expect(roofs.length).toBe(1);
    expect(roofs[0].roofId).toBe("RF1");
    // Sattel: 2 Flächen (je 4 Ecken → 2 Dreiecke) + 2 Giebel (je 1 Dreieck) = 6.
    expect(roofs[0].tris.length).toBe(6);
    // Höhe liegt in der WORLD-Y-Komponente (Index 1) — alle über der Traufe > 0.
    for (const tri of roofs[0].tris) for (const p of tri) expect(p[1]).toBeGreaterThan(0);
  });
});

describe("pickGeometry — Kontext-Meshes (importierte Gebäude/Terrain)", () => {
  const withContext: Project = {
    ...sampleProject,
    context: [
      {
        id: "CTX1",
        type: "importedMesh",
        name: "Testgebäude",
        // model (x,y,z=Höhe) -> world (x, z, y): ein Dreieck.
        positions: [0, 0, 0, 2, 0, 0, 2, 3, 4],
        indices: [0, 1, 2],
      },
      {
        id: "CONTOURS1",
        type: "contourSet",
        name: "Höhenlinien",
        contours: [],
      },
    ],
  };

  it("liefert je Kontext-Objekt World-Dreiecke, contourSet wird übersprungen", () => {
    const { contextMeshes } = pickGeometry(withContext);
    expect(contextMeshes.length).toBe(1);
    expect(contextMeshes[0].contextObjectId).toBe("CTX1");
    expect(contextMeshes[0].tris.length).toBe(1);
    // world = (x, z, y) — dasselbe Dreieck (0,0,0),(2,0,0),(2,3,4)
    // -> world (0,0,0),(2,0,0),(2,4,3).
    expect(contextMeshes[0].tris[0][2]).toEqual([2, 4, 3]);
  });

  it("kaputte Indizes werden robust übersprungen statt abzustürzen", () => {
    const broken: Project = {
      ...sampleProject,
      context: [
        {
          id: "CTX2",
          type: "importedMesh",
          name: "Kaputt",
          positions: [0, 0, 0, 1, 0, 0, 1, 1, 0],
          indices: [0, 1, 99], // Index 99 existiert nicht
        },
      ],
    };
    const { contextMeshes } = pickGeometry(broken);
    expect(contextMeshes.length).toBe(0);
  });
});

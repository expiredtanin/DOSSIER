// Testprojekt für Fenster-/Tür-Details ([105]/[106]): Aussenwand (Aussenputz, Dämmung, Backstein,
// Innenputz) mit Fenstern in verschiedenen Schichteinzug-Varianten und eine Innenwand mit je einer Tür
// pro Zargen-Art; dazu je Öffnung ein Schnitt (S-…) und eine Ansicht von aussen.
// Aufruf: npx esbuild scripts/gen-opening-test-project.ts --bundle --platform=node --format=esm
//         --outfile=/tmp/gen.mjs && node /tmp/gen.mjs out.obp
import { writeFileSync } from "node:fs";
import { emptyProject } from "../src/model/sampleProject";
import type { DoorType, DrawingLevel, LayerReveal, Opening, Project, Wall, WindowType } from "../src/model/types";

const wall = (id: string, typeId: string, x0: number, y0: number, x1: number, y1: number): Wall =>
  ({ id, type: "wall", floorId: "eg", categoryCode: "20", start: { x: x0, y: y0 }, end: { x: x1, y: y1 }, wallTypeId: typeId, height: 2.6 }) as Wall;

const levels: DrawingLevel[] = [{ id: "eg", name: "EG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 0 }];
const section = (name: string, x: number, y0: number, y1: number): DrawingLevel =>
  ({ id: `s-${name}`, name, kind: "section", visible: true, locked: false, linePoints: [{ x, y: y0 }, { x, y: y1 }], directionSign: 1, levelMarks: false }) as DrawingLevel;

// Fenster in der Dämmebene: Rahmen auf der Backstein-Aussenfläche (Einzug 0.18 = Putz + Dämmung).
const winBase = (id: string, name: string, reveals: LayerReveal[] | undefined, extra: Partial<WindowType> = {}): WindowType => ({
  id,
  name,
  kind: "drehkipp",
  wingCount: 1,
  glazing: "dreifach",
  frameThickness: 0.08,
  frameWidth: 0.08,
  frameDepth: 0.08,
  insetFace: "aussen",
  insetFromFace: 0.18,
  defaultSillHeight: 0.9,
  defaultWidth: 1.2,
  defaultHeight: 1.4,
  layerReveals: reveals,
  ...extra,
});
const windowTypes: WindowType[] = [
  winBase("w-buendig", "F bündig", undefined),
  winBase("w-ueberdaemmt", "F überdämmt 3 cm, Innenputz in Leibung", [
    { layer: 0, mode: "leibung", amount: 0.01 },
    { layer: 1, mode: "ueberdaemmt", amount: 0.03 },
    { layer: -1, mode: "leibung" },
  ], { frameDetail: { frameSides: { bottom: 0.11, top: 0.09 }, sillProfile: 0.03, shadingProfile: 0.02, sashWidth: 0.07, sashOverlap: 0.01 } }),
  winBase("w-leibungsdaemmung", "F Leibungsdämmung 3 cm", [
    { layer: 0, mode: "leibung", amount: 0.01 },
    { layer: 1, mode: "leibung", amount: 0.03 },
    { layer: -1, mode: "leibung" },
  ]),
  winBase("w-zurueck", "F Innenputz 5 cm zurück, Anschlag", [{ layer: -1, mode: "zurueck", amount: 0.05 }], {
    insetFromFace: 0.12,
    frameDetail: { rebates: { left: 0.05, right: 0.0, top: 0.05, bottom: 0.0 }, extensionProfiles: { left: 0.03, right: 0.03 } },
  }),
  // [105] Rahmen je Seite (rechts breiter), Pfosten 10 cm zwischen zwei Flügeln, Verbreiterung links,
  // Bank- und Storenanschlussprofil.
  winBase("w-detail", "F Rahmen je Seite, Pfosten, Profile", undefined, {
    wingCount: 2,
    frameDetail: { frameSides: { left: 0.06, right: 0.12, top: 0.08, bottom: 0.1 }, mullionWidth: 0.1, extensionProfiles: { left: 0.04 }, sillProfile: 0.03, shadingProfile: 0.05 },
  }),
];
const doorKinds = ["umfassungszarge", "eckzarge", "blockzarge", "blockrahmen", "blendrahmen", "futter"] as const;
const doorTypes: DoorType[] = doorKinds.map((k) => ({
  id: `d-${k}`,
  name: `Tür ${k}`,
  kind: "dreh",
  leafCount: 1,
  leafStyle: "glatt",
  frameThickness: 0.05,
  frameKind: k,
  frameWidth: k === "blockrahmen" || k === "blendrahmen" ? 0.07 : 0.06,
  frameDepth: k === "blockrahmen" ? 0.08 : k === "blendrahmen" ? 0.06 : undefined,
  insetFace: k === "blockrahmen" ? "mitte" : undefined,
  defaultWidth: 0.9,
  defaultHeight: 2.05,
  doorFrame: k === "futter" ? { casingSides: "beide" } : undefined,
}));

// [105] Umfassungszarge mit Oberlicht (Kämpfer in Zargenbreite, Glas in der Zarge).
doorTypes.push({ ...doorTypes[0], id: "d-oberlicht", name: "Tür umfassungszarge mit Oberlicht", transomHeight: 0.45, defaultHeight: 2.5 });
const walls: Wall[] = [wall("AW", "aw", 0, 0, 15, 0), wall("IW", "iw", 0, 4, 15.5, 4)];
const openings: Opening[] = [];
windowTypes.forEach((t, i) => {
  const pos = 0.8 + i * 2.8;
  openings.push({ id: `F${i + 1}`, type: "opening", hostWallId: "AW", categoryCode: "21", kind: "window", typeId: t.id, position: pos, width: 1.2, height: 1.4, sillHeight: 0.9, detailLevel: "fein" } as Opening);
  levels.push(section(`S-F${i + 1}`, pos + 0.6, -1, 1));
});
doorTypes.forEach((t, i) => {
  const pos = 0.6 + i * 2.2;
  openings.push({ id: `T${i + 1}`, type: "opening", hostWallId: "IW", categoryCode: "21", kind: "door", typeId: t.id, position: pos, width: 0.9, height: t.defaultHeight, sillHeight: 0, swing: "left", openingDir: "in", detailLevel: "fein" } as Opening);
  levels.push(section(`S-T${i + 1}`, pos + 0.45, 3, 5));
});
// [G3] Rundbogenfenster in einer eigenen Wand; Schnitt parallel davor (Projektion) und quer.
walls.push(wall("AW2", "aw", 0, 8, 6, 8));
openings.push({ id: "FB", type: "opening", hostWallId: "AW2", categoryCode: "21", kind: "window", typeId: "w-buendig", position: 2, width: 1.2, height: 1.6, sillHeight: 0.8, shape: "rundbogen" } as Opening);
levels.push(section("S-FB", 2.9, 7, 9));
levels.push({ id: "s-fb-par", name: "S-FB-parallel", kind: "section", visible: true, locked: false, linePoints: [{ x: -0.5, y: 7 }, { x: 6.5, y: 7 }], directionSign: 1, levelMarks: false } as DrawingLevel);
levels.push({ id: "s-fb-par2", name: "S-FB-parallel-2", kind: "section", visible: true, locked: false, linePoints: [{ x: -0.5, y: 7 }, { x: 6.5, y: 7 }], directionSign: -1, levelMarks: false } as DrawingLevel);
// [106]/[105] Schnitt parallel zur Aussenwand mitten durch die Leibungen.
levels.push({ id: "s-leibung", name: "S-Leibung", kind: "section", visible: true, locked: false, linePoints: [{ x: -0.5, y: 0.05 }, { x: 12.5, y: 0.05 }], directionSign: 1, levelMarks: false } as DrawingLevel);
// Türen von beiden Seiten (Zargenspiegel, Bekleidung je Seite).
levels.push({ id: "a-tuer-s", name: "Ansicht-Tueren-Sued", kind: "elevation", visible: true, locked: false, linePoints: [{ x: 0, y: 2.5 }, { x: 15.5, y: 2.5 }], directionSign: 1, levelMarks: false } as DrawingLevel);
levels.push({ id: "a-tuer-n", name: "Ansicht-Tueren-Nord", kind: "elevation", visible: true, locked: false, linePoints: [{ x: 0, y: 5.5 }, { x: 15.5, y: 5.5 }], directionSign: -1, levelMarks: false } as DrawingLevel);
// [103] Dachfenster in einem Satteldach über dem Dachgeschoss (eigenes Gebäude rechts).
levels.push({ id: "dg", name: "DG", kind: "floor", visible: true, locked: false, floorHeight: 2.6, cutHeight: 1.0, baseElevation: 2.6 } as DrawingLevel);
const roofs = [{ id: "R1", type: "roof", floorId: "dg", categoryCode: "35", outline: [{ x: 16, y: 0 }, { x: 22, y: 0 }, { x: 22, y: 6 }, { x: 16, y: 6 }], shape: "sattel", pitchDeg: 40, overhang: 0.3, ridgeAxis: "x", baseElevation: 2.6, thickness: 0.3 }];
openings.push({ id: "DF1", type: "opening", hostWallId: "", hostRoofId: "R1", hostPoint: { x: 19, y: 1.5 }, categoryCode: "21", kind: "window", position: 0, width: 0.78, height: 1.18, sillHeight: 0 } as Opening);
levels.push(section("S-DF", 19.2, -1, 7));
levels.push({ id: "a-dach", name: "Ansicht-Dach-Sued", kind: "elevation", visible: true, locked: false, linePoints: [{ x: 15, y: -3 }, { x: 23, y: -3 }], directionSign: 1, levelMarks: false } as DrawingLevel);
levels.push({ id: "a-aussen", name: "Ansicht-Aussen", kind: "elevation", visible: true, locked: false, linePoints: [{ x: 0, y: -2 }, { x: 15, y: -2 }], directionSign: 1, levelMarks: false } as DrawingLevel);

// [105] Klassische Zarge/Blockrahmen (Rahmenband): Blatt im Falz auf der Aufschlagseite, nach innen
// und nach aussen aufgehend; [95] Hebeschiebetür (Bandseite = festes Feld) in einer Aussenwand.
doorTypes.push(
  { id: "d-zarge", name: "Tür Zarge", kind: "dreh", leafCount: 1, leafStyle: "glatt", frameThickness: 0.05, frameKind: "zarge", frameWidth: 0.06, defaultWidth: 0.9, defaultHeight: 2.05 },
  { id: "d-block-aussen", name: "Tür Blockrahmen aussen", kind: "dreh", leafCount: 1, leafStyle: "glatt", frameThickness: 0.05, frameKind: "blockrahmen", frameWidth: 0.07, frameDepth: 0.08, defaultWidth: 0.9, defaultHeight: 2.05 },
  { id: "d-hs", name: "Hebeschiebetür", kind: "hebeschiebe", leafCount: 2, leafStyle: "glas", frameThickness: 0.08, frameWidth: 0.08, frameDepth: 0.16, insetFace: "aussen", insetFromFace: 0.18, defaultWidth: 2.4, defaultHeight: 2.3 },
);
walls.push(wall("IW2", "iw", 0, 12, 8, 12), wall("AW3", "aw", 0, 16, 10, 16));
const extraDoors: [string, string, number, Partial<Opening>][] = [
  ["T-Z-in", "d-zarge", 0.6, { openingDir: "in" }],
  ["T-Z-out", "d-zarge", 2.6, { openingDir: "out" }],
  ["T-B-in", "d-block-aussen", 4.6, { openingDir: "in" }],
  ["T-B-out", "d-block-aussen", 6.6, { openingDir: "out", swing: "right" }],
];
for (const [id, typeId, pos, extra] of extraDoors) {
  openings.push({ id, type: "opening", hostWallId: "IW2", categoryCode: "21", kind: "door", typeId, position: pos, width: 0.9, height: 2.05, sillHeight: 0, swing: "left", detailLevel: "fein", ...extra } as Opening);
  levels.push(section(`S-${id}`, pos + 0.45, 11, 13));
}
openings.push({ id: "HS1", type: "opening", hostWallId: "AW3", categoryCode: "21", kind: "door", typeId: "d-hs", position: 1, width: 2.4, height: 2.3, sillHeight: 0, detailLevel: "fein" } as Opening);
openings.push({ id: "HS2", type: "opening", hostWallId: "AW3", categoryCode: "21", kind: "door", typeId: "d-hs", position: 5, width: 2.4, height: 2.3, sillHeight: 0, hinge: "end", detailLevel: "fein" } as Opening);
levels.push({ id: "a-hs-aussen", name: "Ansicht-HS-Aussen", kind: "elevation", visible: true, locked: false, linePoints: [{ x: 0, y: 18 }, { x: 10, y: 18 }], directionSign: -1, levelMarks: false } as DrawingLevel);
levels.push({ id: "a-hs-innen", name: "Ansicht-HS-Innen", kind: "elevation", visible: true, locked: false, linePoints: [{ x: 0, y: 14 }, { x: 10, y: 14 }], directionSign: 1, levelMarks: false } as DrawingLevel);
levels.push({ id: "a-iw2", name: "Ansicht-IW2", kind: "elevation", visible: true, locked: false, linePoints: [{ x: 0, y: 11 }, { x: 8, y: 11 }], directionSign: 1, levelMarks: false } as DrawingLevel);

const project = { ...emptyProject, id: "opening-details", name: "Fenster/Tür-Details", drawingLevels: levels, walls, openings, windowTypes, doorTypes, roofs } as unknown as Project;
writeFileSync(process.argv[2] ?? "opening-details.obp", JSON.stringify(project, null, 1));

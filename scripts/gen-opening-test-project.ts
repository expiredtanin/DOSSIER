// Testprojekt für Fenster-/Tür-Details ([102]/[103]): Aussenwand (Aussenputz, Dämmung, Backstein,
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

const walls: Wall[] = [wall("AW", "aw", 0, 0, 12, 0), wall("IW", "iw", 0, 4, 14, 4)];
const openings: Opening[] = [];
windowTypes.forEach((t, i) => {
  const pos = 0.8 + i * 2.8;
  openings.push({ id: `F${i + 1}`, type: "opening", hostWallId: "AW", categoryCode: "21", kind: "window", typeId: t.id, position: pos, width: 1.2, height: 1.4, sillHeight: 0.9 } as Opening);
  levels.push(section(`S-F${i + 1}`, pos + 0.6, -1, 1));
});
doorTypes.forEach((t, i) => {
  const pos = 0.6 + i * 2.2;
  openings.push({ id: `T${i + 1}`, type: "opening", hostWallId: "IW", categoryCode: "21", kind: "door", typeId: t.id, position: pos, width: 0.9, height: 2.05, sillHeight: 0, swing: "left", openingDir: "in" } as Opening);
  levels.push(section(`S-T${i + 1}`, pos + 0.45, 3, 5));
});
levels.push({ id: "a-aussen", name: "Ansicht-Aussen", kind: "elevation", visible: true, locked: false, linePoints: [{ x: 0, y: -2 }, { x: 12, y: -2 }], directionSign: 1, levelMarks: false } as DrawingLevel);

const project: Project = { ...emptyProject, id: "opening-details", name: "Fenster/Tür-Details", drawingLevels: levels, walls, openings, windowTypes, doorTypes };
writeFileSync(process.argv[2] ?? "opening-details.obp", JSON.stringify(project, null, 1));

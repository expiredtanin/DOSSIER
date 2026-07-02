// Erzeugt aus dem echten Modell (sampleProject → generatePlan) die JSON-Dateien,
// die die nativen wgpu-Fenster (render2d/render3d) beim Start laden:
//   src-tauri/assets/native2d_scene.json   (RScene: fills/outlines/lines)
//   src-tauri/assets/native3d_walls.json    (RWall[])
// Wird via scripts/dump-native-scene.mjs (esbuild-Bundle) unter Node ausgeführt.

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { sampleProject } from "../src/model/sampleProject";
import { generatePlan } from "../src/plan/generatePlan";
import { planToRenderScene } from "../src/plan/toRenderScene";
import { projectToWalls3d } from "../src/plan/toWalls3d";

const root = process.cwd();
const outDir = resolve(root, "src-tauri", "assets");
mkdirSync(outDir, { recursive: true });

// 2D: Erdgeschoss-Grundriss, alle sichtbaren Kategorien, Detailgrad „mittel".
const floorId = "eg";
const visibleCodes = new Set(sampleProject.layers.map((l) => l.code));
const plan = generatePlan(sampleProject, floorId, visibleCodes);
const scene = planToRenderScene(plan);

// 3D: alle Wände aller Geschosse, korrekt gestapelt.
const walls = projectToWalls3d(sampleProject);

const scenePath = resolve(outDir, "native2d_scene.json");
const wallsPath = resolve(outDir, "native3d_walls.json");
writeFileSync(scenePath, JSON.stringify(scene));
writeFileSync(wallsPath, JSON.stringify(walls));

console.log(
  `native2d_scene.json: ${scene.fills.length} fills, ${scene.outlines.length} outlines, ${scene.lines.length} lines`,
);
console.log(`native3d_walls.json: ${walls.length} walls`);
console.log(`→ ${outDir}`);

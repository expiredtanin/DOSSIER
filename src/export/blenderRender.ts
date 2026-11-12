// Rendering mit Blender/Cycles ([211]): Export-Paket für ein installiertes Blender (eigener Prozess, GPL —
// nichts davon ist in Dossier eingebunden).
//
// Paket (ein Ordner): `model.glb` (Export [201]: Normalen, PBR-Materialien, Glas als Alpha-Blend), `scene.json`
// (Kamera, Sonne, Bildgrösse, Samples, Materialtabelle) und `textures/…` (Bildkarten aus dem Material-System).
// Das Python-Skript `scripts/blender/render_dossier.py` liest `scene.json`. Dieses Modul baut nur das Paket;
// den Prozess starten die Gastgeber (`src/native/blender.ts`: Tauri/Electron, `src/cli/main.ts`: Node).
//
// UV-Koordinaten: das GLB hat keine. Texturen legt das Skript per Box-Projektion über Objektkoordinaten
// (Kachelgrösse `sizeM` des Materials in Metern), das ersetzt UVs ohne den Rust-Exporter anzufassen.
// Materialzuordnung: der glTF-Materialname ist der Bauteilname (`Component.name`); dessen `material` (ambientCG-
// Karten) kommt als Textur-Eintrag in die Materialtabelle. Verglasung (Deckkraft < 1) bekommt `glass: true`. Dachschichten
// bekommen je Baustoff ein eigenes Material (`splitRoofMaterials`), das Gelände die Wiese `Grass005`, jedes Material seine
// Verwendung (`role`, aus dem Knoten des GLB) — der Leser wählt danach Ersatzlooks ohne Bildkarte.
//
// Das Format ist renderer-neutral und in `doc/RENDER-SZENE.md` beschrieben (Blender-Skript = ein Leser davon;
// später auch Cycles-Standalone, [215]).
//
// Achsen in `scene.json`: Modell-Koordinaten (x Ost, y Nord, z oben, Meter) — Blenders glTF-Import dreht das
// Y-oben-GLB genau dorthin zurück, Kamera und Sonne brauchen im Skript keine Umrechnung.

import type { Camera, ComponentMaterial, LayoutOrientation, LayoutPaperFormat, Project } from "../model/types";
import { projectLatLon, sunPosition } from "../analysis/sun";
import { sheetSizeMm } from "../model/layoutModel";
import { exportGlb } from "./exportMesh";

/** Kamera in Modell-Koordinaten (gleiche Form wie `ViewCamera` der 3D-Ansicht, `viewport/cameraBridge.ts`). */
export interface RenderCamera {
  kind: "perspective" | "orthogonal";
  position: [number, number, number];
  /** Blickrichtung, normiert. */
  direction: [number, number, number];
  up: [number, number, number];
  /** Vertikaler Öffnungswinkel in Grad (perspektivisch). */
  fovDeg: number;
  /** Sichthöhe in Metern (orthografisch). */
  orthoHeight: number;
}

/** Voreingestellte Blickrichtungen; das Skript rahmt das Modell selbst ein (Ortho ausser `perspective`). */
export const RENDER_VIEW_PRESETS = ["iso", "perspective", "front", "back", "left", "right", "side", "top"] as const;
export type RenderViewPreset = (typeof RENDER_VIEW_PRESETS)[number];

export type RenderCameraSpec = { preset: RenderViewPreset } | RenderCamera;

/** Vorgaben für Bildgrössen im Dialog. */
export interface RenderSizePreset {
  id: string;
  width: number;
  height: number;
}

export const RENDER_SIZE_PRESETS: RenderSizePreset[] = [
  { id: "hd", width: 1920, height: 1080 },
  { id: "uhd", width: 3840, height: 2160 },
  { id: "square", width: 2400, height: 2400 },
];

/** Qualitätsstufen = Samples je Pixel (Cycles, mit Denoiser). */
export const RENDER_QUALITY_PRESETS = [
  { id: "draft", samples: 32 },
  { id: "normal", samples: 128 },
  { id: "high", samples: 512 },
  { id: "final", samples: 1536 },
] as const;

/** Grösse eines Papierformats in Pixeln bei `dpi` (z. B. A3 quer bei 300 dpi = 4961 × 3508). */
export function paperPixels(paper: LayoutPaperFormat, orientation: LayoutOrientation, dpi: number): { width: number; height: number } {
  const { w, h } = sheetSizeMm(paper, orientation);
  return { width: Math.max(1, Math.round((w / 25.4) * dpi)), height: Math.max(1, Math.round((h / 25.4) * dpi)) };
}

export interface RenderOptions {
  width: number;
  height: number;
  samples: number;
  /** Zeitpunkt der Sonne (Datum, UTC-basiert wie `SunStudy.when`). */
  when: Date;
  /** Kamera der aktiven 3D-Ansicht oder eine Voreinstellung. */
  camera: RenderCameraSpec;
  /** Entrauschen (Standard: an). */
  denoise?: boolean;
  /** `cpu` erzwingt die CPU, sonst GPU wenn vorhanden. */
  device?: "auto" | "cpu";
}

/** Eintrag der Materialtabelle in `scene.json`. */
export interface RenderMaterial {
  /** glTF-Materialname (= Bauteilname). */
  name: string;
  /** Basisfarbe sRGB 0..1. */
  color: [number, number, number];
  opacity: number;
  roughness: number;
  metallic: number;
  /** Verglasung: der Leser ersetzt Alpha durch Transmission. */
  glass: boolean;
  /** Transmission 0..1 (Glas 1, sonst 0), Brechungsindex. Renderer-neutral: jeder Leser setzt sie in sein PBR-Material. */
  transmission: number;
  ior: number;
  /** Dateien relativ zu `scene.json`, nach Karte. */
  textures?: Partial<Record<TextureKind, string>>;
  /** Kantenlänge einer Texturkachel in Metern. */
  sizeM?: number;
  /** Wofür das Material gebraucht wird (aus dem Bauteil-Knoten des GLB); der Leser wählt danach Ersatzlooks (Wiese, Ziegel, Kontext). */
  role?: RenderRole;
  /** Name des Bauteils (Baustoff), dessen Aussehen gilt, wenn er vom Materialnamen abweicht (Dachschicht: `Dach: Tonziegel`). */
  component?: string;
}

/** Verwendung eines Materials: Gelände, Dach, Kontext-Körper (Nachbarn), Öffnungsteile, sonst Gebäude. */
export type RenderRole = "terrain" | "roof" | "context" | "opening" | "building";

export type TextureKind = "color" | "normal" | "roughness" | "metalness";
const TEXTURE_KINDS: TextureKind[] = ["color", "normal", "roughness", "metalness"];

export interface RenderScene {
  version: 1;
  /** Name des Projekts (für Dateinamen und Metadaten). */
  project: string;
  model: string;
  output: string;
  resolution: { width: number; height: number };
  samples: number;
  denoise: boolean;
  device: "auto" | "cpu";
  camera: RenderCameraSpec;
  sun: { azimuth: number; elevation: number; when: string; lat: number; lon: number };
  materials: RenderMaterial[];
}

/** Sonnenstand aus Ort (`geoAnchor`) und Zeit — dieselbe Rechnung wie Lageplan und 3D-Schatten. */
export function renderSun(project: Project, when: Date): RenderScene["sun"] {
  const { lat, lon } = projectLatLon(project);
  const s = sunPosition(lat, lon, when);
  return { azimuth: s.azimuth, elevation: s.elevation, when: when.toISOString(), lat, lon };
}

/** Vorbelegung des Dialogs: Zeit der Sonnenstudie, sonst Mittsommer 14 Uhr (UTC+2 ≈ 12:00 UTC). */
export function defaultRenderTime(project: Project): Date {
  const w = project.sunStudy ? new Date(project.sunStudy.when) : null;
  return w && Number.isFinite(w.getTime()) ? w : new Date(Date.UTC(2026, 5, 21, 12, 0, 0));
}

/** JSON-Chunk eines GLB. */
function glbJson(glb: Uint8Array): GltfJson {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error("Kein GLB");
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + len)));
}

interface GltfMaterial {
  name?: string;
  alphaMode?: string;
  extras?: { component?: string };
  pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number };
}

interface GltfJson {
  materials?: GltfMaterial[];
  meshes?: { name?: string; primitives: { material?: number }[] }[];
  nodes?: { name?: string; mesh?: number; extras?: { type?: string; id?: string } }[];
}

/** GLB mit geändertem JSON-Chunk (BIN-Chunk unverändert; Länge auf 4 Byte aufgefüllt). */
function glbWithJson(glb: Uint8Array, json: GltfJson): Uint8Array {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  const oldLen = dv.getUint32(12, true);
  const rest = glb.subarray(20 + oldLen);
  const bytes = new TextEncoder().encode(JSON.stringify(json));
  const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4).fill(0x20);
  padded.set(bytes);
  const out = new Uint8Array(20 + padded.length + rest.length);
  const odv = new DataView(out.buffer);
  out.set(glb.subarray(0, 4), 0);
  odv.setUint32(4, dv.getUint32(4, true), true);
  odv.setUint32(8, out.length, true);
  odv.setUint32(12, padded.length, true);
  out.set(glb.subarray(16, 20), 16);
  out.set(padded, 20);
  out.set(rest, 20 + padded.length);
  return out;
}

const linearToSrgb = (c: number): number => {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
};

const hexToLinear = (hex: string): [number, number, number] | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const c = (i: number) => {
    const v = parseInt(m[1].slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return [c(0), c(2), c(4)];
};

/**
 * Dachschichten als eigene Materialien. Der Kern legt alle Dachteile unter den Namen „Dach" ab (gleiche Farbe =
 * ein Material), darum hängt „Ziegel" am selben Material wie „Kies", und Texturen lassen sich nicht zuordnen.
 * Hier bekommt jedes Dach-Teilnetz ein Material `Dach: <Baustoff>`: die Schicht des Dachtyps (aussen → innen),
 * deren Baustoff-Farbe die des Teilnetzes ist (sichtbar ist die äusserste), Rückfall die äusserste Schicht.
 * Hat das Dach eine eigene Farbe (`Roof.color`), bleibt es bei dieser (ohne Baustoff-Textur).
 */
export function splitRoofMaterials(glb: Uint8Array, project: Project): Uint8Array {
  const json = glbJson(glb);
  const mats = json.materials ?? [];
  const roofById = new Map((project.roofs ?? []).map((r) => [r.id, r]));
  const made = new Map<string, number>();
  let changed = false;
  for (const node of json.nodes ?? []) {
    if (node.extras?.type !== "roof" || node.mesh === undefined) continue;
    const roof = roofById.get(node.extras.id ?? "");
    const type = roof?.roofTypeId ? project.roofTypes?.find((t) => t.id === roof.roofTypeId) : undefined;
    if (!roof || roof.color || !type || type.layers.length === 0) continue;
    const layers = type.layers.map((l) => project.components.find((c) => c.id === l.componentId)).filter((c): c is NonNullable<typeof c> => !!c);
    if (layers.length === 0) continue;
    for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
      const src = prim.material === undefined ? undefined : mats[prim.material];
      if (!src || src.name !== "Dach") continue;
      const f = src.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
      const close = (a: [number, number, number] | null) => a !== null && Math.abs(a[0] - f[0]) + Math.abs(a[1] - f[1]) + Math.abs(a[2] - f[2]) < 0.02;
      const comp = layers.find((c) => close(hexToLinear(c.color))) ?? layers[0];
      const key = `${comp.name}|${prim.material}`;
      let idx = made.get(key);
      if (idx === undefined) {
        idx = mats.length;
        mats.push({ ...src, name: `Dach: ${comp.name}`, extras: { component: comp.name } });
        made.set(key, idx);
      }
      prim.material = idx;
      changed = true;
    }
  }
  return changed ? glbWithJson(glb, { ...json, materials: mats }) : glb;
}

/** Verwendung je Material aus den Knoten (`extras.type`); bei mehreren gewinnt Gelände vor Kontext, Dach, Öffnung, Gebäude. */
const ROLE_PRIORITY: RenderRole[] = ["terrain", "context", "roof", "opening", "building"];
function roleOfNode(type: string | undefined): RenderRole {
  switch (type) {
    case "terrain":
      return "terrain";
    case "context":
      return "context";
    case "roof":
      return "roof";
    case "window":
    case "door":
    case "opening":
      return "opening";
    default:
      return "building";
  }
}

/** Materialien eines GLB (glTF speichert die Farbe linear, hier sRGB), mit Verwendung; nicht benutzte entfallen. */
export function glbMaterials(glb: Uint8Array): RenderMaterial[] {
  const json = glbJson(glb);
  const roles = new Map<number, RenderRole>();
  for (const node of json.nodes ?? []) {
    if (node.mesh === undefined) continue;
    const role = roleOfNode(node.extras?.type);
    for (const prim of json.meshes?.[node.mesh]?.primitives ?? []) {
      if (prim.material === undefined) continue;
      const prev = roles.get(prim.material);
      if (!prev || ROLE_PRIORITY.indexOf(role) < ROLE_PRIORITY.indexOf(prev)) roles.set(prim.material, role);
    }
  }
  const out: RenderMaterial[] = [];
  (json.materials ?? []).forEach((m, i) => {
    const p = m.pbrMetallicRoughness ?? {};
    const f = p.baseColorFactor ?? [1, 1, 1, 1];
    const opacity = f[3] ?? 1;
    const glass = m.alphaMode === "BLEND" && opacity < 1;
    const used = roles.get(i);
    // Materialien ohne Knoten (Altlasten nach `splitRoofMaterials`) lässt der Leser weg; ohne Knotenangaben (GLB fremder Herkunft) bleiben alle.
    if (!used && roles.size > 0) return;
    out.push({
      name: m.name ?? "",
      color: [linearToSrgb(f[0] ?? 1), linearToSrgb(f[1] ?? 1), linearToSrgb(f[2] ?? 1)],
      opacity,
      roughness: p.roughnessFactor ?? 0.9,
      metallic: p.metallicFactor ?? 0,
      glass,
      transmission: glass ? 1 : 0,
      ior: 1.5,
      ...(used ? { role: used } : {}),
      ...(m.extras?.component ? { component: m.extras.component } : {}),
    });
  });
  return out;
}

/** Liest Bilddateien (URL aus dem Material-System → Bytes) oder liefert null, wenn nicht erreichbar. */
export type TextureLoader = (url: string) => Promise<Uint8Array | null>;

export interface RenderPackage {
  scene: RenderScene;
  /** Dateien des Pakets (relative Pfade), `scene.json` und `model.glb` eingeschlossen. */
  files: { path: string; bytes: Uint8Array }[];
  /** URLs, die sich nicht laden liessen (Hinweis an den Nutzer; Rendering läuft mit Grundfarbe). */
  missingTextures: string[];
}

function extensionOf(url: string): string {
  const m = /\.([a-z0-9]{2,4})(?:[?#].*)?$/i.exec(url);
  return m ? m[1].toLowerCase() : "jpg";
}

/** Wiese für das Gelände (ambientCG Grass005, im Material-Katalog `public/assets/materials`); Kachel 4 m. */
export const TERRAIN_MATERIAL: ComponentMaterial = {
  libraryId: "Grass005",
  color: "/assets/materials/Grass005/color.jpg",
  normal: "/assets/materials/Grass005/normal.jpg",
  roughness: "/assets/materials/Grass005/roughness.jpg",
  sizeM: 4,
};

/** Bauteil-Materialkarten nach glTF-Materialname (erste Komponente gleichen Namens mit Farbkarte gewinnt). */
function componentMaterials(project: Project): Map<string, ComponentMaterial> {
  const byName = new Map<string, ComponentMaterial>();
  for (const c of project.components ?? []) {
    if (c.material?.color && !byName.has(c.name)) byName.set(c.name, c.material);
  }
  return byName;
}

/**
 * Baut das Export-Paket für Blender: GLB, Materialtabelle (mit Texturen, soweit `loadTexture` sie liefert),
 * Kamera, Sonne. Verlangt das geladene Format-Modul (`await loadFileio()`) und den Kern.
 */
export async function buildRenderPackage(project: Project, opts: RenderOptions, loadTexture?: TextureLoader): Promise<RenderPackage> {
  const glb = splitRoofMaterials(exportGlb(project), project);
  const files: RenderPackage["files"] = [{ path: "model.glb", bytes: glb }];
  const materials = glbMaterials(glb);
  const comp = componentMaterials(project);
  const missing: string[] = [];
  const stored = new Map<string, string>();

  for (const mat of materials) {
    // Gelände hat im Modell kein Material: Wiese aus der mitgelieferten Bibliothek (ohne Bildkarten übernimmt der Leser eine Wiesenfarbe).
    const cm = mat.role === "terrain" ? TERRAIN_MATERIAL : comp.get(mat.component ?? mat.name);
    if (!cm || mat.glass || !loadTexture) continue;
    const textures: Partial<Record<TextureKind, string>> = {};
    for (const kind of TEXTURE_KINDS) {
      const url = cm[kind];
      if (!url) continue;
      let path = stored.get(url);
      if (!path) {
        const bytes = await loadTexture(url).catch(() => null);
        if (!bytes || bytes.length === 0) {
          if (!missing.includes(url)) missing.push(url);
          continue;
        }
        path = `textures/${stored.size}_${kind}.${extensionOf(url)}`;
        stored.set(url, path);
        files.push({ path, bytes });
      }
      textures[kind] = path;
    }
    if (textures.color) {
      mat.textures = textures;
      mat.sizeM = cm.sizeM && cm.sizeM > 0 ? cm.sizeM : 1;
    }
  }

  const scene: RenderScene = {
    version: 1,
    project: project.name || "projekt",
    model: "model.glb",
    output: "render.png",
    resolution: { width: Math.round(opts.width), height: Math.round(opts.height) },
    samples: Math.max(1, Math.round(opts.samples)),
    denoise: opts.denoise ?? true,
    device: opts.device ?? "auto",
    camera: opts.camera,
    sun: renderSun(project, opts.when),
    materials,
  };
  files.push({ path: "scene.json", bytes: new TextEncoder().encode(JSON.stringify(scene, null, 2)) });
  return { scene, files, missingTextures: missing };
}

// ── Kameras ([213]) ─────────────────────────────────────────────────────────

/** Eine gespeicherte Kamera (`Project.cameras`) als Rendering-Kamera, mit ihrer Sonnenzeit. */
export interface RenderCameraChoice {
  id: string;
  name: string;
  camera: RenderCamera;
  /** `Camera.sunWhen`, falls gesetzt und gültig. */
  sunWhen?: Date;
}

/**
 * Sicht einer Kamera in Modell-Koordinaten: Standpunkt = Fussboden des Geschosses + Augenhöhe, Blick zum Ziel,
 * Up aus der Senkrechten (bei senkrechtem Blick Norden). Gleiche Rechnung wie `viewport/cameraView.ts::cameraToView`
 * (der Kern darf den Viewport nicht importieren; der Test vergleicht beide). Null bei Standpunkt = Ziel.
 */
export function renderCameraOf(project: Project, cam: Camera): RenderCamera | null {
  const base = project.drawingLevels.find((l) => l.id === cam.floorId)?.baseElevation;
  const eye: [number, number, number] = [cam.position.x, cam.position.y, (typeof base === "number" && Number.isFinite(base) ? base : 0) + (Number.isFinite(cam.eyeHeight) ? cam.eyeHeight : 1.6)];
  const tgt: [number, number, number] = [cam.target.x, cam.target.y, cam.targetHeight];
  if (![...eye, ...tgt].every(Number.isFinite)) return null;
  const d = [tgt[0] - eye[0], tgt[1] - eye[1], tgt[2] - eye[2]];
  const len = Math.hypot(d[0], d[1], d[2]);
  if (!(len > 1e-9)) return null;
  const dir: [number, number, number] = [d[0] / len, d[1] / len, d[2] / len];
  const ref = Math.abs(dir[2]) > 0.9999 ? [0, 1, 0] : [0, 0, 1];
  const k = ref[0] * dir[0] + ref[1] * dir[1] + ref[2] * dir[2];
  const u = [ref[0] - dir[0] * k, ref[1] - dir[1] * k, ref[2] - dir[2] * k];
  const ul = Math.hypot(u[0], u[1], u[2]);
  const fov = Number.isFinite(cam.fovDeg) && cam.fovDeg > 0 ? Math.min(120, Math.max(5, cam.fovDeg)) : 50;
  return {
    kind: cam.projection === "perspective" ? "perspective" : "orthogonal",
    position: eye,
    direction: dir,
    up: [u[0] / ul, u[1] / ul, u[2] / ul],
    fovDeg: fov,
    orthoHeight: cam.orthoHeight && cam.orthoHeight > 0 ? cam.orthoHeight : 10,
  };
}

/** Alle brauchbaren Kameras des Projekts in Listenreihenfolge. */
export function projectRenderCameras(project: Project): RenderCameraChoice[] {
  const out: RenderCameraChoice[] = [];
  for (const c of project.cameras ?? []) {
    const camera = renderCameraOf(project, c);
    if (!camera) continue;
    const w = c.sunWhen ? new Date(c.sunWhen) : null;
    out.push({ id: c.id, name: c.name, camera, ...(w && Number.isFinite(w.getTime()) ? { sunWhen: w } : {}) });
  }
  return out;
}

/** Kamera nach Id oder Name (Gross-/Kleinschreibung egal; bei gleichem Namen die erste). */
export function findRenderCamera(project: Project, key: string): RenderCameraChoice | null {
  const all = projectRenderCameras(project);
  const k = key.trim().toLowerCase();
  return all.find((c) => c.id === key) ?? all.find((c) => c.name.toLowerCase() === k) ?? null;
}

// ── Blender-Ausgabe lesen ───────────────────────────────────────────────────

export type BlenderEvent =
  | { kind: "sample"; done: number; total: number }
  | { kind: "stage"; stage: string }
  | { kind: "done"; path: string }
  | { kind: "error"; message: string }
  | { kind: "note"; message: string };

/** Eine Ausgabezeile von Blender: Cycles meldet `… | Sample 16/128`, das Skript die `DOSSIER_*`-Marken. */
export function parseBlenderLine(line: string): BlenderEvent | null {
  const s = /\bSample\s+(\d+)\s*\/\s*(\d+)/.exec(line);
  if (s) return { kind: "sample", done: Number(s[1]), total: Number(s[2]) };
  const m = /^DOSSIER_(STAGE|DONE|ERROR|NOTE)\s+(.*)$/.exec(line.trim());
  if (!m) return null;
  const text = m[2].trim();
  switch (m[1]) {
    case "STAGE":
      return { kind: "stage", stage: text };
    case "DONE":
      return { kind: "done", path: text };
    case "ERROR":
      return { kind: "error", message: text };
    default:
      return { kind: "note", message: text };
  }
}

/** Kommandozeile von Blender für das Skript (Hintergrund, Fehler im Skript = Exit-Code 1). */
export function blenderArgs(scriptPath: string, scenePath: string): string[] {
  return ["-b", "--python-exit-code", "1", "--python", scriptPath, "--", scenePath];
}

/** Aufruf-Gastgeber (Tauri, Electron, Node): alles, was nur ein Prozess/Dateisystem kann. */
export interface BlenderHost {
  /** Pfad der Blender-Programmdatei (eigene Angabe zuerst, dann übliche Orte), oder null. */
  find(custom?: string): Promise<string | null>;
  /** Legt einen neuen Arbeitsordner an, schreibt die Dateien hinein, gibt den Ordner zurück. */
  prepare(files: { path: string; bytes: Uint8Array }[]): Promise<string>;
  /** Startet Blender; `onLine` für jede Ausgabezeile (stdout und stderr). */
  spawn(exe: string, args: string[], onLine: (line: string) => void): { done: Promise<number>; cancel(): void };
  readFile(path: string): Promise<Uint8Array>;
  /** Pfad zu `dir/rel`. */
  join(dir: string, rel: string): string;
}

export class BlenderMissingError extends Error {
  constructor() {
    super("Blender nicht gefunden");
    this.name = "BlenderMissingError";
  }
}

export class RenderCancelled extends Error {
  constructor() {
    super("Rendering abgebrochen");
    this.name = "RenderCancelled";
  }
}

export interface RenderRunOptions {
  /** Eigener Blender-Pfad (Einstellungen). */
  blenderPath?: string;
  /** Text des Python-Skripts (`scripts/blender/render_dossier.py`). */
  script: string;
  /** Fortschritt 0..1 (Samples) und Phase. */
  onProgress?: (e: { fraction: number; stage: string; done: number; total: number }) => void;
  /** Rohausgabe von Blender (für Fehlermeldungen/Protokoll). */
  onLine?: (line: string) => void;
  signal?: AbortSignal;
}

export interface RenderResult {
  png: Uint8Array;
  dir: string;
  path: string;
}

/**
 * Packt das Paket aus, startet Blender, meldet den Fortschritt und liest das Bild. Wirft
 * {@link BlenderMissingError}, {@link RenderCancelled} oder einen Fehler mit der Meldung des Skripts.
 */
export async function runBlenderRender(host: BlenderHost, pkg: RenderPackage, opts: RenderRunOptions): Promise<RenderResult> {
  const exe = await host.find(opts.blenderPath);
  if (!exe) throw new BlenderMissingError();
  const dir = await host.prepare([...pkg.files, { path: "render_dossier.py", bytes: new TextEncoder().encode(opts.script) }]);
  const scenePath = host.join(dir, "scene.json");
  let stage = "import";
  let error = "";
  let lastLines: string[] = [];
  const total = pkg.scene.samples;
  const job = host.spawn(exe, blenderArgs(host.join(dir, "render_dossier.py"), scenePath), (line) => {
    opts.onLine?.(line);
    lastLines.push(line);
    if (lastLines.length > 12) lastLines = lastLines.slice(-12);
    const ev = parseBlenderLine(line);
    if (!ev) return;
    if (ev.kind === "stage") {
      stage = ev.stage;
      opts.onProgress?.({ fraction: 0, stage, done: 0, total });
    } else if (ev.kind === "sample") {
      opts.onProgress?.({ fraction: ev.total > 0 ? Math.min(1, ev.done / ev.total) : 0, stage: "render", done: ev.done, total: ev.total });
    } else if (ev.kind === "error") {
      error = ev.message;
    }
  });
  const onAbort = () => job.cancel();
  opts.signal?.addEventListener("abort", onAbort);
  if (opts.signal?.aborted) job.cancel();
  let code: number;
  try {
    code = await job.done;
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
  if (opts.signal?.aborted) throw new RenderCancelled();
  if (code !== 0) throw new Error(error || `Blender beendet mit Code ${code}: ${lastLines.slice(-3).join(" | ")}`);
  const path = host.join(dir, pkg.scene.output);
  const png = await host.readFile(path).catch(() => null);
  if (!png || png.length === 0) throw new Error(error || "Blender hat kein Bild geschrieben");
  opts.onProgress?.({ fraction: 1, stage: "done", done: total, total });
  return { png, dir, path };
}

/** Übliche Blender-Orte, in Suchreihenfolge (macOS-App, Linux-Pakete). `blender` im PATH prüft der Gastgeber zuerst. */
export const BLENDER_CANDIDATES = [
  "/Applications/Blender.app/Contents/MacOS/Blender",
  "/usr/bin/blender",
  "/usr/local/bin/blender",
  "/snap/bin/blender",
  "/var/lib/flatpak/exports/bin/org.blender.Blender",
];

/** Download-Seite für den Hinweis ohne Blender. */
export const BLENDER_DOWNLOAD_URL = "https://www.blender.org/download/";

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
// Karten) kommt als Textur-Eintrag in die Materialtabelle. Verglasung (Deckkraft < 1) bekommt `glass: true`.
//
// Das Format ist renderer-neutral und in `doc/RENDER-SZENE.md` beschrieben (Blender-Skript = ein Leser davon;
// später auch Cycles-Standalone, [215]).
//
// Achsen in `scene.json`: Modell-Koordinaten (x Ost, y Nord, z oben, Meter) — Blenders glTF-Import dreht das
// Y-oben-GLB genau dorthin zurück, Kamera und Sonne brauchen im Skript keine Umrechnung.

import type { ComponentMaterial, LayoutOrientation, LayoutPaperFormat, Project } from "../model/types";
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
}

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
function glbJson(glb: Uint8Array): { materials?: GltfMaterial[] } {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (glb.byteLength < 20 || dv.getUint32(0, true) !== 0x46546c67) throw new Error("Kein GLB");
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + len)));
}

interface GltfMaterial {
  name?: string;
  alphaMode?: string;
  pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number };
}

const linearToSrgb = (c: number): number => {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
};

/** Materialien eines GLB (glTF speichert die Farbe linear, hier sRGB). */
export function glbMaterials(glb: Uint8Array): RenderMaterial[] {
  const out: RenderMaterial[] = [];
  for (const m of glbJson(glb).materials ?? []) {
    const p = m.pbrMetallicRoughness ?? {};
    const f = p.baseColorFactor ?? [1, 1, 1, 1];
    const opacity = f[3] ?? 1;
    out.push({
      name: m.name ?? "",
      color: [linearToSrgb(f[0] ?? 1), linearToSrgb(f[1] ?? 1), linearToSrgb(f[2] ?? 1)],
      opacity,
      roughness: p.roughnessFactor ?? 0.9,
      metallic: p.metallicFactor ?? 0,
      glass: m.alphaMode === "BLEND" && opacity < 1,
      transmission: m.alphaMode === "BLEND" && opacity < 1 ? 1 : 0,
      ior: m.alphaMode === "BLEND" && opacity < 1 ? 1.45 : 1.5,
    });
  }
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
  const glb = exportGlb(project);
  const files: RenderPackage["files"] = [{ path: "model.glb", bytes: glb }];
  const materials = glbMaterials(glb);
  const comp = componentMaterials(project);
  const missing: string[] = [];
  const stored = new Map<string, string>();

  for (const mat of materials) {
    const cm = comp.get(mat.name);
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

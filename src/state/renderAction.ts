// [211] Rendering mit Blender/Cycles aus der App: Kamera der aktiven 3D-Ansicht, Paket bauen, Blender starten
// (Tauri/Electron) oder das Paket als ZIP anbieten (Browser). Die Teile ohne Oberfläche, damit der Dialog
// (`ui/RenderDialog.tsx`) dünn bleibt und sich vitest-bar prüfen lässt.

import JSZip from "jszip";
import {
  BlenderMissingError,
  buildRenderPackage,
  loadFileio,
  runBlenderRender,
  type RenderCameraSpec,
  type RenderOptions,
  type RenderPackage,
  type RenderResult,
  type RenderViewPreset,
  type TextureLoader,
} from "../core";
import type { BlenderHost } from "../core";
import type { Project } from "../model/types";
import type { View3d } from "../model/viewTypes";
import { netFetch } from "../net/net";
import { blenderHost } from "../native/blender";
import { RENDER_SCRIPT } from "../native/blenderScript";
import { getCamera } from "../viewport/cameraBridge";
import { getBlenderPath } from "./blenderSettings";
import { getState } from "./appStore";
import { t } from "../i18n";

/** Voreinstellung der Blickrichtung zur gewählten 3D-Ansicht (Ansichtsleiste). */
export function presetForView3d(view: View3d): RenderViewPreset {
  switch (view) {
    case "front":
    case "back":
    case "side":
    case "left":
    case "top":
    case "perspective":
      return view;
    default:
      return "iso";
  }
}

/** Kamera der aktiven 3D-Ansicht (frei gedreht oder Voreinstellung); ohne Viewport (nativer Pfad) die Voreinstellung. */
export function currentRenderCamera(view: View3d = getState().view3d): RenderCameraSpec {
  const cam = getCamera();
  if (cam) {
    return { kind: cam.kind, position: cam.position, direction: cam.direction, up: cam.up, fovDeg: cam.fovDeg, orthoHeight: cam.orthoHeight };
  }
  return { preset: presetForView3d(view) };
}

/** Bytes einer Bildkarte: mitgelieferte (`/assets/…`) und Blob-URLs direkt, Web-Adressen über `netFetch`. */
export const loadTextureBytes: TextureLoader = async (url) => {
  try {
    const res = await netFetch(url); // lokale Pfade lässt netFetch ohne Prüfung durch
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
};

export interface RenderRequest extends Omit<RenderOptions, "camera"> {
  camera: RenderCameraSpec;
}

/** Baut das Export-Paket des Projekts für Blender (lädt dafür das Format-Modul). */
export async function buildPackage(project: Project, req: RenderRequest): Promise<RenderPackage> {
  await loadFileio();
  return buildRenderPackage(project, req, loadTextureBytes);
}

/** Rendert über ein installiertes Blender. Wirft `BlenderMissingError`, `RenderCancelled` oder Fehler des Skripts. */
export async function renderWithBlender(
  host: BlenderHost,
  pkg: RenderPackage,
  hooks: { onProgress?: (e: { fraction: number; stage: string; done: number; total: number }) => void; onLine?: (l: string) => void; signal?: AbortSignal },
): Promise<RenderResult> {
  return runBlenderRender(host, pkg, { script: RENDER_SCRIPT, blenderPath: getBlenderPath(), ...hooks });
}

/** Ob in dieser Umgebung ein Blender gesucht werden kann (Tauri/Electron); im Browser nicht. */
export async function renderHost(): Promise<BlenderHost | null> {
  return blenderHost();
}

/** Anleitung im ZIP des Browsers (Sprache der Oberfläche). */
function zipReadme(): string {
  return [t("render.zip.readme.title"), "", t("render.zip.readme.steps"), "", "    blender -b --python render_dossier.py -- scene.json", "", t("render.zip.readme.result")].join("\n");
}

/** Browser: Paket + Skript + Anleitung als ZIP (Blender läuft dort nicht von der Seite aus). */
export async function packageAsZip(pkg: RenderPackage): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const f of pkg.files) zip.file(f.path, f.bytes);
  zip.file("render_dossier.py", RENDER_SCRIPT);
  zip.file("README.txt", zipReadme());
  return zip.generateAsync({ type: "uint8array" });
}

export { BlenderMissingError };

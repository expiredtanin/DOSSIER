// Compute-Grenze: der EINE Einstiegspunkt für rechenintensive Operationen.
// Läuft die App unter Tauri, werden Ops an einen Rust-`#[tauri::command]`
// geroutet; sonst greift die bestehende TS-Implementierung. In dieser PoC ist
// nur `computeJoins` real an Rust angebunden — die übrigen Funktionen sind
// dünne Pass-throughs auf ihre TS-Impls (Grenze etabliert, Migration
// inkrementell).

import type { Project, Wall } from "../model/types";
import { getWallType, wallTypeThickness } from "../model/types";
import { wallReferenceOffset } from "../model/wall";
import { computeJoins as computeJoinsTS } from "../model/joins";
import type { WallCuts } from "../model/joins";
import type { Line } from "../model/geometry";
import { detectRooms as detectRoomsTS } from "../geometry/roomBoundary";
import type { WallSegment, DetectRoomsOptions } from "../geometry/roomBoundary";
import { parseDwg as parseDwgTS } from "../io/dwgParser";
import type { DxfImportResult } from "../io/dxfParser";
import type { Vec2 } from "../model/types";

// Tauri-invoke, wenn vorhanden — sonst null (Browser/kein Tauri). Dynamischer,
// GEGUARDETER Import, damit der Build ohne @tauri-apps/api grün bleibt.
async function tauriInvoke<T>(cmd: string, args: Record<string, unknown>): Promise<T | null> {
  try {
    // @ts-ignore optionales Paket
    const mod = await import(/* @vite-ignore */ "@tauri-apps/api/core").catch(() => null);
    if (!mod || typeof (mod as any).invoke !== "function") return null;
    return await (mod as any).invoke(cmd, args) as T;
  } catch {
    return null;
  }
}

/** Serialisierbare Wand-Repräsentation für den Rust-Kern. */
interface FlatWall {
  id: string;
  start: Vec2;
  end: Vec2;
  thickness: number;
  referenceOffset: number;
}

/** Rohantwort des Rust-Befehls `compute_joins`. */
interface RustWallCut {
  wallId: string;
  startCut: Line | null;
  endCut: Line | null;
}

/**
 * Gehrungs-Schnittlinien pro Wand. Unter Tauri via Rust-Kern, sonst TS-Fallback.
 * Die Signatur ist synchron-kompatibel zur TS-Impl, aber async (Rust-Aufruf).
 */
export async function computeJoins(
  project: Project,
  walls: Wall[],
): Promise<Map<string, WallCuts>> {
  try {
    const flattened: FlatWall[] = walls.map((w) => {
      const thickness = wallTypeThickness(getWallType(project, w));
      return {
        id: w.id,
        start: w.start,
        end: w.end,
        thickness,
        referenceOffset: wallReferenceOffset(w, thickness),
      };
    });

    const res = await tauriInvoke<RustWallCut[]>("compute_joins", {
      input: { walls: flattened },
    });
    if (res != null) {
      const map = new Map<string, WallCuts>();
      for (const c of res) {
        map.set(c.wallId, { startCut: c.startCut, endCut: c.endCut });
      }
      return map;
    }
  } catch {
    // fällt unten in den TS-Pfad
  }
  console.warn("Rust compute_joins nicht verfügbar, TS-Fallback");
  return computeJoinsTS(project, walls);
}

// ── Pass-throughs (noch reines TS; bereit für spätere Rust-Migration) ─────────

/** Raumerkennung aus Wandsegmenten. Aktuell TS; Grenze für spätere Migration. */
export async function detectRooms(
  walls: WallSegment[],
  options: DetectRoomsOptions = {},
): Promise<Vec2[][]> {
  return detectRoomsTS(walls, options);
}

/** DWG-Import (LibreDWG-WASM). Aktuell TS; Grenze für spätere Migration. */
export async function parseShapeFromDwg(
  data: ArrayBuffer,
): Promise<DxfImportResult> {
  return parseDwgTS(data);
}

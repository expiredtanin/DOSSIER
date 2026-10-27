// Treppen-Domäne der 3D-Ableitung: emittiert Treppen als extrudierte RSlabs
// (Tritte + Podest, tragart-abhängige Untersicht) — der WASM/wgpu-Renderer
// kennt sonst KEINE Treppen (nur Wände/Decken/Meshes). Für Ortbeton-Läufe
// zusätzlich ein glattes Dreiecks-Mesh der schrägen Laufplatten-Untersicht, und für gerade
// Läufe Handlauf + Pfosten (`StairType.railing`).
//
// Die ganze Rechnung (Tritt-Prismen je Tragart, Nasen-Verlängerung `StairType.nosing`, dünne
// Setzstufen-Platten `closedRisers`, Podest, Soffit-Scheiben im Schnitt, Laufplatten-Mesh,
// Handlauf/Pfosten-Quader) steht in Rust (`src-tauri/core/src/stairs3d.rs`, Treppengeometrie aus
// `kernel2d`). Hier nur: aus dem `Project` sammeln und die Ergebnisse einfärben.
// `ceilingId` trägt bei den Slabs die Treppen-Id (nur TS-seitiges Tagging; render3d ignoriert
// das Feld, und der Pick läuft separat über `pickGeometry`).

import type { Project, Stair, StairType } from "../../model/types";
import { getStairType } from "../../model/types";
import { stairVerticalExtent } from "../../model/wall";
import { encodeStair } from "../../geometry/stair";
import { core } from "../../engine/coreWasm";
import { SLAB_RGB, hexToRgb, type RMesh, type RRgb, type RSlab, type RVec2 } from "./shared";

/** Neutraler Beton-Grauton für Treppen (wie der Three.js-Pfad `addStairMeshes`). */
const STAIR_RGB: RRgb = hexToRgb("#9aa0a6", SLAB_RGB);
/** Neutrales Metallgrau für Handlauf + Pfosten. */
const RAIL_RGB: RRgb = hexToRgb("#74797f", SLAB_RGB);

const STRUCTURE = { massiv: 0, beton: 1, wange: 2, aufgesattelt: 2, spindel: 2 } as const;
const RAILING = { keine: 0, links: 1, rechts: 2, beide: 3 } as const;

/**
 * Flache Rust-Eingabe der Treppen (Aufbau: `stairs3d.rs`); `null` ohne Treppen. `wanted` wählt
 * nur vor, welche Treppen sich lohnen (spart den WASM-Aufruf); die Regeln selbst prüft Rust.
 */
function stairInput(
  project: Project,
  wanted: (stair: Stair, st: StairType | undefined) => boolean = () => true,
): { stairs: Stair[]; buf: Float64Array } | null {
  const stairs: Stair[] = [];
  const types: (StairType | undefined)[] = [];
  for (const stair of project.stairs ?? []) {
    const st = getStairType(project, stair);
    if (!wanted(stair, st)) continue;
    stairs.push(stair);
    types.push(st);
  }
  if (stairs.length === 0) return null;
  const buf = new Float64Array(1 + 23 * stairs.length);
  buf[0] = stairs.length;
  stairs.forEach((stair, k) => {
    const { zBottom, zTop } = stairVerticalExtent(project, stair);
    const st = types[k];
    const o = 1 + 23 * k;
    buf.set(encodeStair(stair), o);
    buf[o + 16] = zBottom;
    buf[o + 17] = zTop;
    buf[o + 18] = STRUCTURE[st?.structure ?? "massiv"] ?? 2;
    buf[o + 19] = st?.treadThickness ?? 0.04;
    buf[o + 20] = st?.nosing ?? 0;
    buf[o + 21] = st?.closedRisers ? 1 : 0;
    buf[o + 22] = RAILING[st?.railing ?? "keine"] ?? 0;
  });
  return { stairs, buf };
}

/** Rust-Meshes `[n, (treppe, nPos, nIdx, positionen…, indizes…)…]` → `RMesh[]`. */
function meshesOf(f: Float64Array, color: RRgb): RMesh[] {
  const out: RMesh[] = [];
  let i = 1;
  for (let n = f.length ? f[0] : 0; n > 0; n--) {
    const nPos = f[i + 1];
    const nIdx = f[i + 2];
    i += 3;
    const positions: number[] = [];
    for (let k = 0; k < nPos; k++) positions.push(f[i + k]);
    i += nPos;
    const indices: number[] = [];
    for (let k = 0; k < nIdx; k++) indices.push(f[i + k]);
    i += nIdx;
    out.push({ positions, indices, kind: "extrusion", color });
  }
  return out;
}

/**
 * Emittiert Treppen als RSlabs (extrudierte Grundriss-Polygone) — der WASM/wgpu-
 * Renderer kennt sonst KEINE Treppen (nur Wände/Decken/Meshes), sodass Treppen im
 * Standard-3D unsichtbar blieben. Jeder Tritt ist ein extrudiertes Polygon; das
 * ist exakt eine RSlab. Tragart über `getStairType`:
 *  • "massiv" / kein Typ — Vollblock je Tritt von der Treppen-UK bis zur Tritt-OK
 *    (gestuftes Massiv, Treppe auf Erdreich/Sockel).
 *  • "beton" — Ortbeton-Laufplatte: je Tritt ein Block von der SCHRÄGEN Untersicht
 *    (eine Stufe + Laufplattendicke unter der Tritt-OK, an der Treppen-UK gekappt)
 *    bis zur Tritt-OK. Die stufig gestapelten Blöcke bilden die schräge, UNTEN
 *    OFFENE Untersicht der klassischen Betontreppe.
 *  • "wange"/"aufgesattelt"/"spindel" — nur eine dünne Tritt-Platte der Dicke
 *    `treadThickness` an der Tritt-OK, darunter offen.
 * Podest (L/Wendel) als Vollblock bis zur halben Steighöhe. Bei OFFENEN
 * Tragarten wird die Vorderkante jedes Tritts zusätzlich um `StairType.nosing`
 * (Trittkanten-Überstand) verlängert und — bei `StairType.closedRisers` — eine dünne
 * Setzstufen-Platte an der Rückkante ergänzt. Massiv/Beton bilden EIN Körper
 * (`monolith`, s. render3d `SlabInput::monolith`).
 */
export function emitStairs(
  project: Project,
  /**
   * `forSection`: auch gerade Betontreppen als Tritt-Prismen liefern (deren
   * glatte Laufplatte ist im 3D ein Mesh, das der Schnitt-Extraktor nicht
   * schneiden kann — ohne diese Näherung fehlte die Treppe im Schnitt ganz).
   */
  opts: { forSection?: boolean } = {},
): RSlab[] {
  const input = stairInput(project);
  if (!input) return [];
  const f = core().stairs3d_slabs_flat(input.buf, !!opts.forSection);
  const out: RSlab[] = [];
  let i = 1;
  for (let n = f.length ? f[0] : 0; n > 0; n--) {
    const stair = input.stairs[f[i]];
    const monolith = f[i + 1] !== 0;
    const zBottom = f[i + 2];
    const zTop = f[i + 3];
    const nPts = f[i + 4];
    i += 5;
    const outline: RVec2[] = new Array(nPts);
    for (let k = 0; k < nPts; k++, i += 2) outline[k] = [f[i], f[i + 1]];
    out.push({
      outline,
      zBottom,
      zTop,
      color: STAIR_RGB,
      ceilingId: stair.id,
      ...(monolith ? { monolith: stair.id } : {}),
    });
  }
  return out;
}

/**
 * Glatte Ortbeton-Laufplatte (Tragart "beton") als echtes Dreiecks-Mesh — nur für
 * GERADE Läufe. Anders als die stufige Slab-Näherung ({@link emitStairs}) entsteht
 * eine SPIEGELGLATTE schräge Untersicht: je Tritt ein konvexes Prisma mit
 * HORIZONTALER Oberkante (= Trittfläche) und SCHRÄGER Unterkante auf EINER
 * gemeinsamen Soffit-Geraden. Positions in MODELL-Metern (x, y, z=Höhe); render3d bildet
 * nach world (x, z, y) ab.
 */
export function emitStairMeshes(project: Project): RMesh[] {
  // Nur gerade Betontreppen haben eine glatte Laufplatte.
  const input = stairInput(project, (s, st) => st?.structure === "beton" && s.shape === "straight");
  return input ? meshesOf(core().stairs3d_meshes_flat(input.buf), STAIR_RGB) : [];
}

/**
 * Handlauf + Pfosten (`StairType.railing`: "keine"|"links"|"rechts"|"beide"). Nur für GERADE
 * Läufe: dort liegt die Vorderkante jedes Tritts exakt auf der linearen Rampen-Geraden, ein
 * gerades, schräges Segment je Seite + ein Pfosten je Trittvorderkante genügen. L-Läufe und
 * Wendeltreppen bleiben bewusst aussen vor (eigener Folgeschritt).
 */
export function emitStairRailings(project: Project): RMesh[] {
  const input = stairInput(project, (s, st) => s.shape === "straight" && (st?.railing ?? "keine") !== "keine");
  return input ? meshesOf(core().stairs3d_railings_flat(input.buf), RAIL_RGB) : [];
}

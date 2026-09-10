// Treppen-Domäne der 3D-Ableitung: emittiert Treppen als extrudierte RSlabs
// (Tritte + Podest, tragart-abhängige Untersicht) — der WASM/wgpu-Renderer
// kennt sonst KEINE Treppen (nur Wände/Decken/Meshes). Für Ortbeton-Läufe
// zusätzlich ein glattes Dreiecks-Mesh der schrägen Laufplatten-Untersicht.

import type { Project, Vec2 } from "../../model/types";
import { getStairType } from "../../model/types";
import { stairVerticalExtent } from "../../model/wall";
import { stairGeometry } from "../../geometry/stair";
import { leftNormal, normalize } from "../../model/geometry";
import { EPS, SLAB_RGB, hexToRgb, type RMesh, type RRgb, type RSlab, type RVec2 } from "./shared";

/** Neutraler Beton-Grauton für Treppen (wie der Three.js-Pfad `addStairMeshes`). */
const STAIR_RGB: RRgb = hexToRgb("#9aa0a6", SLAB_RGB);

/** Laufplattendicke einer Ortbetontreppe (Meter). */
const CONCRETE_WAIST = 0.18;

/** Schwerpunkt eines Tritt-Polygons (Grundriss). */
function centroidOf(pts: Vec2[]): Vec2 {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

/**
 * Bestimmt die "vordere" Kante eines Tritt-Vielecks (die Kante in Richtung
 * des nächsten Tritts) — für die Nasen-Verlängerung ({@link StairType.nosing}).
 * `target` ist der Schwerpunkt eines Nachbartritts; `preferNear` wählt die dem
 * Ziel NÄCHSTE Kante (Nachbar = nächster Tritt), sonst die FERNSTE (Nachbar =
 * vorheriger Tritt, Vorderkante liegt entgegengesetzt). Liefert die Indizes
 * der beiden Eckpunkte der Vorderkante + deren Richtung (Trittschwerpunkt →
 * Kantenmitte, normiert). Wortgetreu portiert vom Three.js-Pfad
 * (`viewport/viewport3d/meshBuilders.ts::frontEdgeOf`), wo dieselbe Logik
 * bereits für `nosing` verwendet wird.
 */
function frontEdgeOf(
  pts: Vec2[],
  target: Vec2,
  preferNear: boolean,
): { a: number; b: number; dir: Vec2 } {
  const c = centroidOf(pts);
  let best = 0;
  let bestDist = preferNear ? Infinity : -Infinity;
  for (let e = 0; e < pts.length; e++) {
    const p0 = pts[e];
    const p1 = pts[(e + 1) % pts.length];
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const d = Math.hypot(mid.x - target.x, mid.y - target.y);
    if (preferNear ? d < bestDist : d > bestDist) {
      bestDist = d;
      best = e;
    }
  }
  const p0 = pts[best];
  const p1 = pts[(best + 1) % pts.length];
  const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const dx = mid.x - c.x;
  const dy = mid.y - c.y;
  const len = Math.hypot(dx, dy) || 1e-9;
  return { a: best, b: (best + 1) % pts.length, dir: { x: dx / len, y: dy / len } };
}

/**
 * Verlängert die Vorderkante eines Tritts um `nosing` Meter (Trittkanten-
 * Überstand/Nase, {@link StairType.nosing}) — nur bei OFFENEN Tragarten
 * sinnvoll (dünne Tritt-Platte mit sichtbarem Vorstand vor der Setzstufe
 * darunter), daher nur aus dem `structure !== "massiv"`-Zweig aufgerufen.
 */
function withNosing(pts: Vec2[], neighbors: Vec2[][], k: number, nosing: number): Vec2[] {
  if (nosing <= 1e-6) return pts;
  const hasNext = k + 1 < neighbors.length;
  const hasPrev = k > 0;
  const ref = hasNext ? neighbors[k + 1] : hasPrev ? neighbors[k - 1] : null;
  if (!ref) return pts;
  const { a, b, dir } = frontEdgeOf(pts, centroidOf(ref), hasNext);
  const nosed = pts.slice();
  nosed[a] = { x: pts[a].x + dir.x * nosing, y: pts[a].y + dir.y * nosing };
  nosed[b] = { x: pts[b].x + dir.x * nosing, y: pts[b].y + dir.y * nosing };
  return nosed;
}

/**
 * Grundriss einer geschlossenen Setzstufen-Platte ({@link StairType.closedRisers}):
 * eine DÜNNE Fläche an der RÜCKKante des Tritts `k` (= Vorderkante des
 * Vorgängers, Gegenkante zur eigenen Vorderkante), leicht in Vorderkanten-
 * Richtung aufgeweitet, damit ein extrudierbares Vieleck entsteht (statt einer
 * entarteten Linie). `null`, wenn kein Nachbartritt zur Vorderkanten-
 * Bestimmung existiert (Einzeltritt). Wortgetreu portiert vom Three.js-Pfad
 * (`meshBuilders.ts::addStairMeshes`), inkl. der Verwendung der ROHEN
 * (nicht genasten) Trittpunkte — die Nase betrifft nur die Trittplatte selbst.
 */
function closedRiserOutline(
  trPts: Vec2[],
  neighbors: Vec2[][],
  k: number,
  treadThickness: number,
): Vec2[] | null {
  const hasNext = k + 1 < neighbors.length;
  const ref = hasNext ? neighbors[k + 1] : k > 0 ? neighbors[k - 1] : null;
  if (!ref) return null;
  const front = frontEdgeOf(trPts, centroidOf(ref), hasNext);
  const n = trPts.length;
  const backA = (front.a + Math.floor(n / 2)) % n;
  const backB = (front.b + Math.floor(n / 2)) % n;
  const riserA = trPts[backA];
  const riserB = trPts[backB];
  const thin = Math.min(treadThickness, 0.02) || 0.01;
  const offA = { x: riserA.x - front.dir.x * thin, y: riserA.y - front.dir.y * thin };
  const offB = { x: riserB.x - front.dir.x * thin, y: riserB.y - front.dir.y * thin };
  return [riserA, riserB, offB, offA];
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
 * Tragarten (nicht "massiv") wird die Vorderkante jedes Tritts zusätzlich um
 * `StairType.nosing` (Trittkanten-Überstand) verlängert und — bei
 * `StairType.closedRisers` — eine dünne Setzstufen-Platte an der Rückkante
 * ergänzt (sonst bleibt die Treppe dort offen) — wortgetreu wie im Three.js-
 * Pfad, hier ans WASM/wgpu-Default-3D nachgezogen (beide Felder waren dort
 * unwirksam: existierten im Modell + der ResourceManager-UI, aber der
 * Standard-Renderer las sie nie, s. PENDENZEN.md). Geländer sind weiterhin
 * eine Verfeinerung (Three.js-Pfad, dort selbst noch als TODO markiert) —
 * hier zählt zuerst die SICHTBARKEIT.
 * `ceilingId` trägt hier die Treppen-Id (nur TS-seitiges Tagging; render3d ignoriert
 * das Feld, und der Pick läuft separat über `pickGeometry`).
 */
export function emitStairs(project: Project): RSlab[] {
  const out: RSlab[] = [];
  for (const stair of project.stairs ?? []) {
    const { zBottom, zTop } = stairVerticalExtent(project, stair);
    const totalRise = zTop - zBottom;
    if (totalRise <= EPS) continue;
    const geo = stairGeometry(stair, totalRise);
    const st = getStairType(project, stair);
    const structure = st?.structure ?? "massiv";
    // Gerade Betontreppe: die GLATTE Laufplatte kommt als echtes Mesh
    // (emitStairMeshes) — hier keine Slab-Näherung emittieren (sonst doppelt).
    if (structure === "beton" && stair.shape === "straight") continue;
    const treadThickness = st?.treadThickness ?? 0.04;
    const riser = geo.riserHeight;
    const open = structure !== "massiv";
    const nosing = open ? st?.nosing ?? 0 : 0;
    const neighborPts = geo.treads.map((t) => t.pts);
    for (let k = 0; k < geo.treads.length; k++) {
      const tr = geo.treads[k];
      if (tr.pts.length < 3) continue;
      const pts = withNosing(tr.pts, neighborPts, k, nosing);
      const top = zBottom + tr.topRise;
      const bottom =
        structure === "massiv"
          ? zBottom // Vollblock bis zur Treppen-UK
          : structure === "beton"
            ? Math.max(zBottom, top - riser - CONCRETE_WAIST) // schräge Laufplatte
            : top - treadThickness; // offene Tritte (Wange/aufgesattelt/Spindel)
      if (top - bottom > EPS) {
        out.push({
          outline: pts.map((p) => [p.x, p.y] as RVec2),
          zBottom: bottom,
          zTop: top,
          color: STAIR_RGB,
          ceilingId: stair.id,
        });
      }
      if (open && st?.closedRisers) {
        const riserOutline = closedRiserOutline(tr.pts, neighborPts, k, treadThickness);
        if (riserOutline) {
          out.push({
            outline: riserOutline.map((p) => [p.x, p.y] as RVec2),
            zBottom: zBottom + tr.baseRise,
            zTop: zBottom + tr.topRise,
            color: STAIR_RGB,
            ceilingId: stair.id,
          });
        }
      }
    }
    if (geo.landing && geo.landing.length >= 3) {
      out.push({
        outline: geo.landing.map((p) => [p.x, p.y] as RVec2),
        zBottom,
        zTop: zBottom + totalRise * 0.5,
        color: STAIR_RGB,
        ceilingId: stair.id,
      });
    }
  }
  return out;
}

/**
 * Glatte Ortbeton-Laufplatte (Tragart "beton") als echtes Dreiecks-Mesh — nur für
 * GERADE Läufe. Anders als die stufige Slab-Näherung ({@link emitStairs}) entsteht
 * eine SPIEGELGLATTE schräge Untersicht: je Tritt ein konvexes Prisma mit
 * HORIZONTALER Oberkante (= Trittfläche) und SCHRÄGER Unterkante auf EINER
 * gemeinsamen Soffit-Geraden. Weil alle Prismen-Unterkanten exakt auf dieser
 * Geraden liegen, bildet die Vereinigung eine durchgehende glatte Schräge; die
 * Höhensprünge der Oberkanten bleiben als sichtbare Setzstufen. Prismen sind
 * konvex → triviale, robuste Triangulierung (kein Ear-Clipping). Positions in
 * MODELL-Metern (x, y, z=Höhe); render3d bildet nach world (x, z, y) ab.
 */
export function emitStairMeshes(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const stair of project.stairs ?? []) {
    const st = getStairType(project, stair);
    if (!st || st.structure !== "beton") continue;
    if (stair.shape !== "straight") continue; // glattes Mesh nur für gerade Läufe
    if (stair.runLength <= EPS) continue;
    const { zBottom, zTop } = stairVerticalExtent(project, stair);
    const totalRise = zTop - zBottom;
    if (totalRise <= EPS) continue;
    const geo = stairGeometry(stair, totalRise);
    const u = normalize(stair.dir); // Laufrichtung (Grundriss)
    const w = leftNormal(u); // Querrichtung (Breite)
    const runTotal = stair.runLength;
    // Laufplattendicke (vertikal): an die Steigung gekoppelt, geklemmt.
    const waistV = Math.min(0.24, Math.max(0.14, geo.riserHeight * 1.2));
    // Soffit-Höhe entlang des Laufs: eine Gerade PARALLEL zur Trittkantenlinie
    // (Steigung totalRise/runTotal), um `waistV` nach unten versetzt → KONSTANTE
    // Plattendicke über den ganzen Lauf (sonst würde die Platte nach oben dicker).
    // An der Treppen-UK gekappt, damit die unterste Stufe auf dem Boden aufsitzt
    // statt darunter zu schweben.
    const soffitH = (runS: number) => {
      const s = Math.min(Math.max(runS, 0), runTotal);
      return Math.max(zBottom, zBottom + (s / runTotal) * totalRise - waistV);
    };
    const runOf = (p: Vec2) => (p.x - stair.start.x) * u.x + (p.y - stair.start.y) * u.y;
    const sideOf = (p: Vec2) => (p.x - stair.start.x) * w.x + (p.y - stair.start.y) * w.y;
    const positions: number[] = [];
    const indices: number[] = [];
    for (const tr of geo.treads) {
      if (tr.pts.length < 4) continue;
      // Vier Eckpunkte nach Lauf-Parameter trennen (2 kleinste = Startkante, 2
      // grösste = Endkante), je Kante nach Quer-Parameter sortieren (0 = links).
      const byRun = [...tr.pts].sort((a, b) => runOf(a) - runOf(b));
      const startEdge = [byRun[0], byRun[1]].sort((a, b) => sideOf(a) - sideOf(b));
      const endEdge = [byRun[2], byRun[3]].sort((a, b) => sideOf(a) - sideOf(b));
      const runS = Math.min(runOf(byRun[0]), runOf(byRun[1]));
      const runE = Math.max(runOf(byRun[2]), runOf(byRun[3]));
      const topH = zBottom + tr.topRise;
      const bS = soffitH(runS);
      const bE = soffitH(runE);
      if (topH - Math.max(bS, bE) <= EPS) continue;
      const base = positions.length / 3;
      const push = (p: Vec2, z: number) => positions.push(p.x, p.y, z);
      // 0/1 Startkante unten (soffit), 2/3 Endkante unten, 4/5 Start oben, 6/7 End oben.
      push(startEdge[0], bS); push(startEdge[1], bS);
      push(endEdge[0], bE);   push(endEdge[1], bE);
      push(startEdge[0], topH); push(startEdge[1], topH);
      push(endEdge[0], topH);   push(endEdge[1], topH);
      const quad = (a: number, b: number, c: number, d: number) =>
        indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
      quad(0, 1, 3, 2); // Untersicht (schräge Soffit-Fläche)
      quad(4, 6, 7, 5); // Oberseite (Trittfläche)
      quad(0, 4, 5, 1); // Startkante (Setzstufen-Front der Vorstufe sichtbar)
      quad(2, 3, 7, 6); // Endkante
      quad(0, 2, 6, 4); // linke Wange
      quad(1, 5, 7, 3); // rechte Wange
    }
    if (indices.length === 0) continue;
    out.push({ positions, indices, kind: "extrusion", color: STAIR_RGB });
  }
  return out;
}

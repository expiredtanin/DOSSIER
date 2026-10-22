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
 * Standard-Renderer las sie nie, s. PENDENZEN.md). Handlauf/Geländer
 * (`StairType.railing`) sind separat in {@link emitStairRailings} (nur
 * gerade Läufe, s. dort).
 * `ceilingId` trägt hier die Treppen-Id (nur TS-seitiges Tagging; render3d ignoriert
 * das Feld, und der Pick läuft separat über `pickGeometry`).
 */
/** Max. Stufenhöhe (Meter) der Soffit-Treppung im Schnitt: darunter wirkt die Untersicht glatt. */
const SOFFIT_SLICE_STEP = 0.015;

/** Laufplattendicke (vertikal) der glatten Betontreppe — gemeinsam für Mesh und Schnitt. */
function concreteWaist(riserHeight: number): number {
  return Math.min(0.24, Math.max(0.14, riserHeight * 1.2));
}

export function emitStairs(
  project: Project,
  /**
   * `forSection`: auch gerade Betontreppen als Tritt-Prismen liefern (deren
   * glatte Laufplatte ist im 3D ein Mesh, das der Schnitt-Extraktor nicht
   * schneiden kann — ohne diese Näherung fehlte die Treppe im Schnitt ganz).
   */
  opts: { forSection?: boolean } = {},
): RSlab[] {
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
    if (structure === "beton" && stair.shape === "straight" && !opts.forSection) continue;
    const treadThickness = st?.treadThickness ?? 0.04;
    const riser = geo.riserHeight;
    const open = structure !== "massiv";
    // Massiv/Beton = EIN Körper: die Tritt-Prismen verschmelzen im Schnitt
    // (keine Nähte zwischen den Tritten, s. render3d `SlabInput::monolith`).
    const monolith = structure === "massiv" || structure === "beton" ? stair.id : undefined;
    const nosing = open ? st?.nosing ?? 0 : 0;
    const neighborPts = geo.treads.map((t) => t.pts);
    // Gerade Betontreppe im Schnitt: schräge Soffit-Untersicht (wie das 3D-Mesh) als
    // feine Scheiben — jede Tritt-Fläche längs des Laufs in dünne Prismen zerlegt, deren
    // Unterkante der Soffit-Geraden folgt (Stufen < SOFFIT_SLICE_STEP statt Sägezahn).
    if (structure === "beton" && stair.shape === "straight" && opts.forSection && stair.runLength > EPS) {
      const u = normalize(stair.dir);
      const w = leftNormal(u);
      const waistV = concreteWaist(riser);
      const runOf = (p: Vec2) => (p.x - stair.start.x) * u.x + (p.y - stair.start.y) * u.y;
      const sideOf = (p: Vec2) => (p.x - stair.start.x) * w.x + (p.y - stair.start.y) * w.y;
      const soffit = (runS: number) => {
        const t = Math.min(Math.max(runS, 0), stair.runLength);
        return Math.max(zBottom, zBottom + (t / stair.runLength) * totalRise - waistV);
      };
      const n = Math.max(1, Math.ceil(riser / SOFFIT_SLICE_STEP));
      for (const tr of geo.treads) {
        if (tr.pts.length < 4) continue;
        const byRun = [...tr.pts].sort((a, b) => runOf(a) - runOf(b));
        const a = [byRun[0], byRun[1]].sort((p, q) => sideOf(p) - sideOf(q));
        const b = [byRun[2], byRun[3]].sort((p, q) => sideOf(p) - sideOf(q));
        const top = zBottom + tr.topRise;
        const lerp = (p: Vec2, q: Vec2, t: number): Vec2 => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
        for (let j = 0; j < n; j++) {
          const t0 = j / n;
          const t1 = (j + 1) / n;
          // Die tiefere (Anfangs-)Seite der Scheibe bestimmt die Unterkante: keine Lücke zum Soffit.
          const bottom = soffit(runOf(lerp(a[0], b[0], t0)));
          if (top - bottom <= EPS) continue;
          const quad = [lerp(a[0], b[0], t0), lerp(a[0], b[0], t1), lerp(a[1], b[1], t1), lerp(a[1], b[1], t0)];
          out.push({
            outline: quad.map((p) => [p.x, p.y] as RVec2),
            zBottom: bottom,
            zTop: top,
            color: STAIR_RGB,
            ceilingId: stair.id,
            monolith,
          });
        }
      }
      continue;
    }
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
          monolith,
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
      const landingTop = zBottom + totalRise * 0.5;
      out.push({
        outline: geo.landing.map((p) => [p.x, p.y] as RVec2),
        // Betontreppe: Podest als Platte (wie die Laufplatte), kein Vollblock
        // bis zum Boden; massiv bleibt Vollkörper.
        zBottom: structure === "beton" ? Math.max(zBottom, landingTop - riser - CONCRETE_WAIST) : zBottom,
        zTop: landingTop,
        color: STAIR_RGB,
        ceilingId: stair.id,
        monolith,
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
    const waistV = concreteWaist(geo.riserHeight);
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

/** Neutrales Metallgrau für Handlauf + Pfosten. */
const RAIL_RGB: RRgb = hexToRgb("#74797f", SLAB_RGB);
/** Handlaufhöhe über der Trittvorderkante (SIA-üblich), Meter. */
const RAIL_HEIGHT = 0.9;
/** Handlauf-/Pfosten-Querschnitt (Kantenlänge), Meter. */
const RAIL_THICK = 0.04;

type Vec3 = { x: number; y: number; z: number };

/**
 * Schlanker Quader zwischen zwei beliebigen 3D-Punkten (Modell-Meter, NICHT
 * an eine Wandachse gebunden — anders als die übrigen Quader-Helfer in
 * `openings.ts`, die alle wand-lokale Achsen voraussetzen). Querschnitt-Achsen
 * werden aus einem festen Welt-„oben" (0,0,1) abgeleitet (fällt bei fast
 * senkrechten Segmenten — Pfosten — auf die X-Achse zurück, damit das
 * Kreuzprodukt nicht entartet). `null` bei entartetem (zu kurzem) Segment.
 */
function strutBox(a: Vec3, b: Vec3, half: number, color: RRgb): RMesh | null {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < EPS) return null;
  const d = { x: dx / len, y: dy / len, z: dz / len };
  const upRef: Vec3 = Math.abs(d.z) > 0.98 ? { x: 1, y: 0, z: 0 } : { x: 0, y: 0, z: 1 };
  let rx = d.y * upRef.z - d.z * upRef.y;
  let ry = d.z * upRef.x - d.x * upRef.z;
  let rz = d.x * upRef.y - d.y * upRef.x;
  const rl = Math.hypot(rx, ry, rz) || 1;
  rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * d.z - rz * d.y;
  const uy = rz * d.x - rx * d.z;
  const uz = rx * d.y - ry * d.x;
  const corners: Vec3[] = [];
  for (const p of [a, b]) {
    for (const [sr, su] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      corners.push({
        x: p.x + rx * sr * half + ux * su * half,
        y: p.y + ry * sr * half + uy * su * half,
        z: p.z + rz * sr * half + uz * su * half,
      });
    }
  }
  const positions: number[] = [];
  for (const c of corners) positions.push(c.x, c.y, c.z);
  const indices: number[] = [];
  const quad = (a0: number, b0: number, c0: number, d0: number) =>
    indices.push(a0, b0, c0, a0, c0, d0);
  quad(0, 1, 2, 3); // Stirnfläche bei a
  quad(7, 6, 5, 4); // Stirnfläche bei b
  quad(0, 4, 5, 1);
  quad(1, 5, 6, 2);
  quad(2, 6, 7, 3);
  quad(3, 7, 4, 0);
  return { positions, indices, kind: "extrusion", color };
}

/**
 * Handlauf + Pfosten (`StairType.railing`: "keine"|"links"|"rechts"|"beide")
 * — bislang ein „totes" Feld: im Modell, im ResourceManager (`StairStylesTab`)
 * und in den i18n-Labels längst vorhanden, aber von KEINEM Renderer je
 * gelesen (weder dem alten Three.js-Pfad — dort selbst als TODO markiert —
 * noch diesem WASM/wgpu-Default-3D). Nur für GERADE Läufe umgesetzt: bei
 * einer geraden Treppe liegt die Vorderkante jedes Tritts (das Eckpunktpaar
 * mit dem GRÖSSEREN Lauf-Parameter, s. `treadRect`/`stairGeometry`) exakt auf
 * der linearen Rampen-Geraden (Steigung totalRise/runLength ist über den
 * ganzen Lauf konstant) — Handlauf und Pfosten lassen sich daher als EIN
 * gerades, schräges Segment je Seite + ein Pfosten je Trittvorderkante bauen,
 * ohne die Stufen einzeln nachzubilden. L-Läufe/Wendeltreppen (Richtungs-
 * wechsel bzw. keine lineare Rampe) bleiben bewusst aussen vor — eigener,
 * grösserer Folgeschritt (Rampen-Polyline müsste knickweise bzw. als Spirale
 * gebaut werden), kein Blocker für die Sichtbarkeit bei geraden Treppen, dem
 * mit Abstand häufigsten Fall.
 */
export function emitStairRailings(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const stair of project.stairs ?? []) {
    if (stair.shape !== "straight") continue;
    const st = getStairType(project, stair);
    const railing = st?.railing ?? "keine";
    if (railing === "keine") continue;
    const { zBottom, zTop } = stairVerticalExtent(project, stair);
    const totalRise = zTop - zBottom;
    if (totalRise <= EPS) continue;
    const geo = stairGeometry(stair, totalRise);
    if (geo.treads.length === 0) continue;
    const sides: ("left" | "right")[] =
      railing === "beide" ? ["left", "right"] : railing === "links" ? ["left"] : ["right"];
    for (const side of sides) {
      // Tritt-Eckpunkte (s. treadRect): 0/1 = linke Kante (Start/Ende),
      // 3/2 = rechte Kante (Start/Ende). Die „Ende"-Ecke jedes Tritts ist
      // dessen Vorderkante (liegt auf der Rampen-Geraden, s. Funktionsdoc).
      const iStart = side === "left" ? 0 : 3;
      const iEnd = side === "left" ? 1 : 2;
      const first = geo.treads[0];
      const startPt = first.pts[iStart];
      const last = geo.treads[geo.treads.length - 1];
      const endPt = last.pts[iEnd];
      const rail = strutBox(
        { x: startPt.x, y: startPt.y, z: zBottom + RAIL_HEIGHT },
        { x: endPt.x, y: endPt.y, z: zTop + RAIL_HEIGHT },
        RAIL_THICK / 2,
        RAIL_RGB,
      );
      if (rail) out.push(rail);
      const postAt = (p: Vec2, topZ: number) => {
        const post = strutBox(
          { x: p.x, y: p.y, z: topZ },
          { x: p.x, y: p.y, z: topZ + RAIL_HEIGHT },
          RAIL_THICK / 2,
          RAIL_RGB,
        );
        if (post) out.push(post);
      };
      postAt(startPt, zBottom); // Fusspfosten am Bodenanschluss.
      for (const tr of geo.treads) postAt(tr.pts[iEnd], zBottom + tr.topRise);
    }
  }
  return out;
}

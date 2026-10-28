// Wand-Domäne des Grundriss-Generators: Öffnungs-Lücken entlang der Wandachse,
// die Wand-Footprints (für das Verdecken darunterliegender Decken-Umrisse, s.
// {@link ../ceilings}) und die eigentliche Wand-Poché (Schichten + Umriss +
// Öffnungsaussparungen + T-Stoss-/Gehrungs-Behandlung).
//
// Die Geometrie der Poché entsteht im Rust-Kern (`src-tauri/core/src/plan_walls.rs`, [K3a]); hier
// bleibt die Stilauflösung aus dem Modell (Bauteil, Schraffur, Farbe, Fugen-Linienstil) und die
// Übersetzung in `Primitive`-Objekte. Fällt mit [K3d] weg.

import type { LayerCategory, Opening, Project, Vec2, Wall } from "../../model/types";
import { getComponent, getWallType, wallTypeThickness } from "../../model/types";
import { wallReferenceOffset } from "../../model/wall";
import { openingInterval } from "../../geometry/opening";
import { leftNormal, normalize, sub } from "../../model/geometry";
import type { Line } from "../../model/geometry";
import type { WallCuts } from "../../model/joins";
import { core } from "../../engine/coreWasm";
import {
  HATCH_INK,
  HATCH_PAPER,
  LAYER_DETAIL_FACTOR,
  LAYER_LINE_MM,
  NO_HATCH,
  OUTLINE_DETAIL_FACTOR,
  POCHE_STROKE,
  resolveBackground,
  resolveForeground,
  resolveHatch,
  resolveHatchId,
  type DetailLevel,
  type HatchRender,
  type Primitive,
} from "./shared";

/** Ein Öffnungs-Intervall entlang der Wandachse (from..to in Metern). `headHeight`
 *  = Sturzhöhe (OK der Öffnung über der Wand-UK) für die 3D-Aussparung; im Plan
 *  ungenutzt, aber Teil des gemeinsamen Vertrags mit dem 3D-Pfad. */
export interface WallGap {
  from: number;
  to: number;
}

/**
 * Wandet die Öffnungen (`Opening`: Fenster und Türen) einer Wand zu einer
 * sortierten Lücken-Intervall-Liste entlang der Wandachse. Entartete Intervalle
 * (Breite ≤ 0 oder außerhalb der Achse) werden verworfen.
 */
export function wallGaps(
  wall: Wall,
  openings: Opening[],
): WallGap[] {
  const gaps: WallGap[] = [];
  for (const o of openings) {
    const iv = openingInterval(wall, o);
    if (iv) gaps.push(iv);
  }
  return gaps.sort((a, b) => a.from - b.from);
}

/**
 * Wand-Footprint als orientiertes Rechteck (OBB) für das Verdecken der
 * darunterliegenden Decke im Grundriss: Achs-Startpunkt + Einheits-Richtung `u`
 * und -Normale `m`, Halbdicke, Referenz-Querversatz (Wandachse↔Bandmitte) und
 * Achslänge. Die u-Ausdehnung wird beim Test an beiden Enden um die Halbdicke
 * verlängert, damit auch die Eck-Überlappe (Gehrungen) sicher abgedeckt sind.
 */
export interface WallFootprint {
  a: Vec2;
  u: Vec2;
  m: Vec2;
  len: number;
  half: number;
  refOff: number;
}

/** Baut die Wand-Footprints (OBBs) aus den gerenderten Wänden. Nicht auflösbarer
 *  Wandtyp ⇒ Default-Dicke 0.2 m (wie der Vollkörper-Fallback im 3D-Emitter). */
export function buildWallFootprints(project: Project, walls: Wall[]): WallFootprint[] {
  const out: WallFootprint[] = [];
  for (const w of walls) {
    let t = 0.2;
    try {
      t = wallTypeThickness(getWallType(project, w));
    } catch {
      // Default-Dicke behalten.
    }
    const u = normalize(sub(w.end, w.start));
    out.push({
      a: w.start,
      u,
      m: leftNormal(u),
      len: Math.hypot(w.end.x - w.start.x, w.end.y - w.start.y),
      half: t / 2,
      refOff: wallReferenceOffset(w, t),
    });
  }
  return out;
}

const lineBuf = (l: Line | null | undefined): number[] =>
  l ? [1, l.point.x, l.point.y, l.dir.x, l.dir.y] : [0, 0, 0, 0, 0];

/** Eingabe der Kern-Funktion `plan_wall_poche_flat` (Aufbau: `plan_walls.rs`). */
function encodeWallPoche(
  wall: Wall,
  layerThickness: number[],
  total: number,
  refOff: number,
  gaps: WallGap[],
  cuts: WallCuts,
  grob: boolean,
  viewOnly: boolean,
): Float64Array {
  const b: number[] = [wall.start.x, wall.start.y, wall.end.x, wall.end.y, total, refOff, grob ? 1 : 0, viewOnly ? 1 : 0];
  b.push(layerThickness.length, ...layerThickness);
  b.push(...lineBuf(cuts.startCut), ...lineBuf(cuts.endCut));
  const lc = cuts.layerCuts;
  b.push(lc ? 1 : 0);
  if (lc) {
    for (let i = 0; i < layerThickness.length; i++) {
      b.push(...lineBuf(lc.start[i]), ...lineBuf(lc.end[i]), ...lineBuf(lc.startSide[i]), ...lineBuf(lc.endSide[i]));
    }
  }
  const sc = cuts.spanCutouts ?? [];
  b.push(sc.length);
  for (const c of sc) b.push(c.from, c.to, c.offA, c.offB);
  b.push(gaps.length);
  for (const g of gaps) b.push(g.from, g.to);
  return Float64Array.from(b);
}

/**
 * Wand als gefüllte Schnittfläche (Poché), um Öffnungen ausgespart.
 *
 * Detailgrad:
 *  • mittel/fein — jede Schicht des Wandtyps als eigenes Band (Füllfarbe +
 *    Schraffur des Bauteils), dazu eine kräftige Wand-Umrisslinie. fein zeichnet
 *    Schichtfugen und Umriss dünner als mittel.
 *  • grob — KEINE Schichten, KEINE Schraffur: eine einzige Sammelfläche über die
 *    volle Wanddicke (Füllung = Farbe des „Backbone"-Bauteils mit höchster
 *    joinPriority) mit dicker Umrisslinie. Bewusst vereinfacht (≙ DOSSIER
 *    „Einfach").
 *
 * Segmente, Gehrungsbänder, Schichtfugen und Durchgangswand-Aussparungen berechnet der Kern;
 * hier kommen nur Stil und Pick-ID (`wallId`) dazu.
 */
export function addWallPoche(
  out: Primitive[],
  project: Project,
  wall: Wall,
  gaps: WallGap[],
  cuts: WallCuts,
  greyed: boolean,
  detail: DetailLevel,
  wallLwMm: number,
  category: LayerCategory | undefined,
  // Wand liegt GANZ unter der Grundriss-Schnittebene (z. B. 30-cm-Brüstung bei
  // 1 m Schnitthöhe) → „von oben gesehen": nur Ansichts-Umriss (Haarlinie), KEINE
  // Schnitt-Poché/Schraffur/Schichten. Der reguläre Schnittfall bleibt `false`.
  viewOnly: boolean,
): void {
  const wt = getWallType(project, wall);
  const total = wallTypeThickness(wt);
  const refOff = wallReferenceOffset(wall, total);
  const wallId = wall.id;
  // Achswinkel der Wand (Modell, Grad) — treibt wandbezogene Schraffuren ({@link resolveHatch}).
  const wallAngleDeg =
    (Math.atan2(wall.end.y - wall.start.y, wall.end.x - wall.start.x) * 180) / Math.PI;
  // Strich-/Umrandungsfarbe der Wand: optionale Übersteuerung (wall.color), sonst der
  // Default-Poché-Strich. Betrifft NUR die Linienfarbe, nicht die Schicht-Füllfarben/Schraffuren.
  const stroke = wall.color ?? POCHE_STROKE;
  const outlineMm = wallLwMm * OUTLINE_DETAIL_FACTOR[detail];
  const layerLineMm = LAYER_LINE_MM * LAYER_DETAIL_FACTOR[detail];

  const f = core().plan_wall_poche_flat(
    encodeWallPoche(wall, wt.layers.map((l) => l.thickness), total, refOff, gaps, cuts, detail === "grob", viewOnly),
  );
  if (f.length === 0) return;

  // Stil je Schicht erst beim ersten Band lösen (wie zuvor: nur wenn die Wand Segmente hat).
  const layerStyle = new Map<number, { hatch: HatchRender; fill: string }>();
  const styleOf = (li: number) => {
    let st = layerStyle.get(li);
    if (!st) {
      const comp = getComponent(project, wt.layers[li].componentId);
      const layerHatchId =
        resolveHatchId(wall.hatchId, wall.hatchSource, category, comp.hatchId) ?? comp.hatchId;
      const hatch = resolveHatch(
        project,
        layerHatchId,
        wallAngleDeg,
        resolveForeground(comp, wall.foreground, category, wall.foregroundSource),
      );
      // SIA-Poché: neutraler Hintergrund (Papier) statt Bauteil-Albedo, die Schichtschraffur
      // (fest in HATCH_INK, siehe resolveHatch) liegt darüber; Vollmuster ("solid") = Tinten-Poché.
      const bgOverride = resolveBackground(comp, wall.background, category, wall.backgroundSource);
      st = { hatch, fill: bgOverride ?? (hatch.pattern === "solid" ? HATCH_INK : HATCH_PAPER) };
      layerStyle.set(li, st);
    }
    return st;
  };

  const n = f[0];
  let i = 1;
  for (let k = 0; k < n; k++) {
    if (f[i] === 1) {
      const art = f[i + 1];
      const li = f[i + 2];
      const nNo = f[i + 3];
      const noStrokeEdges = Array.from(f.subarray(i + 4, i + 4 + nNo));
      const q = i + 4 + nNo;
      const pts = [0, 1, 2, 3].map((j) => ({ x: f[q + 2 * j], y: f[q + 2 * j + 1] }));
      i = q + 8;
      if (art === 2) {
        const st = styleOf(li);
        out.push({
          kind: "polygon",
          pts,
          fill: st.fill,
          // Band ohne Umriss: keine Schichtfuge über die Bandkante, keine 45°-Naht am Knoten.
          // Die Fugen kommen als separate `line`-Primitive.
          stroke: "none",
          strokeWidthMm: 0,
          hatch: st.hatch,
          greyed,
          noStrokeEdges,
          wallId,
        });
      } else {
        out.push({
          kind: "polygon",
          pts,
          // Grob: immer Vollschwarz-Füllung gemäss SIA 400 Anhang B.9, Figur 36.
          fill: art === 1 ? HATCH_INK : "none",
          stroke,
          strokeWidthMm: art === 0 ? layerLineMm : outlineMm,
          hatch: NO_HATCH,
          greyed,
          noStrokeEdges,
          wallId,
        });
      }
    } else {
      const art = f[i + 1];
      const li = f[i + 2];
      const a = { x: f[i + 3], y: f[i + 4] };
      const b = { x: f[i + 5], y: f[i + 6] };
      i += 7;
      if (art === 0) {
        out.push({ kind: "line", a, b, cls: "layer-joint-l", weightMm: layerLineMm, color: stroke, greyed });
      } else if (art === 1) {
        // Innere Schichtfuge: Stil aus layer.jointLineStyleId (Gewicht/Farbe/Strich), Rückfall =
        // Haarlinie in Wandfarbe.
        const id = wt.layers[li].jointLineStyleId;
        const jls = id ? project.lineStyles.find((l) => l.id === id) : undefined;
        out.push({
          kind: "line",
          a,
          b,
          cls: "layer-joint",
          weightMm: jls ? jls.weight * LAYER_DETAIL_FACTOR[detail] : layerLineMm,
          color: jls ? jls.color : stroke,
          dash: jls ? jls.dash : null,
          zigzag: jls?.kind === "zigzag" ? jls.zigzag : undefined,
          motif: jls?.kind === "custom" ? jls.motif : undefined,
          greyed,
        });
      } else {
        out.push({ kind: "line", a, b, cls: "wall-outline", weightMm: outlineMm, color: stroke, greyed });
      }
    }
  }
}

/**
 * Referenzlinie einer Wand: dünne, gestrichelte Achslinie entlang der Wandachse
 * (start → end). Von der Oberleiste umschaltbar; rein darstellend.
 */
export function addReferenceLine(out: Primitive[], wall: Wall, greyed: boolean): void {
  out.push({
    kind: "line",
    a: wall.start,
    b: wall.end,
    cls: "wall-axis",
    weightMm: 0.13,
    dash: [0.18, 0.06, 0.04, 0.06], // Strich-Punkt-Achse in mm Papier
    greyed,
  });
}

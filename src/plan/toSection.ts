// Schnitt-/Ansichts-Pipeline: bindet den analytischen render3d-Schnitt-Extraktor
// (`section.rs`, WASM-Export `cut_section_json`) an das Dokumentmodell an.
//
// Ablauf:
//   1. Aus einer Zeichnungsebene (DrawingLevel, kind "section"/"elevation") wird
//      eine Schnittebene abgeleitet — die Grundriss-Schnittlinie `linePoints`
//      plus `directionSign` (Blickrichtung).
//   2. Das Projekt wird über `projectToModel3d({ layeredWalls: false })` zu
//      Wänden + Decken geflacht und als JSON an `cut_section_json` gereicht —
//      pro Wand EINE Voll-Box (der 3D-Viewport bekommt dagegen je Materiallage
//      eine Box). So bleiben die Cut-Polygone 1:1 zu `wallSegmentOwners`, und
//      die per-Material-Schnitt-Schraffur macht `splitWallLayers` TS-seitig.
//   3. Das zurückgegebene `SectionOutput` (Cut-Polygone + sichtbare/verdeckte
//      Kanten, alles in (u, v)-Metern) wird in `generateSectionPlan`
//      (generatePlan.ts) zu Plan-Primitiven übersetzt.
//
// Einheiten: METER. Koordinaten der Ausgabe: u = horizontal entlang der Ebene,
// v = absolute Höhe (world.y). Siehe src-tauri/render3d/src/section.rs.

import type { Ceiling, DrawingLevel, Project, Vec2, Wall } from "../model/types";
import { getCeilingType, getComponent, getLayerCategory, getWallType, openingsOfWall, roofLayers } from "../model/types";
import { ceilingVerticalExtent, wallVerticalExtent } from "../model/wall";
import { dot, leftNormal, normalize, sub } from "../model/geometry";
import { openingInterval, openingVerticalExtent } from "../geometry/opening";
import { roofBaseElevation, roofGeometry } from "../geometry/roof";
import { projectToModel3d } from "./toWalls3d";
import { loadEngine3d } from "../engine/engine3d";
import {
  HATCH_INK,
  HATCH_PAPER,
  resolveBackground,
  resolveCeilingSectionStyle,
  resolveForeground,
  resolveHatch,
  resolveHatchId,
  resolveWallSectionStyle,
} from "./generatePlan";
import type { HatchRender } from "./generatePlan";

/** Bauteil-Referenz eines Cut-Polygons/einer Kante (Art + Eingabe-Index). */
export interface SectionComponentRef {
  kind: "wall" | "slab" | "roof";
  index: number;
}

/** Ein geschnittenes Bauteil-Rechteck in (u, v)-Metern (Ring, implizit geschlossen). */
export interface SectionCutPolygon {
  component: SectionComponentRef;
  /** Albedo-Farbe des Bauteils (RGB 0..1) — Rohwert aus dem 3D-Modell (Fallback). */
  color: [number, number, number];
  /** Ring-Ecken (u, v). */
  pts: Array<[number, number]>;
  /**
   * Echte Poché-Füllfarbe des geschnittenen Bauteils (tragende Wandschicht
   * bzw. erste Deckenschicht), von `computeSection` aufgelöst. Fehlt, wenn das
   * Quell-Bauteil nicht auflösbar war — der Aufrufer (generateSectionPlan)
   * fällt dann auf `color` zurück.
   */
  fill?: string;
  /** Echte Schnitt-Schraffur des geschnittenen Bauteils, analog zu `fill`. */
  hatch?: HatchRender;
  /**
   * Verschneidungs-Rang der Schicht dieses Bands (`Component.joinPriority` des
   * Ursprungs-Bauteils). Steuert die Schnitt-Boolean-Dominanz in
   * `attachCutStyles`: ein Band mit STRIKT höherer Priorität schneidet ein
   * überlappendes schwächeres Band per Rechteck-Subtraktion weg (element-
   * übergreifend, z. B. Decken-Beton schneidet Wand-Putz). Fehlt der Wert
   * (unauflösbares Bauteil), nimmt das Band an keiner Subtraktion teil.
   */
  joinPriority?: number;
  /**
   * Bauteil-Identität der Schicht dieses Bands (`Component.id` des Ursprungs-
   * Bauteils bzw. — bei einschichtiger Poché — des tragenden Bauteils). Steuert
   * die MERGE-Regel in `subtractDominantBands`: berühren/überlappen sich zwei
   * Bänder mit GLEICHER `componentId` UND gleicher `joinPriority`, verschmelzen
   * sie zu einem Körper (keine innere Trennlinie durch gleichartiges Material —
   * analog zu `resolveJoinPriority` "merge" im Grundriss-Join-Modell). Fehlt der
   * Wert (unauflösbares Bauteil), nimmt das Band an keiner Verschmelzung teil.
   */
  componentId?: string;
  /**
   * ID des QUELL-Elements dieses Cut-Bands im Dokumentmodell (Wand/Decke/Dach) —
   * aufgelöst in `attachCutStyles` über die Besitzer-Listen. Trägt die Auswahl im
   * Schnitt-View: `generateSectionPlan` schreibt sie je nach `component.kind` als
   * `wallId`/`ceilingId`/`roofId` ins Plan-Polygon, sodass ein Klick auf das
   * geschnittene Bauteil im Schnitt exakt jenes Element im Grundriss-Modell wählt.
   * Fehlt (unauflösbares Bauteil), bleibt das Band ohne Auswahlbezug.
   */
  sourceId?: string;
  /**
   * Grafik-Kategorie-Code des QUELL-Elements (wie `sourceId`, aus derselben
   * Auflösung in `attachCutStyles`) — `generateSectionPlan` filtert/dimmt jedes
   * Cut-Band darüber wie jedes andere Bauteil (`visibleCodes`/`categoryDisplay`),
   * damit das Ebenen-Panel auch im Schnitt/in der Ansicht wirkt, nicht nur im
   * Grundriss. Fehlt (unauflösbares Bauteil), bleibt das Band immer sichtbar.
   */
  categoryCode?: string;
}

/** Ein projiziertes Liniensegment in (u, v)-Metern. */
export interface SectionEdge {
  component: SectionComponentRef;
  a: [number, number];
  b: [number, number];
}

/** Vollständige Ausgabe eines Schnitt-/Ansichts-Laufs (JSON von `cut_section_json`). */
export interface SectionOutput {
  cutPolygons: SectionCutPolygon[];
  visibleEdges: SectionEdge[];
  hiddenEdges: SectionEdge[];
}

/** Minimal-Typ des WASM-Exports (das echte `.d.ts` entsteht erst beim wasm-Build). */
interface Engine3dSection {
  cut_section_json(
    modelJson: string,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
  ): string;
}

/**
 * Eine Schnittebene in world-Koordinaten (Y-up): Punkt auf der Ebene +
 * Normale (= Blickrichtung, zeigt vom Betrachter ins Modell).
 */
export interface SectionPlaneSpec {
  point: [number, number, number];
  normal: [number, number, number];
}

/**
 * Leitet aus einer Schnitt-/Ansichtsebene die world-Schnittebene ab. Die
 * Grundriss-Schnittlinie `linePoints` [p0, p1] (Modell-Meter) liegt in der
 * XZ-Ebene (world.x = model.x, world.z = model.y); die Ebenennormale steht
 * senkrecht auf der Linie in der Horizontalen und wird über `directionSign`
 * (Voreinstellung +1) in die gewünschte Blickrichtung gedreht.
 *
 * Gibt `null` zurück, wenn die Ebene (noch) keine Schnittlinie trägt (z. B. eine
 * frisch angelegte Ansicht ohne gesetzte Linie) — der Aufrufer zeigt dann einen
 * Hinweis statt eines leeren Plans.
 */
export function sectionPlaneFromLevel(level: DrawingLevel): SectionPlaneSpec | null {
  const line = level.linePoints;
  if (!line) return null;
  const [p0, p1] = line;
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uy = dy / len;
  // Links-Normale der Linie im Grundriss (n = (-u.y, u.x)), per directionSign
  // in die Blickrichtung gedreht. Modell (nx, ny) → world (nx, 0, ny).
  const sign = level.directionSign ?? 1;
  const nx = -uy * sign;
  const ny = ux * sign;
  return {
    point: [p0.x, 0, p0.y],
    normal: [nx, 0, ny],
  };
}

/**
 * Die in-plane-u-Weltrichtung der Schnittebene, projiziert in die Grundriss-
 * Ebene (Modell-2D: model.x = world.x, model.y = world.z).
 *
 * Muss EXAKT der u-Achse des WASM-Extraktors entsprechen (`SectionPlane::u_axis`
 * in section.rs): dort `u = normalize(cross(up, normal))` mit up = (0,1,0) —
 * das Blickrichtungs-RECHTS des Betrachters (Entspiegelung; wer nach Norden
 * blickt, hat Osten rechts). Für eine horizontale Normale `[Nx, Ny, Nz]` sind
 * die Grundriss-Komponenten (x, z) also `(Nz, -Nx)`. (Nicht normiert; für das
 * Vorzeichen des Skalarprodukts irrelevant.)
 */
export function sectionUAxisModel(plane: SectionPlaneSpec): Vec2 {
  // Blickrichtungs-RECHTS (cross(up, N)) — muss EXAKT `SectionPlane::u_axis`
  // in section.rs spiegeln (dort seit der Entspiegelung dieselbe Formel).
  const [nx, , nz] = plane.normal;
  return { x: nz, y: -nx };
}

/**
 * Ob die Schicht-Bänder einer Wand im Schnitt gegenüber der Default-Zuordnung
 * (layers[0] → uMin) umzukehren sind, damit sie mit der GRUNDRISS-Poché
 * übereinstimmen (Quelle der Wahrheit: `addWallPoche`/generatePlan).
 *
 * Konvention aus dem Grundriss: die Schichten stapeln entlang der linken Normalen
 * `n = leftNormal(u)` der Wandachse `u = normalize(end − start)`, von layers[0]
 * am kleinsten Offset (−T/2, `−n`-Seite) zu layers[n] am größten Offset (`+n`-
 * Seite). Die Aufbaurichtung layers[0] → layers[n] zeigt also nach `+n`. Der
 * Referenzlinien-Versatz (`wallReferenceOffset`) verschiebt nur die absolute
 * Lage, nicht diese Reihenfolge — daher hier ohne Belang.
 *
 * `splitWallLayers` legt layers[0] per Default an uMin (u wächst entlang der
 * Schnitt-u-Achse `uWorld`). Zeigt die Aufbaurichtung `+n` GEGEN `uWorld`
 * (Skalarprodukt < 0), muss die Band-Reihenfolge gespiegelt werden, damit
 * layers[0] auf der korrekten Weltseite (z. B. Aussenputz aussen) liegt und
 * gegenüberliegende Wände spiegelverkehrt erscheinen.
 */
export function wallLayersReversedInU(owner: Wall, uWorld: Vec2): boolean {
  const axis = sub(owner.end, owner.start);
  if (Math.hypot(axis.x, axis.y) < 1e-9) return false;
  const buildDir = leftNormal(normalize(axis)); // +n: layers[0] → layers[n]
  return dot(buildDir, uWorld) < 0;
}

// ── Cut-Polygon → Quell-Bauteil (für die echte Hatch-Auflösung) ────────────
// `cut_section_json` (section.rs) nummeriert jedes Cut-Polygon per
// `ComponentRef { kind, index }`, wobei `index` exakt die Position im
// `walls`/`slabs`-Array ist, das ihm als Modell-JSON übergeben wurde
// (`walls.iter().enumerate()` in section.rs) — also dieselbe Reihenfolge wie
// `projectToModel3d(project).walls`/`.slabs` (toWalls3d.ts).
//
// `projectToWalls3d` zerlegt EINE Wand mit Öffnungen in mehrere Teilquader
// (Pfeiler/Brüstung/Sturz) — die Emission ist also nicht 1:1 Wand→Element.
// Um einen `index` wieder auf seine Quellwand zurückzuführen, wird hier exakt
// dieselbe Segmentierungs-/Skip-Logik wie `emitWall`/`pushSegment`
// (toWalls3d.ts) repliziert — NICHT die Geometrie, nur welches Quellelement
// pro emittiertem Segment "besitzt". Bleibt diese Zählung nicht exakt parallel
// zu `emitWall`, verschieben sich die Indizes und die Hatch-Auflösung wird
// falsch (harmlos: der Aufrufer fällt dann pro Cut-Polygon auf die generische
// Schnitt-Schraffur zurück, siehe `resolveWallSectionStyle`/`generatePlan.ts`).
const OWNER_EPS = 1e-4;

/** Liefert je emittiertem Wand-Teilquader (in Emissions-Reihenfolge) die Quellwand. */
export function wallSegmentOwners(project: Project): Wall[] {
  const owners: Wall[] = [];
  const pushOwner = (wall: Wall, from: number, to: number, zBottom: number, zTop: number) => {
    if (to - from <= OWNER_EPS) return;
    if (zTop - zBottom <= OWNER_EPS) return;
    owners.push(wall);
  };
  for (const wall of project.walls) {
    const { zBottom, zTop } = wallVerticalExtent(project, wall);
    const axisLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    if (axisLen < 1e-9 || zTop - zBottom <= OWNER_EPS) continue;

    const cutouts: Array<{ from: number; to: number; oBottom: number; oTop: number }> = [];
    for (const op of openingsOfWall(project, wall.id)) {
      const iv = openingInterval(wall, op);
      if (!iv) continue;
      const v = openingVerticalExtent(project, wall, op);
      cutouts.push({ from: iv.from, to: iv.to, oBottom: v.zBottom, oTop: v.zTop });
    }
    for (const d of project.doors ?? []) {
      if (d.hostWallId !== wall.id) continue;
      const from = Math.max(0, Math.min(d.position, axisLen));
      const to = Math.max(from, Math.min(d.position + d.width, axisLen));
      if (to - from < OWNER_EPS) continue;
      const oTop = Math.min(zTop, zBottom + d.height);
      cutouts.push({ from, to, oBottom: zBottom, oTop });
    }
    cutouts.sort((a, b) => a.from - b.from);

    if (cutouts.length === 0) {
      pushOwner(wall, 0, axisLen, zBottom, zTop);
      continue;
    }

    let cursor = 0;
    for (const { from, to, oBottom, oTop } of cutouts) {
      const segFrom = Math.max(cursor, from);
      if (from > cursor) pushOwner(wall, cursor, from, zBottom, zTop);
      if (to > segFrom) {
        if (oBottom > zBottom + OWNER_EPS) pushOwner(wall, segFrom, to, zBottom, oBottom);
        if (oTop < zTop - OWNER_EPS) pushOwner(wall, segFrom, to, oTop, zTop);
      }
      cursor = Math.max(cursor, to);
    }
    if (cursor < axisLen) pushOwner(wall, cursor, axisLen, zBottom, zTop);
  }
  return owners;
}

/** Liefert je emittierter Deckenplatte (in Emissions-Reihenfolge) die Quelldecke (1:1, keine Zerlegung). */
export function slabSegmentOwners(project: Project): Ceiling[] {
  const owners: Ceiling[] = [];
  for (const c of project.ceilings ?? []) {
    if (!c.outline || c.outline.length < 3) continue;
    const { zBottom, zTop } = ceilingVerticalExtent(project, c);
    if (zTop - zBottom <= OWNER_EPS) continue;
    owners.push(c);
  }
  return owners;
}

/**
 * Hängt an jedes Cut-Polygon von `output` (in-place) die echte Poché-Füllfarbe
 * + Schraffur des geschnittenen Bauteils an (`fill`/`hatch`), aufgelöst über
 * die Wand-/Decken-Besitzer-Listen. Nicht auflösbare Referenzen (Index
 * außerhalb der Besitzer-Liste, verwaistes `wallTypeId`/Bauteil) bleiben ohne
 * `fill`/`hatch` — `generateSectionPlan` fällt dafür auf die generische
 * Schnitt-Schraffur zurück.
 */
function attachCutStyles(output: SectionOutput, project: Project, plane: SectionPlaneSpec): void {
  if (output.cutPolygons.length === 0) return;
  // Schnitt-u-Weltachse (Modell-2D) — Referenz für die Aussen/Innen-Orientierung
  // der mehrschichtigen Wand-Bänder (siehe `wallLayersReversedInU`).
  const uWorld = sectionUAxisModel(plane);
  const walls = wallSegmentOwners(project);
  const slabs = slabSegmentOwners(project);

  // Phase 1 — ALLE Cut-Bänder (aus allen Wänden UND Decken, mehr- wie einschichtig)
  // als flache Liste sammeln, jedes mit seiner `joinPriority` getaggt (aus dem
  // Bauteil der Schicht bzw. dem repräsentativen Bauteil bei einschichtig).
  const bands: SectionCutPolygon[] = [];
  for (const cp of output.cutPolygons) {
    const ref = cp.component;
    // Dach: Füllung/Schraffur sind bereits je Schicht in `appendRoofSections`
    // aufgelöst; keine Boolean-Dominanz (joinPriority undefined) — unverändert
    // übernehmen. WICHTIG vor dem Slab-Zweig (sonst falscher owner-Lookup).
    if (ref.kind === "roof") {
      const owner = (project.roofs ?? [])[ref.index];
      cp.sourceId = owner?.id;
      cp.categoryCode = owner?.categoryCode;
      bands.push(cp);
      continue;
    }
    if (ref.kind === "wall") {
      const owner = walls[ref.index];
      cp.sourceId = owner?.id;
      cp.categoryCode = owner?.categoryCode;
      // Wand: bei mehrschichtigem Wandtyp wird das EINE geschnittene Rechteck in
      // stehende Teil-Rechtecke je Schicht quer zur Dicke (u) aufgeteilt — das
      // vertikale Gegenstück zur Decken-Zerlegung (dort quer zur Höhe v), siehe
      // `splitWallLayers`. Einschichtige Wände laufen unverändert über
      // `resolveWallSectionStyle` (ein repräsentatives Bauteil).
      if (owner) {
        const wt = getWallType(project, owner);
        if (wt.layers.length > 1) {
          bands.push(...splitWallLayers(cp, project, wt, owner, uWorld));
          continue;
        }
      }
      const style = owner ? resolveWallSectionStyle(project, owner) : null;
      if (style) {
        cp.fill = style.fill;
        cp.hatch = style.hatch;
      }
      cp.joinPriority = owner ? wallRepresentativePriority(project, owner) : undefined;
      cp.componentId = owner ? wallRepresentativeComponentId(project, owner) : undefined;
      bands.push(cp);
      continue;
    }
    // Decke: bei mehrschichtigem Deckentyp wird das EINE geschnittene Rechteck
    // (von der WASM-Schnitt-Extraktion) in liegende Teil-Rechtecke je Schicht
    // aufgeteilt (oben/OK → unten/UK) — siehe `splitSlabLayers`. Nur im
    // Schnitt sichtbar (im Grundriss bleibt die Decke bewusst flächig, siehe
    // `addCeilingPoche`).
    const owner = slabs[ref.index];
    cp.sourceId = owner?.id;
    cp.categoryCode = owner?.categoryCode;
    if (owner) {
      const wt = getCeilingType(project, owner);
      if (wt.layers.length > 1) {
        bands.push(...splitSlabLayers(cp, project, wt, owner));
        continue;
      }
      const style = resolveCeilingSectionStyle(project, owner);
      if (style) {
        cp.fill = style.fill;
        cp.hatch = style.hatch;
      }
      cp.joinPriority = ceilingRepresentativePriority(project, owner);
      cp.componentId = ceilingRepresentativeComponentId(project, owner);
    }
    bands.push(cp);
  }

  // Phase 1b — Decken-Terminierung: Wände mit `sliceTermination` "below"/"above"
  // ENDEN im Schnitt an der Decke (2D = 3D, s. terminateOrSubtractSpans in
  // toWalls3d), statt dass die Decke nur per Priorität herausgestanzt wird und
  // die Wand darüber wieder auftaucht.
  const terminated = applyWallTermination(bands, walls);

  // Phase 2 — Boolean-Dominanz: die stärkere Schicht schneidet die schwächere.
  output.cutPolygons = subtractDominantBands(terminated);
}

/**
 * Decken-Terminierung der Wand-Bänder im (u,v)-Schnittraum — der 2D-Spiegel von
 * `terminateOrSubtractSpans` (toWalls3d, 3D-Pfad): trägt die Wand eines Bands
 * `sliceTermination: "below"`, wird das Band an der UNTERKANTE der dominanten
 * Decken-Bänder gekappt (kein über der Decke wieder auftauchender Rest);
 * `"above"` spiegelbildlich an der Oberkante. Dominant = Decken-Band mit STRIKT
 * höherer `joinPriority` UND u-Überlapp (u-Überlapp ↔ Plan-Überdeckung am Ort
 * der Schnittebene). `"both"`/undefined ⇒ unverändert (die reine Prioritäts-
 * Subtraktion in Phase 2 bleibt das heutige Verhalten). Bänder sind Rechtecke
 * (splitWallLayers/Rust-Extraktor) — gekappt wird über die BBox.
 */
export function applyWallTermination(
  bands: SectionCutPolygon[],
  walls: Wall[],
): SectionCutPolygon[] {
  const EPS_T = 1e-9;
  const bbox = (
    cp: SectionCutPolygon,
  ): { uMin: number; uMax: number; vMin: number; vMax: number } => {
    let uMin = Infinity;
    let uMax = -Infinity;
    let vMin = Infinity;
    let vMax = -Infinity;
    for (const [u, v] of cp.pts) {
      uMin = Math.min(uMin, u);
      uMax = Math.max(uMax, u);
      vMin = Math.min(vMin, v);
      vMax = Math.max(vMax, v);
    }
    return { uMin, uMax, vMin, vMax };
  };
  const slabBands = bands
    .filter((b) => b.component.kind === "slab" && b.joinPriority !== undefined)
    .map((b) => ({ box: bbox(b), joinPriority: b.joinPriority as number }));
  if (slabBands.length === 0) return bands;

  const out: SectionCutPolygon[] = [];
  for (const b of bands) {
    if (b.component.kind !== "wall") {
      out.push(b);
      continue;
    }
    const owner = walls[b.component.index];
    const term = owner?.sliceTermination;
    if ((term !== "below" && term !== "above") || b.joinPriority === undefined) {
      out.push(b);
      continue;
    }
    const wb = bbox(b);
    // Dominante Decken-Cutter mit u-Überlapp — dieselbe Auswahl wie die
    // bandZCuts im 3D (nur STRIKT höhere Priorität schneidet/terminiert).
    // Überlapp ODER Anschluss (±5 cm): eine Decke, die nur bis zur Wand-
    // Innenkante gezeichnet ist, terminiert die Wand trotzdem (VW-Verhalten;
    // ohne die Toleranz liefen Innenputz/Backstein durch die Decke, wenn die
    // Decken-Outline die Wand geometrisch nicht überlappt — Nutzer-Report).
    const TOUCH = 0.05;
    const cutters = slabBands.filter(
      (s) =>
        s.joinPriority > (b.joinPriority as number) &&
        s.box.uMax > wb.uMin - TOUCH &&
        s.box.uMin < wb.uMax + TOUCH,
    );
    if (cutters.length === 0) {
      out.push(b);
      continue;
    }
    if (term === "below") {
      // Wand endet an der Decken-UNTERKANTE (kleinstes vMin der Cutter).
      let clipTop = Infinity;
      for (const c of cutters) clipTop = Math.min(clipTop, c.box.vMin);
      const top = Math.min(clipTop, wb.vMax);
      if (top > wb.vMin + EPS_T) {
        out.push({
          ...b,
          pts: [
            [wb.uMin, top],
            [wb.uMax, top],
            [wb.uMax, wb.vMin],
            [wb.uMin, wb.vMin],
          ],
        });
      }
      continue;
    }
    // "above": Wand beginnt an der Decken-OBERKANTE (grösstes vMax der Cutter).
    let clipBottom = -Infinity;
    for (const c of cutters) clipBottom = Math.max(clipBottom, c.box.vMax);
    const bottom = Math.max(clipBottom, wb.vMin);
    if (bottom < wb.vMax - EPS_T) {
      out.push({
        ...b,
        pts: [
          [wb.uMin, wb.vMax],
          [wb.uMax, wb.vMax],
          [wb.uMax, bottom],
          [wb.uMin, bottom],
        ],
      });
    }
  }
  return out;
}

/**
 * Repräsentative `joinPriority` einer Wand für die Schnitt-Dominanz, wenn ihre
 * Poché einschichtig (ein Band über die volle Dicke) gezeichnet wird: die
 * HÖCHSTE joinPriority ihrer Schichten — dieselbe Regel, mit der
 * `resolveWallSectionStyle` das tragende Bauteil (dessen Füllung/Schraffur das
 * Band trägt) wählt. `undefined`, wenn der Wandtyp/keine Schicht auflösbar ist
 * (das Band nimmt dann an keiner Subtraktion teil).
 */
function wallRepresentativePriority(project: Project, wall: Wall): number | undefined {
  try {
    const wt = getWallType(project, wall);
    let best: number | undefined;
    for (const layer of wt.layers) {
      const p = getComponent(project, layer.componentId).joinPriority;
      if (best === undefined || p > best) best = p;
    }
    return best;
  } catch {
    return undefined;
  }
}

/**
 * Bauteil-Identität einer einschichtig gezeichneten Wand-Poché für die MERGE-
 * Regel: die `id` des tragenden Bauteils (höchste joinPriority) — exakt das
 * Bauteil, dessen Füllung/Schraffur `resolveWallSectionStyle` dem Band gibt und
 * dessen `joinPriority` `wallRepresentativePriority` liefert. `undefined`, wenn
 * Wandtyp/keine Schicht auflösbar ist.
 */
function wallRepresentativeComponentId(project: Project, wall: Wall): string | undefined {
  try {
    const wt = getWallType(project, wall);
    let bestId: string | undefined;
    let bestPrio = -Infinity;
    for (const layer of wt.layers) {
      const p = getComponent(project, layer.componentId).joinPriority;
      if (bestId === undefined || p > bestPrio) {
        bestId = layer.componentId;
        bestPrio = p;
      }
    }
    return bestId;
  } catch {
    return undefined;
  }
}

/**
 * Bauteil-Identität einer einschichtig gezeichneten Decken-Poché für die MERGE-
 * Regel: die `id` der ERSTEN Schicht — dasselbe Bauteil, das
 * `resolveCeilingSectionStyle`/`ceilingRepresentativePriority` verwenden.
 * `undefined`, wenn Deckentyp/keine Schicht auflösbar ist.
 */
function ceilingRepresentativeComponentId(project: Project, ceiling: Ceiling): string | undefined {
  try {
    const wt = getCeilingType(project, ceiling);
    const first = wt.layers[0];
    if (!first) return undefined;
    return first.componentId;
  } catch {
    return undefined;
  }
}

/**
 * Repräsentative `joinPriority` einer Decke für die Schnitt-Dominanz, wenn ihre
 * Poché einschichtig (ein Band über die volle Dicke) gezeichnet wird: die der
 * ERSTEN Schicht — dasselbe Bauteil, dessen Füllung/Schraffur
 * `resolveCeilingSectionStyle` dem Band gibt. `undefined`, wenn Deckentyp/keine
 * Schicht auflösbar ist.
 */
function ceilingRepresentativePriority(project: Project, ceiling: Ceiling): number | undefined {
  try {
    const wt = getCeilingType(project, ceiling);
    const first = wt.layers[0];
    if (!first) return undefined;
    return getComponent(project, first.componentId).joinPriority;
  } catch {
    return undefined;
  }
}

// ── Schnitt-Boolean-Dominanz (achsparallele Rechteck-Subtraktion) ───────────
// Kleine Toleranz für Überlappungs-/Rest-Rechtecke: Null-/Negativflächen und
// Rest-Streifen dünner als EPS werden verworfen (Float-Rauschen der u-/v-Meter).
const RECT_EPS = 1e-6;

/** Achsparalleles Rechteck in (u, v)-Metern. */
export interface Rect {
  uMin: number;
  uMax: number;
  vMin: number;
  vMax: number;
}

/** Bounding-Box eines (achsparallelen) Cut-Bands als `Rect`, oder `null` bei <3 Ecken. */
function rectOfBand(band: SectionCutPolygon): Rect | null {
  if (band.pts.length < 3) return null;
  const us = band.pts.map((p) => p[0]);
  const vs = band.pts.map((p) => p[1]);
  return {
    uMin: Math.min(...us),
    uMax: Math.max(...us),
    vMin: Math.min(...vs),
    vMax: Math.max(...vs),
  };
}

/**
 * Rechteck-minus-Rechteck (beide achsparallel): `base` ohne die Überlappung mit
 * `cutter`, zerlegt in 0–4 disjunkte Rest-Rechtecke (links/rechts über die volle
 * Höhe, dann oben/unten im mittleren u-Streifen — überlappungsfrei). Kein echter
 * Überlapp (Fläche ≤ EPS in u oder v) ⇒ `base` bleibt ganz. Vollständige
 * Überdeckung ⇒ leere Liste. Rest-Streifen dünner als EPS werden verworfen.
 */
export function subtractRect(base: Rect, cutter: Rect): Rect[] {
  const oMinU = Math.max(base.uMin, cutter.uMin);
  const oMaxU = Math.min(base.uMax, cutter.uMax);
  const oMinV = Math.max(base.vMin, cutter.vMin);
  const oMaxV = Math.min(base.vMax, cutter.vMax);
  // Kein (nennenswerter) Überlapp — `base` unverändert.
  if (oMaxU - oMinU <= RECT_EPS || oMaxV - oMinV <= RECT_EPS) return [base];

  const out: Rect[] = [];
  const push = (r: Rect) => {
    if (r.uMax - r.uMin > RECT_EPS && r.vMax - r.vMin > RECT_EPS) out.push(r);
  };
  // Links / rechts der Überlappung, jeweils über die volle Basis-Höhe.
  push({ uMin: base.uMin, uMax: oMinU, vMin: base.vMin, vMax: base.vMax });
  push({ uMin: oMaxU, uMax: base.uMax, vMin: base.vMin, vMax: base.vMax });
  // Unten / oben im mittleren u-Streifen (nur der von der Überlappung befreite Rest).
  push({ uMin: oMinU, uMax: oMaxU, vMin: base.vMin, vMax: oMinV });
  push({ uMin: oMinU, uMax: oMaxU, vMin: oMaxV, vMax: base.vMax });
  return out;
}

/**
 * Globale Schnitt-Dominanz: für jedes Band wird die Rechteck-Überlappung ALLER
 * Bänder mit STRIKT höherer `joinPriority` subtrahiert (elementübergreifend —
 * z. B. schneidet ein Decken-Beton-Band 100 ein überlappendes Wand-Putz-Band 10
 * weg). Gleiche Priorität schneidet NICHT (koexistiert → durchgehende Fläche).
 * Bänder ohne `joinPriority` (unauflösbares Bauteil) nehmen weder als Basis noch
 * als Cutter teil und bleiben unverändert erhalten.
 *
 * Kanten: jedes emittierte Rest-Rechteck erhält in `generateSectionPlan` seine
 * eigene Schnitt-Umrisslinie (unverändert). An der Schnittkante fällt die
 * Rest-Rechteck-Kante mit der Kante des stärkeren Bands zusammen — das ist die
 * gewünschte Material-/Fugenlinie zwischen den Schichten; im Inneren einer
 * Schicht entstehen durch die überlappungsfreie Zerlegung keine falschen Kanten.
 */
export function subtractDominantBands(bands: SectionCutPolygon[]): SectionCutPolygon[] {
  const rects = bands.map(rectOfBand);
  const out: SectionCutPolygon[] = [];
  for (let i = 0; i < bands.length; i++) {
    const band = bands[i];
    const base = rects[i];
    const prio = band.joinPriority;
    // Nicht-rechteckig oder ohne Priorität: unverändert durchreichen.
    if (base === null || prio === undefined) {
      out.push(band);
      continue;
    }
    let pieces: Rect[] = [base];
    for (let j = 0; j < bands.length && pieces.length > 0; j++) {
      if (j === i) continue;
      const otherPrio = bands[j].joinPriority;
      const cutter = rects[j];
      if (cutter === null || otherPrio === undefined || otherPrio <= prio) continue;
      const next: Rect[] = [];
      for (const p of pieces) next.push(...subtractRect(p, cutter));
      pieces = next;
    }
    for (const p of pieces) out.push(bandFromRect(band, p));
  }
  // MERGE-Regel: nach der Dominanz-Subtraktion angrenzende/überlappende Bänder
  // gleicher Komponente + Priorität zu einem Körper verschmelzen (keine innere
  // Trennlinie durch gleichartiges Material). Die Subtraktion oben bleibt davon
  // unberührt (bit-identisch) — hier werden nur gleichartige Reste vereinigt.
  return mergeSameComponentBands(out);
}

/**
 * Union zweier achsparalleler Rechtecke, ABER NUR wenn das Ergebnis EXAKT wieder
 * ein Rechteck ist — sonst `null`. Zwei Fälle liefern eine rechteckige Union
 * (jeweils mit `RECT_EPS`-Toleranz):
 *   • Enthaltensein: eines liegt vollständig im anderen ⇒ das umschließende.
 *   • Achs-Deckung + Berührung: in einer Achse deckungsgleich (gleiche min/max)
 *     UND in der anderen berührend/überlappend (kein Spalt) ⇒ Bounding-Box.
 * Teil-/Eck-Überlappungen (Union wäre L-förmig) und Bänder mit Spalt liefern
 * `null` — sie dürfen NICHT verschmolzen werden (die Bounding-Box deckte sonst
 * leere Fläche ab). Genau die im Schnitt vorkommenden bündigen Rechtecke.
 */
function rectUnionIfRect(a: Rect, b: Rect): Rect | null {
  const E = RECT_EPS;
  // Enthaltensein (inkl. Deckungsgleichheit): Union = umschließendes Rechteck.
  const aInB =
    b.uMin - a.uMin <= E && a.uMax - b.uMax <= E && b.vMin - a.vMin <= E && a.vMax - b.vMax <= E;
  if (aInB) return { uMin: b.uMin, uMax: b.uMax, vMin: b.vMin, vMax: b.vMax };
  const bInA =
    a.uMin - b.uMin <= E && b.uMax - a.uMax <= E && a.vMin - b.vMin <= E && b.vMax - a.vMax <= E;
  if (bInA) return { uMin: a.uMin, uMax: a.uMax, vMin: a.vMin, vMax: a.vMax };

  const uAligned = Math.abs(a.uMin - b.uMin) <= E && Math.abs(a.uMax - b.uMax) <= E;
  const vAligned = Math.abs(a.vMin - b.vMin) <= E && Math.abs(a.vMax - b.vMax) <= E;
  // Berührung/Überlappung in der jeweils ANDEREN Achse (kein Spalt größer EPS).
  const vTouch = a.vMax >= b.vMin - E && b.vMax >= a.vMin - E;
  const uTouch = a.uMax >= b.uMin - E && b.uMax >= a.uMin - E;
  if ((uAligned && vTouch) || (vAligned && uTouch)) {
    return {
      uMin: Math.min(a.uMin, b.uMin),
      uMax: Math.max(a.uMax, b.uMax),
      vMin: Math.min(a.vMin, b.vMin),
      vMax: Math.max(a.vMax, b.vMax),
    };
  }
  return null;
}

/**
 * MERGE-Phase der Schnitt-Dominanz (vgl. `resolveJoinPriority` "merge",
 * src/model/joins.ts): Bänder mit GLEICHER `componentId` UND gleicher
 * `joinPriority`, deren achsparallele Rechtecke sich berühren/überlappen und
 * eine rechteckige Union bilden (`rectUnionIfRect`), werden zu EINEM Band
 * zusammengefasst — so entsteht an der Berührkante keine innere Trennlinie durch
 * gleichartiges Material (z. B. zwei Backstein-Kerne, Beton-Decke an Beton-Wand).
 *
 * Bänder VERSCHIEDENER Komponenten (auch bei gleicher Priorität) bleiben
 * getrennt (coexist). Bänder ohne `componentId`/`joinPriority` oder ohne
 * Rechteck-Form nehmen nicht teil und werden unverändert durchgereicht — daher
 * ist die Phase für die bestehenden Dominanz-Tests (keine `componentId`) ein
 * No-op. Iterativ bis zum Fixpunkt (Ketten aus ≥3 Rechtecken verschmelzen
 * schrittweise); die Reihenfolge bleibt erhalten (das verschmolzene Rechteck
 * ersetzt das erste Band an seiner Position).
 */
function mergeSameComponentBands(bands: SectionCutPolygon[]): SectionCutPolygon[] {
  const out = bands.slice();
  for (let merged = true; merged; ) {
    merged = false;
    for (let i = 0; i < out.length && !merged; i++) {
      const bi = out[i];
      if (bi.componentId === undefined || bi.joinPriority === undefined) continue;
      const ri = rectOfBand(bi);
      if (!ri) continue;
      for (let j = i + 1; j < out.length; j++) {
        const bj = out[j];
        if (bj.componentId !== bi.componentId || bj.joinPriority !== bi.joinPriority) continue;
        const rj = rectOfBand(bj);
        if (!rj) continue;
        const u = rectUnionIfRect(ri, rj);
        if (!u) continue;
        out[i] = bandFromRect(bi, u);
        out.splice(j, 1);
        merged = true; // Fixpunkt-Neustart: neu entstandene Nachbarschaften erfassen
        break;
      }
    }
  }
  return out;
}

/** Erzeugt aus einem Rest-`Rect` ein Cut-Band, das Stil/Referenz von `src` erbt. */
function bandFromRect(src: SectionCutPolygon, r: Rect): SectionCutPolygon {
  return {
    component: src.component,
    color: src.color,
    pts: [
      [r.uMin, r.vMax],
      [r.uMax, r.vMax],
      [r.uMax, r.vMin],
      [r.uMin, r.vMin],
    ],
    fill: src.fill,
    hatch: src.hatch,
    joinPriority: src.joinPriority,
    componentId: src.componentId,
    sourceId: src.sourceId,
  };
}

/**
 * Zerlegt das EINE geschnittene Deckenrechteck (`cp`, vier Ecken in u/v-Metern)
 * in liegende Teil-Rechtecke je Schicht des Deckentyps `wt` — das Schnitt-
 * Gegenstück zur mehrschichtigen Wand-Poché (dort im Grundriss als Bänder quer
 * zur Achse; hier im Schnitt als Bänder über die Höhe v, oben/OK → unten/UK,
 * exakt wie der liegende Aufbau physisch stapelt). Die Modell-Schichtdicken
 * werden proportional auf die tatsächlich geschnittene Höhe skaliert (falls
 * `Ceiling.thickness` die Typ-Summe übersteuert). Jedes Teil-Rechteck trägt
 * Füllung + Schraffur seines Bauteils; die Fugen ergeben sich implizit aus den
 * aneinanderstoßenden Rechtecken (jedes bekommt in `generateSectionPlan` die
 * generische Schnitt-Umrisslinie).
 */
export function splitSlabLayers(
  cp: SectionCutPolygon,
  project: Project,
  wt: ReturnType<typeof getCeilingType>,
  owner: Ceiling,
): SectionCutPolygon[] {
  const totalT = wt.layers.reduce((s, l) => s + l.thickness, 0);
  const us = cp.pts.map((p) => p[0]);
  const vs = cp.pts.map((p) => p[1]);
  const uMin = Math.min(...us);
  const uMax = Math.max(...us);
  const vMin = Math.min(...vs);
  const vMax = Math.max(...vs); // vMax = OK (oben), vMin = UK (unten)
  const vSpan = vMax - vMin;
  if (totalT <= 1e-9 || vSpan <= 1e-9) return [cp];
  const scale = vSpan / totalT;
  // Attribut-Override der Decke (By-Layer/By-Object) gilt uniform für ALLE
  // Schichten — analog zu splitWallLayers und dem Grundriss (addCeilingPoche).
  const category = getLayerCategory(project, owner.categoryCode);

  const out: SectionCutPolygon[] = [];
  let acc = 0; // kumulierte Dicke von OK (oben) nach UK (unten)
  for (const layer of wt.layers) {
    const comp = getComponent(project, layer.componentId);
    const hatchId =
      resolveHatchId(owner.hatchId, owner.hatchSource, category, comp.hatchId) ?? comp.hatchId;
    const hatch = resolveHatch(
      project,
      hatchId,
      SECTION_SLAB_AXIS_ANGLE_DEG,
      resolveForeground(comp, owner.foreground, category, owner.foregroundSource),
    );
    const bgOverride = resolveBackground(comp, owner.background, category, owner.backgroundSource);
    const vTop = vMax - acc * scale;
    acc += layer.thickness;
    const vBottom = vMax - acc * scale;
    out.push({
      component: cp.component,
      color: cp.color,
      pts: [
        [uMin, vTop],
        [uMax, vTop],
        [uMax, vBottom],
        [uMin, vBottom],
      ],
      fill: bgOverride ?? (hatch.pattern === "solid" ? HATCH_INK : HATCH_PAPER),
      hatch,
      joinPriority: comp.joinPriority,
      componentId: comp.id,
      sourceId: cp.sourceId,
      categoryCode: cp.categoryCode,
    });
  }
  return out;
}

/**
 * Achswinkel einer GESCHNITTENEN Wand im Schnitt-Koordinatensystem (Modell-
 * Konvention wie `wallAngleDeg` in resolveHatch): das Wand-Band steht vertikal
 * (Achse entlang v, atan2(1,0) = 90°). Damit drehen wandrelative Muster
 * (Dämmung, Backstein) im Schnitt genauso mit der Wand wie im Grundriss.
 */
// Wandachse im Schnitt: die geschnittene Wand STEHT (Band entlang v) — wand-
// relative Muster (Dämm-Sprossen QUER zur Schicht) brauchen den 90°-Achswinkel,
// damit die Sprossen horizontal liegen (empirisch verifiziert am Demo-Schnitt;
// die liegende Decke braucht spiegelbildlich denselben Wert, s. u.).
const SECTION_WALL_AXIS_ANGLE_DEG = 90;
// Deckenachse im Schnitt: die geschnittene Decke LIEGT (Band entlang u) —
// wandrelative Muster laufen horizontal.
const SECTION_SLAB_AXIS_ANGLE_DEG = 90;

/**
 * Zerlegt das EINE geschnittene Wandrechteck (`cp`, vier Ecken in u/v-Metern) in
 * stehende Teil-Rechtecke je Schicht des Wandtyps `wt` — das Wand-Gegenstück zu
 * `splitSlabLayers`. Achsen-Spiegelung: eine Wand ist vertikal geschnitten, das
 * Schnittrechteck hat die volle HÖHE in v (vMin..vMax) und spannt über die DICKE
 * in u (uMin..uMax); die Schichten stapeln quer zur Dicke, also entlang u — im
 * Gegensatz zur Decke, die quer zur Höhe (v) geschichtet ist. v bleibt darum je
 * Band voll, u wird proportional zu den Schichtdicken zerlegt. Die Modell-
 * Schichtdicken werden auf die tatsächlich geschnittene Dicke (uSpan) skaliert.
 * Jedes Teil-Rechteck trägt Füllung + Schnitt-Schraffur seines Bauteils; die
 * Fugen ergeben sich implizit aus den aneinanderstoßenden Rechtecken.
 *
 * Reihenfolge/Orientierung: `WallType.layers` ist von einer Wandseite zur anderen
 * geordnet (layers[0] = Aussenseite). Welche u-Seite des Schnittrechtecks der
 * Aussenseite entspricht, folgt NICHT aus dem (u, v)-Rechteck allein, sondern aus
 * der Wandgeometrie + der Schnitt-u-Weltachse `uWorld`: `wallLayersReversedInU`
 * projiziert die Grundriss-Aufbaurichtung (`+leftNormal` der Achse, dieselbe
 * Konvention wie `addWallPoche`/generatePlan) auf `uWorld`. Ist das Vorzeichen
 * negativ, wird die Band-Reihenfolge gespiegelt (layers[0] → uMax statt uMin), so
 * dass Schnitt und Grundriss übereinstimmen und gegenüberliegende Wände spiegel-
 * verkehrt erscheinen (Dämmung aussen, Backstein innen).
 *
 * Annahme: rechteckiges Schnittpolygon (min/max-Bounding-Box auf `cp.pts`,
 * identisch zu `splitSlabLayers`).
 */
export function splitWallLayers(
  cp: SectionCutPolygon,
  project: Project,
  wt: ReturnType<typeof getWallType>,
  owner: Wall,
  uWorld: Vec2,
): SectionCutPolygon[] {
  const totalT = wt.layers.reduce((s, l) => s + l.thickness, 0);
  const us = cp.pts.map((p) => p[0]);
  const vs = cp.pts.map((p) => p[1]);
  const uMin = Math.min(...us);
  const uMax = Math.max(...us);
  const vMin = Math.min(...vs);
  const vMax = Math.max(...vs);
  const uSpan = uMax - uMin;
  if (totalT <= 1e-9 || uSpan <= 1e-9) return [cp];
  const scale = uSpan / totalT;

  // Aussen/Innen-Orientierung: per Default liegt layers[0] an uMin; zeigt die
  // Wand-Aufbaurichtung gegen die Schnitt-u-Achse, werden die Bänder gespiegelt.
  const layers = wallLayersReversedInU(owner, uWorld) ? [...wt.layers].reverse() : wt.layers;
  // Attribut-Override der Wand (By-Layer/By-Object) gilt uniform für ALLE
  // Schichten — analog zum Grundriss (addWallPoche in walls.ts).
  const category = getLayerCategory(project, owner.categoryCode);

  const out: SectionCutPolygon[] = [];
  let acc = 0; // kumulierte Dicke von uMin (erste einsortierte Schicht) nach uMax
  for (const layer of layers) {
    const comp = getComponent(project, layer.componentId);
    // Wandrelative Muster (relativeToWall, z. B. Dämmung/Backstein) folgen der
    // Wandachse — im Schnitt steht die geschnittene Wand VERTIKAL (Bandachse
    // entlang v, Modellwinkel 90°). Wie im Grundriss (`addWallPoche` übergibt
    // die Wandachse) wird der Achswinkel mitgegeben, sonst liefe die Dämmung
    // vertikal statt quer zur Wanddicke (horizontal).
    const hatchId =
      resolveHatchId(owner.hatchId, owner.hatchSource, category, comp.hatchId) ?? comp.hatchId;
    const hatch = resolveHatch(
      project,
      hatchId,
      SECTION_WALL_AXIS_ANGLE_DEG,
      resolveForeground(comp, owner.foreground, category, owner.foregroundSource),
    );
    const bgOverride = resolveBackground(comp, owner.background, category, owner.backgroundSource);
    const uLeft = uMin + acc * scale;
    acc += layer.thickness;
    const uRight = uMin + acc * scale;
    out.push({
      component: cp.component,
      color: cp.color,
      pts: [
        [uLeft, vMax],
        [uRight, vMax],
        [uRight, vMin],
        [uLeft, vMin],
      ],
      fill: bgOverride ?? (hatch.pattern === "solid" ? HATCH_INK : HATCH_PAPER),
      hatch,
      joinPriority: comp.joinPriority,
      componentId: comp.id,
      sourceId: cp.sourceId,
      categoryCode: cp.categoryCode,
    });
  }
  return out;
}

/**
 * Berechnet den Schnitt/die Ansicht der Ebene `level` gegen das Modell `project`
 * über den WASM-Extraktor. Asynchron (das render3d-WASM-Modul wird lazy geladen).
 *
 * Gibt `null` zurück, wenn die Ebene keine gültige Schnittlinie hat. Wirft, wenn
 * das WASM-Modul den Export (noch) nicht bereitstellt — der Aufrufer fängt das ab
 * und blendet einen Fallback ein (pkg3d muss dann über `npm run build:engine3d`
 * neu gebaut werden, damit `cut_section_json` verfügbar ist).
 */
/** Hex "#rrggbb" → RGB 0..1 (Fallback bei ungültigem Hex). */
function hexToRgb01(hex: string, fallback: [number, number, number]): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return fallback;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

/** Default-Albedo geschnittener Dächer (wie ROOF_RGB im 3D). */
const ROOF_CUT_RGB: [number, number, number] = [0.72, 0.45, 0.36];

/**
 * Schneidet die vertikale Schnittebene analytisch mit den DÄCHERN des Projekts
 * und hängt die Schnitt-Polygone an `output.cutPolygons` an — der Rust-Extraktor
 * (`cut_section_json`) kennt nur Wände + Decken, Dächer werden TS-seitig ergänzt.
 *
 * Vorgehen je Dach: die Grundriss-Spur der Schnittebene (Gerade durch
 * `plane.point`, Richtung u-Achse) wird gegen jede DACHFLÄCHE (konvexes Polygon
 * der Aufsicht, s. roofGeometry.planes) geclippt (Cyrus–Beck) → u-Intervall.
 * Die Oberkante v(u) ist auf dem Intervall LINEAR (Ebenengleichung); die
 * Unterkante liegt um die LOTRECHTE Dicke / cos(Flächenneigung) tiefer
 * (vertikale Dicke). Mehrschichtige Dächer (roofLayers) werden wie beim
 * Decken-Schnitt in Bänder von aussen (Eindeckung, oben) nach innen zerlegt,
 * jedes mit Füllung/Schraffur seines Bauteils (Neutralisierung wie
 * `resolveCeilingSectionStyle`: Papier-Hintergrund, solid → Tinte).
 *
 * Bewusst NUR Schnitt-Polygone (keine Ansichts-/Silhouettenkanten des Dachs
 * hinter der Ebene) — Ansicht/Elevation des Dachs bleibt eine eigene Phase.
 * Giebel (vertikale Endflächen) schneiden die vertikale Ebene nur in einer
 * Linie (keine Fläche) und entfallen.
 */
export function appendRoofSections(
  output: SectionOutput,
  project: Project,
  plane: SectionPlaneSpec,
): void {
  const roofs = project.roofs ?? [];
  if (roofs.length === 0) return;
  // Grundriss-Spur: Basispunkt + u-Richtung (Modell-2D). world=[x,H,y] ⇒
  // plane.point[0]=x, plane.point[2]=y; u-Achse = (−nz, nx) (s. section.rs).
  const base: Vec2 = { x: plane.point[0], y: plane.point[2] };
  const uDir = sectionUAxisModel(plane);
  const EPS_U = 1e-6;

  roofs.forEach((roof, index) => {
    const eavesZ = roofBaseElevation(project, roof);
    const geo = roofGeometry(roof, eavesZ);
    const layers = roofLayers(project, roof);
    const totalT = layers.reduce((s, l) => s + Math.max(0, l.thickness), 0);
    if (totalT <= 1e-9) return;

    for (const pl of geo.planes) {
      const pts = pl.pts;
      if (pts.length < 3) continue;
      // Ebenengleichung z = z0 − (A(x−x0)+B(y−y0))/C über die Newell-Normale.
      let A = 0;
      let B = 0;
      let C = 0;
      for (let i = 0; i < pts.length; i++) {
        const c = pts[i];
        const d = pts[(i + 1) % pts.length];
        A += (c[1] - d[1]) * (c[2] + d[2]);
        B += (c[2] - d[2]) * (c[0] + d[0]);
        C += (c[0] - d[0]) * (c[1] + d[1]);
      }
      if (Math.abs(C) < 1e-9) continue; // (nahezu) vertikale Fläche — kein Flächenschnitt
      const nLen = Math.hypot(A, B, C);
      const cosTheta = Math.abs(C) / (nLen || 1);
      const zAt = (x: number, y: number): number =>
        pts[0][2] - (A * (x - pts[0][0]) + B * (y - pts[0][1])) / C;

      // Cyrus–Beck: Gerade base + t·uDir gegen das konvexe Aufsichts-Polygon.
      // Orientierungsunabhängig: Innenseite je Kante über den Polygon-Schwerpunkt.
      let cx = 0;
      let cy = 0;
      for (const p of pts) {
        cx += p[0];
        cy += p[1];
      }
      cx /= pts.length;
      cy /= pts.length;
      let tLo = -Infinity;
      let tHi = Infinity;
      let outside = false;
      for (let i = 0; i < pts.length && !outside; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        // Kanten-Normale, zum Schwerpunkt orientiert (Innenseite).
        let ex = -(b[1] - a[1]);
        let ey = b[0] - a[0];
        if (ex * (cx - a[0]) + ey * (cy - a[1]) < 0) {
          ex = -ex;
          ey = -ey;
        }
        const denom = ex * uDir.x + ey * uDir.y;
        const dist = ex * (base.x - a[0]) + ey * (base.y - a[1]);
        if (Math.abs(denom) < 1e-12) {
          if (dist < -1e-9) outside = true; // parallel ausserhalb
          continue;
        }
        const t = -dist / denom;
        if (denom > 0) tLo = Math.max(tLo, t);
        else tHi = Math.min(tHi, t);
      }
      if (outside || tHi - tLo <= EPS_U) continue;

      const q = (t: number): Vec2 => ({ x: base.x + t * uDir.x, y: base.y + t * uDir.y });
      const p0 = q(tLo);
      const p1 = q(tHi);
      const zTop0 = zAt(p0.x, p0.y);
      const zTop1 = zAt(p1.x, p1.y);

      // Schicht-Bänder von aussen (oben) nach innen, vertikale Dicke je Schicht.
      let prefixV = 0;
      for (const layer of layers) {
        const t = Math.max(0, layer.thickness);
        if (t <= 1e-9) continue;
        const vT = t / Math.max(cosTheta, 1e-6);
        const top0 = zTop0 - prefixV;
        const top1 = zTop1 - prefixV;
        prefixV += vT;

        let fill: string | undefined;
        let hatch: HatchRender | undefined;
        let color = ROOF_CUT_RGB;
        if (layer.componentId) {
          try {
            const comp = getComponent(project, layer.componentId);
            const h = resolveHatch(project, comp.hatchId);
            fill = h.pattern === "solid" ? HATCH_INK : HATCH_PAPER;
            hatch = h;
            color = hexToRgb01(comp.color, ROOF_CUT_RGB);
          } catch {
            fill = undefined;
            hatch = undefined;
          }
        }
        output.cutPolygons.push({
          component: { kind: "roof", index },
          color,
          pts: [
            [tLo, top0],
            [tHi, top1],
            [tHi, top1 - vT],
            [tLo, top0 - vT],
          ],
          ...(fill ? { fill } : {}),
          ...(hatch ? { hatch } : {}),
        });
      }
    }
  });
}

/** Mittelpunkt (Modell-2D) einer Punktliste (Outline-Schwerpunkt, naiv). */
function centroid2d(pts: Vec2[]): Vec2 | null {
  if (pts.length === 0) return null;
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p.x;
    y += p.y;
  }
  return { x: x / pts.length, y: y / pts.length };
}

/**
 * Blendet Ansichtskanten (sichtbar/verdeckt) aus, deren QUELL-Bauteil weiter als
 * `depth` Meter HINTER der Schnittebene (in Blickrichtung) liegt — die
 * Schnitt-Tiefe (`DrawingLevel.depth`). Die Distanz wird über den REPRÄSENTATIVEN
 * Bauteilpunkt (Wand-Mitte bzw. Outline-Schwerpunkt) gegen die Ebenennormale
 * gemessen (in-place).
 *
 * NÄHERUNG (bewusst, kein Rust-Hack): der Rust-Extraktor liefert die Kanten nur in
 * (u, v) OHNE echte Tiefe je Kante — die exakte Lösung bräuchte eine Tiefen-Achse
 * aus `section.rs`. Bis dahin filtert dieser Owner-Distanz-Test grob nach dem
 * Bauteil-Mittelpunkt: ein Bauteil wird GANZ ein- oder ausgeblendet (kein
 * Teil-Clipping an der Tiefengrenze). Cut-Polygone liegen auf der Ebene (Distanz
 * ~0) und bleiben immer erhalten. TODO: exakte per-Kante-Tiefe aus render3d
 * (section.rs) zurückgeben, dann hier hart nach Kanten-Tiefe clippen.
 */
export function filterByDepth(
  output: SectionOutput,
  project: Project,
  plane: SectionPlaneSpec,
  depth: number,
): void {
  if (!(depth > 0)) return;
  // Blickrichtung + Ebenenaufpunkt in Modell-2D (x = world.x, y = world.z).
  const blick = normalize({ x: plane.normal[0], y: plane.normal[2] });
  const origin = { x: plane.point[0], y: plane.point[2] };
  const walls = wallSegmentOwners(project);
  const slabs = slabSegmentOwners(project);
  const roofs = project.roofs ?? [];

  const ownerPoint = (ref: SectionComponentRef): Vec2 | null => {
    if (ref.kind === "wall") {
      const w = walls[ref.index];
      return w ? { x: (w.start.x + w.end.x) / 2, y: (w.start.y + w.end.y) / 2 } : null;
    }
    if (ref.kind === "slab") {
      const c = slabs[ref.index];
      return c ? centroid2d(c.outline) : null;
    }
    const r = roofs[ref.index];
    return r ? centroid2d(r.outline) : null;
  };

  const keep = (e: SectionEdge): boolean => {
    const p = ownerPoint(e.component);
    if (!p) return true; // Unauflösbar: konservativ behalten.
    // Distanz HINTER der Ebene entlang der Blickrichtung; ≤ depth ⇒ behalten.
    const d = dot(sub(p, origin), blick);
    return d <= depth + 1e-6;
  };

  output.visibleEdges = output.visibleEdges.filter(keep);
  output.hiddenEdges = output.hiddenEdges.filter(keep);
}

export async function computeSection(
  project: Project,
  level: DrawingLevel,
): Promise<SectionOutput | null> {
  const plane = sectionPlaneFromLevel(level);
  if (!plane) return null;
  const mod = (await loadEngine3d()) as Engine3dSection;
  if (typeof mod.cut_section_json !== "function") {
    throw new Error(
      "render3d-WASM ohne cut_section_json — pkg3d neu bauen (npm run build:engine3d)",
    );
  }
  // Schnitt-Eingabe: EINE Voll-Box pro Wand (layeredWalls:false), damit die
  // Cut-Polygone 1:1 zu `wallSegmentOwners` (Öffnungs-Segmentierung) liegen und
  // `splitWallLayers` die materialspezifischen Schnitt-Bänder korrekt aus dem
  // EINEN Wandrechteck erzeugt. Der 3D-Viewer bekommt weiter per-Schicht-Boxen.
  const modelJson = JSON.stringify(projectToModel3d(project, { layeredWalls: false }));
  const json = mod.cut_section_json(
    modelJson,
    plane.point[0],
    plane.point[1],
    plane.point[2],
    plane.normal[0],
    plane.normal[1],
    plane.normal[2],
  );
  const output = JSON.parse(json) as SectionOutput;
  // Kanten GESCHNITTENER Bauteile verwerfen: der Extraktor projiziert auch die
  // Restkörper der geschnittenen Wände/Decken (Deckel-/Bodenkanten laufen quer
  // durch die eigene Schnitt-Poché — die „komischen Linien über den
  // Schnittlinien"). Die Schnittgeometrie trägt die Poché-Kontur selbst; die
  // Ansichtskanten UNGESCHNITTENER Bauteile (z. B. Fenster der Rückwand)
  // bleiben erhalten.
  const cutOwners = new Set(
    output.cutPolygons.map((cp) => `${cp.component.kind}:${cp.component.index}`),
  );
  const notCut = (e: SectionEdge): boolean =>
    !cutOwners.has(`${e.component.kind}:${e.component.index}`);
  output.visibleEdges = output.visibleEdges.filter(notCut);
  output.hiddenEdges = output.hiddenEdges.filter(notCut);
  // Dächer TS-seitig ergänzen (der Rust-Extraktor kennt nur Wände + Decken).
  appendRoofSections(output, project, plane);
  attachCutStyles(output, project, plane);
  // Schnitt-Tiefe: Kanten weiter als `level.depth` hinter der Ebene ausblenden.
  if (level.depth !== undefined) filterByDepth(output, project, plane, level.depth);
  return output;
}

/**
 * Projekt-Felder, die den abgeleiteten Schnitt/die Ansicht NICHT beeinflussen.
 * Vor allem `drawings2d`: jede Linie, die man IM Schnitt zeichnet, landet dort —
 * ohne diesen Ausschluss rechnete jede solche Änderung den ganzen Schnitt neu.
 */
const SECTION_IRRELEVANT_KEYS = new Set<string>(["drawings2d", "layouts", "viewSnapshots", "masterLayouts"]);

/**
 * Ob zwei Projektstände denselben Schnitt/dieselbe Ansicht ergeben — Vergleich
 * je Feld per Referenz (das Projekt wird immutabel aktualisiert, unveränderte
 * Teile behalten ihre Identität), ohne {@link SECTION_IRRELEVANT_KEYS}. Bei
 * Unsicherheit `false` (dann wird eben neu gerechnet).
 */
export function sameSectionInputs(a: Project, b: Project): boolean {
  if (a === b) return true;
  const ra = a as unknown as Record<string, unknown>;
  const rb = b as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of keys) {
    if (SECTION_IRRELEVANT_KEYS.has(k)) continue;
    if (ra[k] !== rb[k]) return false;
  }
  return true;
}

/** Ob zwei Stände einer Schnitt-/Ansichtsebene dieselbe Projektion ergeben. */
export function sameSectionLine(a: DrawingLevel, b: DrawingLevel): boolean {
  if (a === b) return true;
  const la = a.linePoints;
  const lb = b.linePoints;
  const sameLine =
    la === lb ||
    (!!la && !!lb &&
      la[0].x === lb[0].x && la[0].y === lb[0].y && la[1].x === lb[1].x && la[1].y === lb[1].y);
  return (
    sameLine &&
    a.id === b.id &&
    a.kind === b.kind &&
    (a.directionSign ?? 1) === (b.directionSign ?? 1) &&
    a.depth === b.depth &&
    !!a.shadows === !!b.shadows
  );
}

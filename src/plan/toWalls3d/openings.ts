// Öffnungs-Domäne der 3D-Ableitung: Glasscheibe(n)/Türblatt, Rahmen-/Sprossen-
// Riegel (Zarge/Blendrahmen/Kämpfer/Mittelpfosten/Flügelrahmen + SIA-Symbole)
// und der Rollladen-/Sonnenschutzkasten typisierter Tür-/Fensteröffnungen — das
// 3D-Pendant zu `generatePlan/openings.ts`.

import type { Opening, Project, SashDef, Wall } from "../../model/types";
import { getDoorType, getWindowType, glazingPanesOf, openingsOfWall } from "../../model/types";
import { openingInterval, openingVerticalExtent } from "../../geometry/opening";
import { wallVerticalExtent } from "../../model/wall";
import type { DetailLevel } from "../../ui/TopBar";
import { EPS, type RMesh, type RRgb } from "./shared";
import { wallThicknessSafe } from "./bands";

/** Helles, leicht bläuliches Fenster-Glas (Scheibe in der Öffnung). */
const GLASS_RGB: RRgb = [0.62, 0.76, 0.85];
/**
 * Halbe Dicke EINER Fensterscheibe (Meter, Mehrfachverglasungs-Pfad). Kompakt
 * gehalten (8 mm Gesamtdicke je Scheibe, wie ein reales Einzelglas), damit
 * z. B. eine Dreifachverglasung noch in den realistisch schlanken Default-
 * Rahmen ({@link DEFAULT_FRAME_DEPTH}, ~70 mm) passt — bei der früheren
 * "volle Wanddicke"-Rahmentiefe gab es dafür reichlich Platz, im schlanken
 * Rahmen nicht mehr.
 */
const GLASS_HALF_THICK = 0.004;
/**
 * Helles, warmes Rahmen-Grau (Zarge/Blendrahmen/Kämpfer/Sprossen) — bewusst
 * deutlich heller als Wand und klar von der bläulichen Scheibe ({@link GLASS_RGB})
 * unterscheidbar, damit der Rahmen im 3D als eigenes Bauteil lesbar ist
 * (s. {@link emitOpeningFrames}).
 */
const FRAME_RGB: RRgb = [0.85, 0.85, 0.83];
/** Heller Grauton für den Rollladen-/Sonnenschutzkasten (s. {@link emitOpeningShading}). */
const SHADING_RGB: RRgb = [0.88, 0.88, 0.9];
/**
 * Heller Stein-/Beton-Grauton der Fensterbank (Sims/Tropfkante) — bewusst etwas
 * dunkler/kühler als der Rahmen ({@link FRAME_RGB}), damit die Bank im 3D als
 * eigenes Bauteil (nicht als Rahmenfortsatz) liest (s. Sims-Zweig in
 * {@link frameMeshesForOpening}).
 */
const SILL_RGB: RRgb = [0.8, 0.8, 0.78];
/**
 * Dunkles Grau der SIA-Öffnungssymbole (dünne Diagonalen AUF dem Glas, wie in der
 * 2D-Ansicht) — feine dunkle Linien auf der Scheibe (s. Symbol-Zweig in
 * {@link frameMeshesForOpening}). Als sehr dünne, in der Öffnungsebene gedrehte
 * Prismen ({@link openingPlaneBox}) knapp vor der Glasebene.
 */
const SYMBOL_RGB: RRgb = [0.25, 0.27, 0.3];
/** Halbe Breite der Symbol-Diagonalen (Meter) — ~5 mm Gesamtbreite, feine Linie. */
const SYMBOL_HALF_WIDTH = 0.0025;
/**
 * Warmer, heller Türblatt-Ton — bewusst wärmer/heller als der Rahmen
 * ({@link FRAME_RGB}), damit das Blatt im 3D als eigene Füllung liest
 * (s. {@link doorLeafPanels}).
 */
const DOOR_LEAF_RGB: RRgb = [0.93, 0.9, 0.85];
/** Türblatt-Dicke quer zur Wand (Meter). */
const DOOR_LEAF_THICK = 0.04;
/** Default-Ansichtsbreite des Rahmenprofils (Meter), wenn `TYPE.frameWidth` fehlt. */
const DEFAULT_FRAME_WIDTH = 0.06;
/**
 * Default-Rahmentiefe (Meter), wenn ein Typ keine `frameDepth` nennt: reale
 * Fensterrahmen sind ~70–90 mm tief (Holz/PVC/Alu), UNABHÄNGIG von der
 * Wanddicke — ein schlanker Rahmen mit sichtbarer Laibung ringsum, nicht ein
 * massiver Block über die volle Wandtiefe. Deckt sich mit
 * `geometry/opening.ts::DEFAULT_FRAME_DEPTH` (2D=3D).
 */
const DEFAULT_FRAME_DEPTH = 0.07;

// Faces eines Boxen-Quaders als Dreiecks-Indizes (Ecken-Index-Bits: bit0 =
// Achse from/to, bit1 = Höhe UK/OK, bit2 = Quer-Versatz nMin/nMax). Doppelseitig
// gerendert (append_context_mesh) ⇒ Winding egal; je Fläche 2 Dreiecke, 6
// Flächen = 12 Dreiecke. Gemeinsame Topologie für Glasscheiben UND Rahmen-/
// Sprossen-Riegel (s. {@link openingAxisBox}).
const OPENING_BOX_TRIS: number[] = [
  0, 1, 3, 0, 3, 2, // Quer-Versatz nMin
  4, 5, 7, 4, 7, 6, // Quer-Versatz nMax
  0, 1, 5, 0, 5, 4, // UK
  2, 3, 7, 2, 7, 6, // OK
  0, 2, 6, 0, 6, 4, // from
  1, 3, 7, 1, 7, 5, // to
];

/**
 * Baut EINEN geschlossenen Achsen-Quader (8 Ecken, 12 Dreiecke) für eine
 * Öffnung — die gemeinsame Basis von {@link emitOpeningGlass} (Scheiben) und
 * {@link emitOpeningFrames} (Rahmen-/Sprossen-Riegel). Achsen-Intervall
 * `[from,to]` (Meter ab `wall.start`, entlang der Wandrichtung u), Höhen-
 * Intervall `[zBottom,zTop]` (absolute Weltmeter) und Quer-Versatz-Intervall
 * `[nMin,nMax]` (Meter entlang der Grundriss-Normalen n=(uy,−ux), dieselbe
 * Konvention wie die bisherige Glas-Box — `nMin`/`nMax` MÜSSEN nicht sortiert
 * übergeben werden, die Box spannt zwischen beiden Werten). `positions` in
 * MODELL-Metern (x, y, z=Höhe). Liefert `null` bei entarteten Massen (Achse/
 * Höhe/Dicke ≤ EPS) statt eines Nullquaders.
 */
function openingAxisBox(
  wall: Wall,
  from: number,
  to: number,
  zBottom: number,
  zTop: number,
  nMin: number,
  nMax: number,
  color: RRgb,
): RMesh | null {
  if (to - from <= EPS) return null;
  if (zTop - zBottom <= EPS) return null;
  if (Math.abs(nMax - nMin) <= EPS) return null;
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return null;
  const ux = dx / len;
  const uy = dy / len;
  // Grundriss-Normale (Dicken-Achse) — RECHTE Normale (uy,−ux), bewusst NICHT
  // leftNormal (anders als pushSegment/windowSymbol) — kombiniert mit dem
  // (ebenfalls gespiegelten) Vorzeichen in resolveFrameNormalRange ergibt sich
  // daraus physisch die korrekte aussen/innen-Seite (s. dortigen Kommentar).
  const nx = uy;
  const ny = -ux;
  const positions: number[] = [];
  for (let i = 0; i < 8; i++) {
    const s = i & 1 ? to : from;
    const z = i & 2 ? zTop : zBottom;
    const t = i & 4 ? nMax : nMin;
    positions.push(wall.start.x + ux * s + nx * t, wall.start.y + uy * s + ny * t, z);
  }
  return { positions, indices: [...OPENING_BOX_TRIS], kind: "imported", color };
}

/**
 * Baut EIN sehr dünnes Prisma mit FREI orientierter Längsachse IN der Öffnungs-
 * ebene — die diagonale Schwester von {@link openingAxisBox}. Die Längsachse
 * verläuft vom Punkt `(u0,h0)` zum Punkt `(u1,h1)`, beide in Öffnungsebenen-
 * koordinaten: `u` = Meter entlang der Wandrichtung (ab `wall.start`), `h` =
 * absolute Welthöhe (Meter). Der Querschnitt spannt `±halfWidth` senkrecht zur
 * Längsachse INNERHALB der Ebene (gedreht mit) und `[nBack,nFront]` entlang der
 * Grundriss-Normalen (quer zur Wand, Tiefe). Damit lassen sich die schrägen
 * SIA-Öffnungssymbole (Dreh-/Kipp-Diagonalen) als dünne, gedrehte dunkle Riegel
 * AUF dem Glas erzeugen — der Renderer kennt nur Dreiecks-Meshes, keine Linien.
 * `null` bei entarteter Länge (≤ EPS). 8 Ecken, dieselbe {@link OPENING_BOX_TRIS}-
 * Topologie (doppelseitig gerendert ⇒ Winding egal; die drei Bits parametrisieren
 * hier Endpunkt/Quer-Versatz/Tiefe).
 */
function openingPlaneBox(
  wall: Wall,
  u0: number,
  h0: number,
  u1: number,
  h1: number,
  halfWidth: number,
  nFront: number,
  nBack: number,
  color: RRgb,
): RMesh | null {
  const du = u1 - u0;
  const dh = h1 - h0;
  const segLen = Math.hypot(du, dh);
  if (segLen < EPS) return null;
  const dx = wall.end.x - wall.start.x;
  const dy = wall.end.y - wall.start.y;
  const wlen = Math.hypot(dx, dy);
  if (wlen < 1e-9) return null;
  const ux = dx / wlen;
  const uy = dy / wlen;
  // Grundriss-Normale (Dicken-Achse) — dieselbe Konvention wie openingAxisBox.
  const nx = uy;
  const ny = -ux;
  // In der Ebene senkrecht zur Längsachse (u entlang Wand, h = Welthöhe):
  // Rotation der normierten Richtung um 90°. `pu` wirkt auf die u-Achse (Wand),
  // `ph` auf die Höhe — beide in Metern, orthonormal ⇒ echte `halfWidth`-Breite.
  const pu = -dh / segLen;
  const ph = du / segLen;
  const positions: number[] = [];
  for (let i = 0; i < 8; i++) {
    const ui = i & 1 ? u1 : u0;
    const hi = i & 1 ? h1 : h0;
    const s = i & 2 ? 1 : -1;
    const t = i & 4 ? nFront : nBack;
    const u = ui + s * halfWidth * pu;
    const h = hi + s * halfWidth * ph;
    positions.push(wall.start.x + ux * u + nx * t, wall.start.y + uy * u + ny * t, h);
  }
  return { positions, indices: [...OPENING_BOX_TRIS], kind: "imported", color };
}

/** Klemmt `v` auf `[lo,hi]`. */
function clampRange(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Rahmen-Tiefe quer zur Wand (Meter): explizite `frameDepth` des Typs, sonst
 * {@link DEFAULT_FRAME_DEPTH} (auf die Wanddicke geklemmt, falls die Wand
 * dünner als der Default-Rahmen ist).
 */
function resolveAcrossWallDepth(
  frameDepth: number | undefined,
  wallThickness: number,
): number {
  const depth = frameDepth !== undefined && frameDepth > EPS ? frameDepth : DEFAULT_FRAME_DEPTH;
  return Math.min(depth, wallThickness);
}

/**
 * Quer-Versatz-Intervall `[nMin,nMax]` (Meter entlang der Wand-Normalen, s.
 * {@link openingAxisBox}) des Rahmenkörpers — der 3D-Niederschlag des
 * Schichteinzugs (`insetFromFace`/`insetFace`): die Rahmen-VORDERKANTE liegt
 * bündig mit der gewählten Wandfläche, zurückversetzt um `insetFromFace`
 * (0/fehlt ⇒ bündig), der Rahmenkörper erstreckt sich von dort aus `depth`
 * Meter zur Wandmitte hin. "aussen" liegt an der POSITIVEN Normalen-Seite
 * (kleinster Schicht-Offset in `../bands.ts::pushSegment`, s. dessen Kommentar
 * zur Aussenseiten-Konvention via `leftNormal`), "innen" an der negativen. Das
 * Ergebnis wird auf die halbe Wanddicke geklemmt — ein Schichteinzug darf den
 * Rahmen nie aus der Wand hinausschieben.
 */
function resolveFrameNormalRange(
  halfThickness: number,
  depth: number,
  insetFromFace: number,
  face: "aussen" | "innen",
): { nMin: number; nMax: number } {
  const sign = face === "innen" ? -1 : 1;
  const front = sign * (halfThickness - insetFromFace);
  const back = front - sign * depth;
  const a = clampRange(front, -halfThickness, halfThickness);
  const b = clampRange(back, -halfThickness, halfThickness);
  return { nMin: Math.min(a, b), nMax: Math.max(a, b) };
}

/**
 * Aufgelöste Rahmen-/Sprossen-Parameter EINER Öffnung (Tür oder Fenster) aus
 * ihrem `DoorType`/`WindowType` (via `getDoorType`/`getWindowType`). `null`,
 * wenn kein Typ auflösbar ist (`Opening.typeId` fehlt/verwaist) — DANN
 * emittieren weder {@link emitOpeningFrames} noch die Rahmen-/Sprossen-Logik in
 * {@link emitOpeningGlass} irgendetwas (Rückwärtskompatibilität: unveränderte
 * Alt-Darstellung, s. Moduldoc-Kommentar in `../../toWalls3d.ts`).
 */
interface OpeningFrameParams {
  /** Sichtbare Rahmen-/Flügelprofil-Breite in der Öffnungsebene (Meter). */
  frameWidth: number;
  /** Rahmen-Tiefe quer zur Wand (Meter, informativ — steckt bereits in nMin/nMax). */
  acrossWallDepth: number;
  /** Quer-Versatz-Intervall des Rahmenkörpers (s. {@link resolveFrameNormalRange}). */
  nMin: number;
  nMax: number;
  /** Oberlicht-Höhe (Meter); 0 = kein Oberlicht/Kämpfer. */
  transomHeight: number;
  /** Schwelle/Sohlbank zeichnen: Fenster immer, Tür nur mit `threshold`. */
  hasSill: boolean;
  /** Flügelzahl (vertikale Mittelpfosten = wingCount−1); Türen immer 1. */
  wingCount: number;
  /** Kämpfer-Zeilen (horizontale Teilung = mullionRows−1); Türen immer 1. */
  mullionRows: number;
  /** Sprossen-Spalten (vertikale Teilung = mullionCols−1); Türen immer 1. */
  mullionCols: number;
  /** Ob eine Glasscheibe gezeichnet wird (Fenster immer, Tür nur `leafStyle: "glas"`). */
  glazed: boolean;
  /**
   * Verglasungs-Scheibenzahl (1–3), render-wirksam (`glazingPanesOf`). Türen:
   * immer 1 (keine typisierte Mehrfachverglasung). Steuert die Anzahl dünner,
   * in Wandrichtung leicht versetzter Glasflächen in {@link glassPanesForOpening}.
   */
  glazingPanes: 1 | 2 | 3;
  /**
   * Verglasungs-Anteil des HAUPTFELDS (0..1, von OBEN gemessen): 1 = voll
   * verglast (Fenster, Ganzglastür), < 1 = nur der obere Anteil ist Glas, unten
   * bleibt ein blindes Feld (z. B. Tür mit Oberglas, `DoorType.glazingRatio`).
   * Fenster: immer 1.
   */
  glazedFraction: number;
  /**
   * Flügeleinteilung (`sashesOfWindowType`) — je ÖFFENBAREM Flügel wird im
   * 3D ein Flügelrahmen (Rahmen-Riegel innerhalb des Blendrahmens) erzeugt
   * (Schachtelung Blendrahmen → Flügelrahmen → Glas). Türen: leer.
   */
  sashes: SashDef[];
  /** Halbe Wanddicke (Meter) — Bezug der Wand-Aussenfläche (+n) für Bank/Zargen-Umgriff. */
  halfThickness: number;
  /**
   * Fensterbank (Sims) zeichnen: nur Fenster mit `sillBoard` ≠ "keine"/"innen"
   * (fehlt ⇒ zeichnen, wie in der 2D-Ansicht). Türen: nie.
   */
  drawSill: boolean;
  /**
   * Innen-Fensterbank zeichnen: nur Fenster mit `sillBoard` === "innen"/"beide".
   * Gegenstück zu {@link drawSill} auf der Wand-Innenfläche (kein Überstand/
   * keine Tropfkante — das ist eine reine Innenausbau-Ablage, keine
   * Witterungskante). Türen: nie.
   */
  drawInteriorSill: boolean;
  /**
   * Zargen-Umgriff (Bekleidung VOR beiden Wandflächen) zeichnen: nur Türen mit
   * `frameKind === "zarge"`. Blockrahmen bleibt bündig (false).
   */
  zargeCladding: boolean;
  /**
   * Echtes Schwellenprofil (dünne, farblich abgesetzte Leiste über die GANZE
   * Wanddicke am Fussboden, analog zur Fensterbank-Leiste) zeichnen: nur
   * Türen mit `threshold === true`. Zusätzlich zum bisherigen, strukturellen
   * Blendrahmen-Riegel ({@link hasSill}) — der bleibt unverändert (steuert
   * weiterhin, wo der Flügel-/Blatt-Bereich beginnt), das Profil kommt als
   * eigenständiges, sichtbar unterscheidbares Bauteil obendrauf, nicht als
   * dessen Ersatz. Fenster: nie (ihre Schwelle ist die `hasSill`-Sohlbank,
   * kein Bodenanschlag).
   */
  drawThresholdProfile: boolean;
}

function resolveOpeningFrame(project: Project, wall: Wall, op: Opening): OpeningFrameParams | null {
  const wallThickness = wallThicknessSafe(project, wall);
  const halfThickness = wallThickness / 2;
  if (op.kind === "door") {
    const dt = getDoorType(project, op);
    if (!dt) return null;
    const acrossWallDepth = resolveAcrossWallDepth(dt.frameDepth, wallThickness);
    const { nMin, nMax } = resolveFrameNormalRange(
      halfThickness,
      acrossWallDepth,
      dt.insetFromFace ?? 0,
      dt.insetFace ?? "aussen",
    );
    return {
      frameWidth: dt.frameWidth ?? DEFAULT_FRAME_WIDTH,
      acrossWallDepth,
      nMin,
      nMax,
      transomHeight: Math.max(0, dt.transomHeight ?? 0),
      hasSill: dt.threshold === true,
      // Zweiflüglige Tür ⇒ 2 Flügel = ein mittiger Anschlagpfosten (Stulp) im 3D.
      wingCount: Math.max(1, Math.round(dt.leafCount ?? 1)),
      mullionRows: 1,
      mullionCols: 1,
      glazed: dt.leafStyle === "glas",
      glazingPanes: 1,
      // Teilverglasung: glazingRatio (Glasanteil oben) bei Glasblatt; sonst voll.
      glazedFraction: Math.max(0.05, Math.min(1, dt.glazingRatio ?? 1)),
      sashes: [],
      halfThickness,
      drawSill: false,
      drawInteriorSill: false,
      // Zarge umgreift die Wand (Bekleidung auf beiden Flächen); Blockrahmen bleibt bündig.
      zargeCladding: (dt.frameKind ?? "zarge") === "zarge",
      drawThresholdProfile: dt.threshold === true,
    };
  }
  const wt = getWindowType(project, op);
  if (!wt) return null;
  const acrossWallDepth = resolveAcrossWallDepth(wt.frameDepth, wallThickness);
  const { nMin, nMax } = resolveFrameNormalRange(
    halfThickness,
    acrossWallDepth,
    wt.insetFromFace ?? 0,
    wt.insetFace ?? "aussen",
  );
  // Flügeltabelle: explizite `wt.sashes` gewinnen; sonst gleichmäßig aus dem
  // effektiven Flügelzahl-Wert (Instanz-Override `op.wingCount` vor Typ-Default).
  // wingCount wird DARAUS abgeleitet, damit Mittelpfosten (wingCount−1) und
  // Flügelrahmen (je Flügel) konsistent bleiben.
  let sashes = wt.sashes && wt.sashes.length > 0 ? wt.sashes : undefined;
  if (!sashes) {
    const n = Math.max(1, Math.round(op.wingCount ?? wt.wingCount ?? 1));
    const opening = wt.kind === "fest" ? "fest" : wt.kind;
    sashes = Array.from({ length: n }, (_, i) => ({
      kind: "fluegel" as const,
      autoWidth: true,
      opening,
      hingeSide: (i % 2 === 0 ? "left" : "right") as "left" | "right",
    }));
  }
  const wingCount = Math.max(1, sashes.filter((s) => s.kind === "fluegel").length);
  return {
    frameWidth: wt.frameWidth ?? DEFAULT_FRAME_WIDTH,
    acrossWallDepth,
    nMin,
    nMax,
    transomHeight: Math.max(0, wt.transomHeight ?? 0),
    hasSill: true,
    wingCount,
    mullionRows: Math.max(1, Math.round(wt.mullionRows ?? 1)),
    mullionCols: Math.max(1, Math.round(wt.mullionCols ?? 1)),
    glazed: true,
    glazingPanes: glazingPanesOf(wt),
    glazedFraction: 1,
    sashes,
    halfThickness,
    // Fensterbank zeichnen, ausser explizit "keine"/"innen" (fehlt ⇒ zeichnen).
    drawSill: wt.sillBoard !== "keine" && wt.sillBoard !== "innen",
    // Innen-Fensterbank nur bei explizit "innen"/"beide".
    drawInteriorSill: wt.sillBoard === "innen" || wt.sillBoard === "beide",
    zargeCladding: false,
    drawThresholdProfile: false,
  };
}

/**
 * Rahmen-/Sprossen-Riegel EINER Öffnung: Pfosten (links/rechts, volle
 * Öffnungshöhe), Sturz (oben), Schwelle (nur wenn `params.hasSill`), optional
 * ein Kämpfer-Riegel (Oberlicht-Trennung, `transomHeight>0`) sowie die
 * Flügel-Mittelpfosten (`wingCount−1`, vertikal) und Kämpfer-Zeilen
 * (`mullionRows−1`, horizontal) im Flügel-Bereich zwischen Schwelle/Sturz
 * bzw. Schwelle/Kämpfer. Alle Rahmen-Riegel in {@link FRAME_RGB}.
 *
 * DetailLevel-Staffelung (VW-Detailgrad „fein" als Referenz):
 *  • „grob"  — wird gar nicht aufgerufen (s. {@link emitOpeningFrames}).
 *  • „mittel"— Blendrahmen + Oberlicht-Kämpfer + Flügelrahmen (verschachtelt) +
 *    Fensterbank/Zargen-Umgriff, aber KEINE Sprossen und KEINE SIA-Symbole.
 *  • „fein"  — zusätzlich Flügel-Mittelpfosten + Kämpfer-Zeilen (Sprossen) und
 *    die SIA-Öffnungssymbole (`openingPlaneBox`) auf dem Glas.
 */
function frameMeshesForOpening(
  wall: Wall,
  iv: { from: number; to: number },
  vert: { zBottom: number; zTop: number },
  params: OpeningFrameParams,
  detail: DetailLevel = "fein",
): RMesh[] {
  const out: RMesh[] = [];
  const fine = detail === "fein";
  const medium = detail === "mittel";
  const sashesOn = fine || medium; // Flügelrahmen: mittel + fein
  const detailBodies = fine || medium; // Bank + Zargen-Umgriff: mittel + fein
  const fw = params.frameWidth;
  // Generischer Riegel mit frei wählbarem Quer-Band [nA,nB] und Farbe.
  const pushC = (
    from: number,
    to: number,
    zBottom: number,
    zTop: number,
    nA: number,
    nB: number,
    color: RRgb,
  ): void => {
    const mesh = openingAxisBox(wall, from, to, zBottom, zTop, nA, nB, color);
    if (mesh) out.push(mesh);
  };
  // Blendrahmen-Riegel (volles Rahmen-Quer-Band nMin..nMax, Rahmenfarbe).
  const push = (from: number, to: number, zBottom: number, zTop: number): void =>
    pushC(from, to, zBottom, zTop, params.nMin, params.nMax, FRAME_RGB);
  // Pfosten (Laibungsseiten), über die volle Öffnungshöhe durchlaufend.
  push(iv.from, iv.from + fw, vert.zBottom, vert.zTop);
  push(iv.to - fw, iv.to, vert.zBottom, vert.zTop);
  // Sturz (oberer Riegel).
  push(iv.from + fw, iv.to - fw, vert.zTop - fw, vert.zTop);
  // Schwelle: Fenster immer, Tür nur mit Bodenanschlag (threshold).
  if (params.hasSill) push(iv.from + fw, iv.to - fw, vert.zBottom, vert.zBottom + fw);
  // Echtes Schwellenprofil (Tür, `threshold`): eine dünne, farblich abgesetzte
  // Leiste ÜBER DIE GANZE WANDDICKE am Fussboden (nicht nur die Rahmentiefe
  // wie der Blendrahmen-Riegel oben) — analog zur Fensterbank-Leiste
  // (SILL_RGB statt FRAME_RGB), zeigt den realen Bodenanschlag (Stein/Metall-
  // Streifen) statt eines rahmenfarbenen Riegels. Zusätzlich zum bestehenden
  // Riegel, nicht dessen Ersatz (der bleibt für die Flügel-/Blatt-Z-Basis unten).
  if (detailBodies && params.drawThresholdProfile) {
    const stripH = 0.02; // Schwellen-Dicke
    pushC(
      iv.from + fw,
      iv.to - fw,
      vert.zBottom,
      vert.zBottom + stripH,
      -params.halfThickness,
      params.halfThickness,
      SILL_RGB,
    );
  }

  // Flügel-/Sash-Bereich zwischen Schwelle und Sturz, ggf. durch den Kämpfer
  // (Oberlicht-Trennung) oben beschnitten.
  const sashFrom = iv.from + fw;
  const sashTo = iv.to - fw;
  const sashBottom = vert.zBottom + (params.hasSill ? fw : 0);
  let sashTop = vert.zTop - fw;
  if (params.transomHeight > EPS) {
    const splitZ = clampRange(vert.zTop - params.transomHeight, sashBottom, sashTop);
    push(sashFrom, sashTo, splitZ - fw / 2, splitZ + fw / 2); // Kämpfer-Riegel
    sashTop = splitZ - fw / 2;
  }
  // Flügel-Mittelpfosten + Kämpfer-Zeilen (Sprossen) nur bei FEINEM Detailgrad —
  // bei „mittel" bleibt es beim reinen Rahmen (+ Oberlicht-Kämpfer oben).
  if (fine) {
    // Flügel-Mittelpfosten (vertikal, wingCount−1) im Sash-Bereich.
    if (params.wingCount > 1 && sashTo - sashFrom > EPS) {
      const cell = (sashTo - sashFrom) / params.wingCount;
      for (let i = 1; i < params.wingCount; i++) {
        const center = sashFrom + i * cell;
        push(center - fw / 2, center + fw / 2, sashBottom, sashTop);
      }
    }
    // Kämpfer-Zeilen (horizontal, mullionRows−1) im Sash-Bereich.
    if (params.mullionRows > 1 && sashTop - sashBottom > EPS) {
      const cell = (sashTop - sashBottom) / params.mullionRows;
      for (let i = 1; i < params.mullionRows; i++) {
        const center = sashBottom + i * cell;
        push(sashFrom, sashTo, center - fw / 2, center + fw / 2);
      }
    }

    // Sprossen-Spalten (vertikal, mullionCols−1) im Sash-Bereich.
    if (params.mullionCols > 1 && sashTo - sashFrom > EPS) {
      const cell = (sashTo - sashFrom) / params.mullionCols;
      for (let i = 1; i < params.mullionCols; i++) {
        const center = sashFrom + i * cell;
        push(center - fw / 2, center + fw / 2, sashBottom, sashTop);
      }
    }
  }
  // Flügelrahmen je ÖFFENBAREM Flügel: ein eigener Rahmen-Riegel-Ring (links/
  // rechts/oben/unten), der DIREKT am Blendrahmen ansetzt (kein Spalt — sonst
  // schiene die Vollfeld-Glasscheibe als Streifen zwischen Blend- und Flügel-
  // rahmen durch). Die Schachtelung Blendrahmen → Flügelrahmen → Glas liest sich
  // über die Tiefe: der Flügelrahmen sitzt in einem EIGENEN, leicht ZURÜCK-
  // GESETZTEN und flacheren Quer-Band (`sashBackN..sashFrontN`) hinter der
  // Blendrahmen-Vorderkante — eine plastische Stufe nach innen (VW „fein"),
  // ohne vor die Fassade auszukragen. Zusätzlich (nur „fein") die SIA-Öffnungs-
  // symbole auf dem Glas. Feste Flügel bekommen weder Flügelrahmen noch Symbol.
  if (sashesOn && params.sashes.length > 0 && sashTo - sashFrom > EPS && sashTop - sashBottom > EPS) {
    const segs = resolveSashSpans(params.sashes, sashFrom, sashTo);
    const sfw = fw * 0.7;
    // Verschachteltes Flügelrahmen-Band: ~5 mm HINTER der Blendrahmen-Vorderkante
    // (nMax = Aussenseite) und nur ~50 mm tief — abgesetzte Stufe nach innen,
    // die Glas-Vorderkante (nMax − 0.02, Falzmass) liegt INNERHALB dieses Bands.
    const sashFrontN = params.nMax - 0.005;
    const sashBackN = Math.max(params.nMin, params.nMax - 0.055);
    // Glas-Vorderkante (s. glassPanesForOpening: n1 = nMax − 0.02); die Symbole
    // liegen als ~2.5 mm dünne dunkle Prismen KNAPP davor (weiter aussen).
    const glassFrontN = params.nMax - 0.02;
    const symBackN = glassFrontN;
    const symFrontN = glassFrontN + 0.003;
    const pushSash = (from: number, to: number, zB: number, zT: number): void =>
      pushC(from, to, zB, zT, sashBackN, sashFrontN, FRAME_RGB);
    const pushSymbol = (u0: number, h0: number, u1: number, h1: number): void => {
      const mesh = openingPlaneBox(wall, u0, h0, u1, h1, SYMBOL_HALF_WIDTH, symFrontN, symBackN, SYMBOL_RGB);
      if (mesh) out.push(mesh);
    };
    for (const seg of segs) {
      const s = seg.sash;
      if (s.kind !== "fluegel" || !s.opening || s.opening === "fest") continue;
      // Bündig am Blendrahmen/Segmentrand ansetzen — die Stufe kommt aus der
      // Tiefe (sashBackN..sashFrontN), nicht aus einem sichtbaren Glas-Spalt.
      const cf = seg.from;
      const ct = seg.to;
      const bz = sashBottom;
      const tz = sashTop;
      if (ct - cf <= EPS || tz - bz <= EPS) continue;
      pushSash(cf, cf + sfw, bz, tz); // linker Flügelholm
      pushSash(ct - sfw, ct, bz, tz); // rechter Flügelholm
      pushSash(cf, ct, tz - sfw, tz); // oberer Flügelriegel
      pushSash(cf, ct, bz, bz + sfw); // unterer Flügelriegel
      // SIA-Öffnungssymbole (nur „fein") auf dem Glasfeld INNERHALB des Flügel-
      // rahmens — exakt wie in der 2D-Ansicht (s. toElevation): Dreh = V mit
      // Spitze am Bandseiten-Mittel des Glasfelds, Kipp = V mit Spitze oben Mitte.
      if (!fine) continue;
      const gA = cf + sfw;
      const gB = ct - sfw;
      const gbz = bz + sfw;
      const gtz = tz - sfw;
      if (gB - gA <= EPS || gtz - gbz <= EPS) continue;
      const kind = s.opening;
      if (kind === "dreh" || kind === "drehkipp") {
        const hingeLeft = (s.hingeSide ?? "left") === "left";
        const apexU = hingeLeft ? gA : gB;
        const apexH = (gbz + gtz) / 2;
        const farU = hingeLeft ? gB : gA;
        pushSymbol(farU, gbz, apexU, apexH);
        pushSymbol(farU, gtz, apexU, apexH);
      }
      if (kind === "kipp" || kind === "drehkipp") {
        const apexU = (gA + gB) / 2;
        pushSymbol(gA, gbz, apexU, gtz);
        pushSymbol(gB, gbz, apexU, gtz);
      }
      if (kind === "schiebe") {
        // Schiebe: horizontaler Pfeil in Laufrichtung (Griff links ⇒ nach rechts).
        const zc = (gbz + gtz) / 2;
        const toRight = (s.hingeSide ?? "left") === "left";
        const tail = toRight ? gA : gB;
        const head = toRight ? gB : gA;
        const barb = (head - tail) * 0.22;
        pushSymbol(tail, zc, head, zc); // Schaft
        pushSymbol(head - barb, gbz + (gtz - gbz) * 0.32, head, zc); // obere Spitze
        pushSymbol(head - barb, gbz + (gtz - gbz) * 0.68, head, zc); // untere Spitze
      }
    }
  }

  // Fensterbank (Sims, VW „fein"/„mittel"): Bank-Quader unter der Öffnung,
  // seitlich ~3 cm überstehend, nach aussen (Wand-Aussenfläche +halfThickness)
  // auskragend, mit einer zweiten, dünneren Tropfkanten-Stufe an der Aussenkante
  // darunter. Nur Fenster mit `params.drawSill` (sillBoard ≠ "keine"/"innen").
  if (detailBodies && params.drawSill) {
    const ov = 0.03; // seitlicher Überstand je Seite
    const proj = 0.04; // Auskragung nach aussen (vor die Wandfläche)
    const under = 0.02; // Einbindung unter den Rahmen (in den Reveal)
    const bankH = 0.04; // Bankdicke
    const dripH = 0.02; // Höhe der Tropfkanten-Stufe
    const dripW = 0.02; // Tiefe der Tropfkante an der Aussenkante
    const outerN = params.halfThickness; // Wand-Aussenfläche
    const bankTop = vert.zBottom;
    const bankBottom = bankTop - bankH;
    // Bank
    pushC(iv.from - ov, iv.to + ov, bankBottom, bankTop, outerN - under, outerN + proj, SILL_RGB);
    // Tropfkante (dünnere Stufe darunter, an der Aussenkante)
    pushC(iv.from - ov, iv.to + ov, bankBottom - dripH, bankBottom, outerN + proj - dripW, outerN + proj, SILL_RGB);
  }

  // Innen-Fensterbank (Ablage, VW „fein"/„mittel"): wie die Aussenbank
  // gespiegelt auf die Wand-INNENfläche, aber ohne Tropfkante (reine
  // Innenausbau-Ablage, keine Witterungskante) — `params.drawInteriorSill`
  // (sillBoard "innen"/"beide").
  if (detailBodies && params.drawInteriorSill) {
    const ov = 0.03;
    const proj = 0.04;
    const under = 0.02;
    const bankH = 0.04;
    const innerN = -params.halfThickness; // Wand-Innenfläche
    const bankTop = vert.zBottom;
    const bankBottom = bankTop - bankH;
    pushC(iv.from - ov, iv.to + ov, bankBottom, bankTop, innerN - proj, innerN + under, SILL_RGB);
  }

  // Tür-Zarge mit Umgriff (VW): die Zarge umgreift die Wand — eine schmale
  // Bekleidungs-Platte VOR beiden Wandflächen, als Ring (Pfosten links/rechts +
  // Sturz) rund um die Öffnung, ~1.3 cm vor die Fläche vorstehend. Nur
  // `frameKind === "zarge"`; Blockrahmen bleibt bündig (params.zargeCladding false).
  if (detailBodies && params.zargeCladding) {
    const proud = 0.013; // Vorstand vor die Wandfläche
    const ext = 0.02; // Überstand auf die Wandfläche (über die Laibungskante hinaus)
    const casW = fw; // Bekleidungsbreite (= Rahmenprofil)
    for (const sign of [1, -1] as const) {
      const faceN = sign * params.halfThickness;
      const nA = faceN;
      const nB = faceN + sign * proud;
      pushC(iv.from - ext, iv.from + casW, vert.zBottom, vert.zTop + ext, nA, nB, FRAME_RGB); // Pfosten links
      pushC(iv.to - casW, iv.to + ext, vert.zBottom, vert.zTop + ext, nA, nB, FRAME_RGB); // Pfosten rechts
      pushC(iv.from - ext, iv.to + ext, vert.zTop - casW, vert.zTop + ext, nA, nB, FRAME_RGB); // Sturz
    }
  }
  return out;
}

/**
 * Löst die Flügeleinteilung auf das konkrete Achsintervall `[from,to]` (Meter)
 * auf — feste Breiten (`kind:"pfosten"`/`autoWidth:false`) exakt, der Rest
 * gleichmäßig auf die Restbreite. Pendant zu `sashSegments` in `opening.ts`
 * (2D), aber direkt in Öffnungs-Achskoordinaten (3D).
 */
function resolveSashSpans(
  sashes: SashDef[],
  from: number,
  to: number,
): { sash: SashDef; from: number; to: number }[] {
  const width = Math.max(0, to - from);
  let fixedSum = 0;
  let autoCount = 0;
  for (const s of sashes) {
    if (s.kind === "pfosten") fixedSum += Math.max(0, s.postWidth ?? 0.06);
    else if (s.autoWidth === false) fixedSum += Math.max(0, s.width ?? 0);
    else autoCount++;
  }
  const autoW = autoCount > 0 ? Math.max(0, (width - fixedSum) / autoCount) : 0;
  const out: { sash: SashDef; from: number; to: number }[] = [];
  let cursor = from;
  for (const s of sashes) {
    const w =
      s.kind === "pfosten"
        ? Math.max(0, s.postWidth ?? 0.06)
        : s.autoWidth === false
          ? Math.max(0, s.width ?? 0)
          : autoW;
    out.push({ sash: s, from: cursor, to: cursor + w });
    cursor += w;
  }
  return out;
}

/** Luftraum zwischen zwei Scheiben einer Mehrfachverglasung (Meter, informativ). */
const GLASS_PANE_GAP = 0.006;

/**
 * Glasscheibe(n) EINER typisierten Öffnung (Fenster immer, Tür nur bei
 * `params.glazed`): je Z-Band (Hauptfeld zwischen Schwelle und Sturz bzw.
 * Kämpfer, plus — bei `transomHeight>0` — ein zweites Oberlicht-Band) werden
 * `params.glazingPanes` dünne, in Wandrichtung (quer zur Wand, n-Achse) leicht
 * versetzte Scheiben mit Luftraum dazwischen erzeugt (Isolierverglasung:
 * 1 = Einfach-, 2 = Zweifach-, 3 = Dreifachverglasung). Bei `glazingPanes: 1`
 * (Alt-Verhalten/Default) entsteht exakt EINE Scheibe an derselben Position wie
 * bisher. Die Sprossen/Mittelpfosten aus {@link frameMeshesForOpening} liegen
 * VOR diesen Scheiben (keine Pro-Feld-Aufteilung — bewusst einfach gehalten).
 */
function glassPanesForOpening(
  wall: Wall,
  iv: { from: number; to: number },
  vert: { zBottom: number; zTop: number },
  params: OpeningFrameParams,
): RMesh[] {
  const out: RMesh[] = [];
  const fw = params.frameWidth;
  const sashFrom = iv.from + fw;
  const sashTo = iv.to - fw;
  const sashBottom = vert.zBottom + (params.hasSill ? fw : 0);
  const sashTopFull = vert.zTop - fw;
  // Die Scheibe(n) sitzen als DÜNNE Tafeln NAHE der Aussenfläche (nMax = +n-
  // Seite, s. resolveFrameNormalRange) — mittig tief im Reveal wirkte das
  // schwach/kaum sichtbar. Direkt hinter der Aussenkante (Falzmass ~2 cm, s.
  // Fensterbau-Recherche) liest sich das Fenster klar, die Laibung/Reveal-
  // Tiefe zeigt nach innen. Bei mehreren Scheiben rücken die weiteren mit
  // `GLASS_PANE_GAP` Luftraum dazwischen weiter nach innen (Richtung `nMin`).
  const glassThick = GLASS_HALF_THICK * 2;
  const panes = Math.max(1, Math.min(3, Math.round(params.glazingPanes)));
  const push = (zBottom: number, zTop: number): void => {
    let n1 = params.nMax - 0.02;
    for (let p = 0; p < panes; p++) {
      const n0 = Math.max(params.nMin, n1 - glassThick);
      if (n1 - n0 <= EPS) break;
      const mesh = openingAxisBox(wall, sashFrom, sashTo, zBottom, zTop, n0, n1, GLASS_RGB);
      if (mesh) out.push(mesh);
      n1 = n0 - GLASS_PANE_GAP;
      if (n1 <= params.nMin) break;
    }
  };
  // Teilverglasung (Türen mit glazingRatio < 1): das HAUPTFELD ist nur im oberen
  // `glazedFraction`-Anteil Glas; darunter bleibt ein blindes Blattfeld. Von der
  // OBERKANTE des Hauptbands gemessen. Fenster: glazedFraction = 1 (voll).
  const frac = Math.max(0.05, Math.min(1, params.glazedFraction));
  const glazedBottom = (bBottom: number, bTop: number) =>
    bTop - frac * (bTop - bBottom);
  if (params.transomHeight > EPS) {
    const splitZ = clampRange(vert.zTop - params.transomHeight, sashBottom, sashTopFull);
    const mainTop = splitZ - fw / 2;
    if (params.glazed) push(glazedBottom(sashBottom, mainTop), mainTop); // Hauptglas (ggf. nur oben).
    push(splitZ + fw / 2, sashTopFull); // Oberlicht-Scheibe (immer voll, auch Vollblatt-Tür).
  } else if (params.glazed) {
    push(glazedBottom(sashBottom, sashTopFull), sashTopFull);
  }
  return out;
}

/**
 * Türblatt EINER typisierten Tür als solide Blatt-Tafel im Hauptfeld (zwischen
 * den Rahmen-Pfosten, über Schwelle bis Sturz bzw. Kämpfer): Vollblatt
 * (`leafStyle` ≠ "glas") füllt das ganze Feld, Teilverglasung
 * (`glazingRatio` < 1) nur den blinden UNTEREN Rest unter dem Glasanteil
 * (Anteil von OBEN gemessen, s. {@link glassPanesForOpening}). Das Blatt liegt
 * mittig um die Glasebene (nMax − 0.03), ~4 cm dick ({@link DOOR_LEAF_THICK}),
 * in {@link DOOR_LEAF_RGB} — damit Türen im 3D als Türen lesbar sind statt als
 * offene Löcher mit Rahmen. Fenster: nie (glazedFraction = 1 ⇒ kein Blatt).
 */
function doorLeafPanels(
  wall: Wall,
  iv: { from: number; to: number },
  vert: { zBottom: number; zTop: number },
  params: OpeningFrameParams,
): RMesh[] {
  const out: RMesh[] = [];
  const fw = params.frameWidth;
  const leafFrom = iv.from + fw;
  const leafTo = iv.to - fw;
  const leafBottom = vert.zBottom + (params.hasSill ? fw : 0);
  let fieldTop = vert.zTop - fw;
  if (params.transomHeight > EPS) {
    const splitZ = clampRange(vert.zTop - params.transomHeight, leafBottom, fieldTop);
    fieldTop = splitZ - fw / 2; // Hauptfeld endet am Kämpfer, Oberlicht bleibt Glas.
  }
  // Blinder Blattanteil: alles unterhalb des (von oben gemessenen) Glasanteils.
  const frac = params.glazed ? Math.max(0.05, Math.min(1, params.glazedFraction)) : 0;
  const leafTop = fieldTop - frac * (fieldTop - leafBottom);
  if (leafTop - leafBottom <= EPS || leafTo - leafFrom <= EPS) return out;
  const n1 = params.nMax - 0.02 + DOOR_LEAF_THICK / 2;
  const n0 = Math.max(params.nMin, n1 - DOOR_LEAF_THICK);
  const mesh = openingAxisBox(wall, leafFrom, leafTo, leafBottom, leafTop, n0, n1, DOOR_LEAF_RGB);
  if (mesh) out.push(mesh);
  return out;
}

/**
 * Emittiert je Fensteröffnung eine Glasscheibe und je Türöffnung die Füllung
 * (Blatt-Tafel, s. {@link doorLeafPanels}, plus Scheibe bei Glasanteil/
 * Oberlicht) als rohe Quader-Meshes — damit Fenster/Türen im 3D lesbar sind
 * statt als blosse Löcher in der Wand.
 *
 * OHNE auflösbaren Typ (`getWindowType`/`getDoorType` liefert `undefined`,
 * z. B. `Opening.typeId` fehlt): unverändertes ALT-Verhalten — EINE Vollscheibe
 * über die geklemmte Öffnungs-Achse (`openingInterval`) und -Höhe
 * (`openingVerticalExtent`), quer ±{@link GLASS_HALF_THICK} mittig in der
 * Wand (Rückwärtskompatibilität, s. Moduldoc-Kommentar).
 *
 * MIT Typ: die Scheibe(n) sitzen im Flügel-Bereich INNERHALB des Rahmens (s.
 * {@link glassPanesForOpening}), quer entlang des über den Schichteinzug
 * bestimmten Rahmen-Versatzes (s. {@link resolveFrameNormalRange}) statt fix
 * mittig — bei Oberlicht (`transomHeight>0`) kommt eine zweite Scheibe im
 * Oberlicht-Band dazu. Die zugehörigen Rahmen-/Sprossen-Riegel emittiert
 * separat {@link emitOpeningFrames} (eigene Farbe, eigene Funktion — leichter
 * einzeln zu testen/filtern als eine gemeinsame Emission).
 *
 * `positions` liegen — wie bei den übrigen Meshes — in MODELL-Metern als
 * flaches (x, y, z=Höhe)-Array; render3d bildet sie selbst nach world
 * (x, Höhe, y) ab und rendert die Meshes doppelseitig (append_context_mesh),
 * daher ist die Winding-Reihenfolge der Dreiecke unerheblich. `kind: "imported"`
 * mit gesetzter `color` ⇒ render3d zeichnet die Scheibe in GLASS_RGB.
 */
export function emitOpeningGlass(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const wall of project.walls) {
    for (const op of openingsOfWall(project, wall.id)) {
      const iv = openingInterval(wall, op);
      if (!iv) continue;
      const vert = openingVerticalExtent(project, wall, op);
      if (vert.zTop - vert.zBottom <= EPS) continue;
      if (op.kind === "window") {
        const params = resolveOpeningFrame(project, wall, op);
        if (!params) {
          // Kein Typ auflösbar -> Alt-Verhalten (fixe Vollscheibe, mittig).
          const mesh = openingAxisBox(
            wall,
            iv.from,
            iv.to,
            vert.zBottom,
            vert.zTop,
            -GLASS_HALF_THICK,
            GLASS_HALF_THICK,
            GLASS_RGB,
          );
          if (mesh) out.push(mesh);
          continue;
        }
        out.push(...glassPanesForOpening(wall, iv, vert, params));
      } else {
        // Tür: Blatt-Tafel (Vollblatt bzw. blinder Rest unter der Teilverglasung)
        // + Scheibe(n) für Glasanteil/Oberlicht. Ohne auflösbaren Typ: nichts
        // (Alt-Verhalten: offenes Loch).
        const params = resolveOpeningFrame(project, wall, op);
        if (params) {
          out.push(...doorLeafPanels(wall, iv, vert, params));
          out.push(...glassPanesForOpening(wall, iv, vert, params));
        }
      }
    }
  }
  return out;
}

/**
 * Emittiert je LEGACY-Tür (`project.doors` — das alte flache Türfeld VOR dem
 * Öffnungs-Typsystem, z. B. `Door.hostWallId/position/width/height` ohne
 * `typeId`) EIN Blatt-Panel als rohen Quader. `emitWall` (`../bands.ts`)
 * schneidet für diese Türen zwar bereits ein Loch in die Wand, aber
 * `emitOpeningGlass`/`emitOpeningFrames` durchlaufen NUR `project.openings`
 * (das neue Typsystem) — ohne diese Funktion blieb eine Legacy-Tür ein
 * blankes Loch, durch das man hindurchsieht (Nutzer-Report: "Türen fehlen im
 * 3D komplett"). Analog zum Alt-Verhalten typloser Fenster
 * ({@link emitOpeningGlass}: EINE Vollscheibe ohne Rahmen) — hier EIN
 * Vollblatt ohne Rahmen/Zarge (das Rahmen-System gehört exklusiv zu
 * `project.openings`, s. {@link resolveOpeningFrame}). `positions` in
 * MODELL-Metern.
 */
export function emitLegacyDoorLeaves(project: Project): RMesh[] {
  const out: RMesh[] = [];
  for (const wall of project.walls) {
    const axisLen = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
    if (axisLen < 1e-9) continue;
    const { zBottom } = wallVerticalExtent(project, wall);
    for (const d of project.doors ?? []) {
      if (d.hostWallId !== wall.id) continue;
      const from = Math.max(0, Math.min(d.position, axisLen));
      const to = Math.max(from, Math.min(d.position + d.width, axisLen));
      if (to - from <= EPS) continue;
      const zTop = zBottom + d.height;
      if (zTop - zBottom <= EPS) continue;
      const mesh = openingAxisBox(
        wall,
        from,
        to,
        zBottom,
        zTop,
        -DOOR_LEAF_THICK / 2,
        DOOR_LEAF_THICK / 2,
        DOOR_LEAF_RGB,
      );
      if (mesh) out.push(mesh);
    }
  }
  return out;
}

/**
 * Emittiert je Öffnung MIT auflösbarem Typ (`getDoorType`/`getWindowType`) die
 * Rahmen-/Sprossen-Riegel (Zarge/Blendrahmen, Sturz, Schwelle, Kämpfer,
 * Mittelpfosten — s. {@link frameMeshesForOpening}) als rohe Quader-Meshes in
 * {@link FRAME_RGB}. Öffnungen OHNE auflösbaren Typ (`typeId` fehlt/verwaist)
 * bekommen KEINEN Rahmen — exakt das Alt-Verhalten vor der Typ-Vertiefung
 * (Rückwärtskompatibilität).
 */
export function emitOpeningFrames(project: Project, detail: DetailLevel = "fein"): RMesh[] {
  // Grob: keine Rahmen/Sprossen — die Öffnung bleibt Loch + Scheibe (schlank).
  if (detail === "grob") return [];
  const out: RMesh[] = [];
  for (const wall of project.walls) {
    for (const op of openingsOfWall(project, wall.id)) {
      const iv = openingInterval(wall, op);
      if (!iv) continue;
      const vert = openingVerticalExtent(project, wall, op);
      if (vert.zTop - vert.zBottom <= EPS) continue;
      const params = resolveOpeningFrame(project, wall, op);
      if (!params) continue;
      out.push(...frameMeshesForOpening(wall, iv, vert, params, detail));
    }
  }
  return out;
}

/**
 * Rollladen-/Sonnenschutzkasten als 3D-Box über der Öffnung (nur Fenster mit
 * `WindowType.shading.create`, nur mittel/fein). Ein heller Quader, aussen an
 * der Aussenfläche (params.nMax) ansetzend und um `box.depth` nach aussen
 * ragend, von der Öffnungs-OK um `box.height` nach oben. Breite = `box.width`
 * (0/fehlt ⇒ Öffnungsbreite), mittig über der Öffnung. Pendant zur 2D-Kontur
 * (`window-shading` in generatePlan/openings.ts).
 */
export function emitOpeningShading(project: Project, detail: DetailLevel = "fein"): RMesh[] {
  if (detail === "grob") return [];
  const out: RMesh[] = [];
  for (const wall of project.walls) {
    for (const op of openingsOfWall(project, wall.id)) {
      if (op.kind !== "window") continue;
      const wt = getWindowType(project, op);
      if (!wt?.shading?.create) continue;
      const iv = openingInterval(wall, op);
      if (!iv) continue;
      const vert = openingVerticalExtent(project, wall, op);
      if (vert.zTop - vert.zBottom <= EPS) continue;
      const params = resolveOpeningFrame(project, wall, op);
      if (!params) continue;
      const box = wt.shading.box;
      const h = Math.max(0, box.height);
      const d = Math.max(0, box.depth);
      if (h <= EPS || d <= EPS) continue;
      const span = box.width > 0 ? box.width : iv.to - iv.from;
      const center = (iv.from + iv.to) / 2;
      const from = center - span / 2;
      const to = center + span / 2;
      // Aussen an der Aussenfläche (nMax) ansetzen und um die Kastentiefe hinaus.
      const nOuter = params.nMax;
      const mesh = openingAxisBox(
        wall,
        from,
        to,
        vert.zTop,
        vert.zTop + h,
        nOuter,
        nOuter + d,
        SHADING_RGB,
      );
      if (mesh) out.push(mesh);
    }
  }
  return out;
}

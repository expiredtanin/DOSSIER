// Wand-Verschneidung (Gehrung): an einer Ecke, wo zwei Wände aufeinander­
// treffen, sollen sich die Schicht-Bänder nicht überlappen, sondern an einer
// gemeinsamen Gehrungslinie sauber stoßen. Pro Wand entstehen die optionalen
// Schnittlinien an Start- und Endpunkt.
//
// Gerechnet wird im Rust-Kern (`src-tauri/core/src/joins.rs`); hier bleiben die
// Typen, das Sammeln der Wand-Angaben aus dem `Project` und die flache Übergabe.

import type { Component, Project, Wall } from "./types";
import { getComponent, getWallType } from "./types";
import type { Line } from "./geometry";
import { core } from "../engine/coreWasm";
import { FlatReader, FlatWriter } from "../geometry/coreFlat";

/**
 * Pro-Schicht-Override der Nahflächen-Cuts (materialbewusster T-Stoss, siehe
 * {@link resolveJoinPriority}). Index = Schicht-Index im Wandtyp DIESER Wand
 * (der Abzweig-Wand). `start`/`end` ersetzen — wo gesetzt — den einheitlichen
 * `startCut`/`endCut` NUR für die jeweilige Schicht; `null` an einem Index
 * heisst: diese Schicht bekommt KEINEN Cut (verschmilzt, läuft durch).
 * `startSide`/`endSide` tragen die zusätzliche seitliche Cut-Linie einer
 * getrimmten Schicht, die an eine verschmelzende Nachbarschicht angrenzt
 * (L-Anschluss, z. B. Putz neben durchlaufendem Backstein-Kern).
 */
export interface LayerCuts {
  start: (Line | null)[];
  end: (Line | null)[];
  startSide: (Line | null)[];
  endSide: (Line | null)[];
}

/**
 * Aussparung der DURCHGANGSWAND an einem materialbewussten T-Stoss: über das
 * Achsen-Intervall `[from,to]` (Meter ab `wall.start` entlang der Achse) und den
 * Quer-Offsetbereich `[offA,offB]` wird die Nah-Putz-Zone der Durchgangswand
 * echt ausgeschnitten, damit der durchstechende Abzweig-Kern (Phase 1b) die
 * Durchgangswand nicht nur übermalt, sondern geometrisch aufbricht.
 *
 * OFFSET-KONVENTION (identisch zu den Schicht-Bändern in `addWallPoche`):
 * `offA`/`offB` sind Querabstände von der Wandachse ENTLANG der linken Normalen
 * `leftNormal(dir)`, inkl. Referenzversatz — also im selben Bereich wie
 * `refOff − total/2` (außen) … `refOff + total/2` (innen). `offA` ist stets die
 * NAHFLÄCHE (Wandoberfläche, `refOff + sign·total/2`), `offB` die dem Abzweig
 * zugewandte Fläche des Rückgrat-KERNS (`refOff + sign·(total/2 − nearPlaster)`)
 * — die Zone dazwischen ist exakt der Nah-Putz, den der Abzweig-Kern durchstösst.
 * `from ≤ to` ist die Projektion der Abzweig-Kernbreite auf die Durchgangsachse.
 */
export interface SpanCutout {
  from: number;
  to: number;
  offA: number;
  offB: number;
}

/** Schnittlinien einer Wand an ihren beiden Achsenden. */
export interface WallCuts {
  startCut: Line | null;
  endCut: Line | null;
  /**
   * Additive Erweiterung: fehlt dieses Feld, gilt weiterhin `startCut`/
   * `endCut` für ALLE Schichten (bisheriges Verhalten, bit-identisch). Wird
   * nur gesetzt, wenn an einem T-Stoss mindestens eine Schicht materialbewusst
   * verschmilzt (siehe {@link resolveJoinPriority}).
   */
  layerCuts?: LayerCuts;
  /**
   * Additive Erweiterung (Durchgangswand-Seite): Aussparungen der Nah-Putz-Zone,
   * durch die ein Abzweig-Kern sticht. Fehlt/leer ⇒ die Wand wird unverändert
   * gezeichnet. Wird nur an der DURCHGANGSWAND gesetzt (nie am Abzweig), analog
   * additiv zu {@link layerCuts}. Siehe {@link SpanCutout}.
   */
  spanCutouts?: SpanCutout[];
}

/**
 * Verschneidungs-Entscheidung zweier Bauteile (Komponenten) am Stoss:
 *  • "merge"   — gleiche Priorität UND gleiche Komponente (z. B. Backstein-
 *    Kern trifft Backstein-Kern): die Schichten verschmelzen, kein Cut.
 *  • "coexist" — gleiche Priorität, aber VERSCHIEDENE Komponente: keine
 *    eindeutige Rangfolge, bleibt beim heutigen (getrimmten) Verhalten.
 *  • "trim-a"  — `b` hat die höhere Priorität und gewinnt; `a` wird getrimmt.
 *  • "trim-b"  — `a` hat die höhere Priorität und gewinnt; `b` wird getrimmt.
 */
export type JoinPriorityResolution = "merge" | "trim-a" | "trim-b" | "coexist";

const RESOLUTIONS: JoinPriorityResolution[] = ["merge", "trim-a", "trim-b", "coexist"];

export function resolveJoinPriority(
  a: Component,
  b: Component,
): JoinPriorityResolution {
  return RESOLUTIONS[core().join_priority_resolution(a.joinPriority, b.joinPriority, a.id === b.id)] ?? "coexist";
}

/**
 * Berechnet für jede Wand die Gehrungs-/Anschluss-Schnittlinien.
 * Behandelt werden: L-Ecken (genau zwei Wandenden treffen sich), T-Knoten
 * (drei Wandenden treffen sich, zwei davon kollinear), Mittelspannen-T-Stöße
 * (ein freies Wandende trifft auf die Seite einer anderen Wand) UND „+"-
 * Kreuzungen (zwei kollineare Wandenden treffen sich exakt auf der Achse einer
 * dritten, durchlaufenden Wand). Echte Stern-Knoten (vier oder mehr Wand-
 * STUMMEL am selben Punkt, keiner als Durchgang erkennbar) bleiben rechtwinklig.
 * An T-Stössen kommen die materialbewussten Pro-Schicht-Cuts (`layerCuts`) und
 * die Nah-Putz-Aussparungen der Durchgangswand (`spanCutouts`) dazu.
 *
 * `walls` ist die bereits gefilterte Wandmenge (z. B. ein Geschoss); die
 * Gehrung wird nur innerhalb dieser Menge gebildet. Wirft wie früher, wenn ein
 * benötigter Wandtyp oder ein Bauteil unbekannt ist.
 */
export function computeJoins(
  project: Project,
  walls: Wall[],
): Map<string, WallCuts> {
  const w = new FlatWriter().num(walls.length);
  const compIndex = new Map<string, number>();
  for (const wall of walls) {
    w.num(wall.start.x, wall.start.y, wall.end.x, wall.end.y);
    if (wall.referenceOffset != null) w.num(3, wall.referenceOffset);
    else w.num(wall.referenceLine === "left" ? 1 : wall.referenceLine === "right" ? 2 : 0, 0);
    const wt = project.wallTypes.find((t) => t.id === wall.wallTypeId);
    if (!wt) {
      w.num(0, 0);
      continue;
    }
    w.num(1, wt.layers.length);
    for (const l of wt.layers) {
      const comp = project.components.find((c) => c.id === l.componentId);
      let idx = -1;
      if (comp) {
        idx = compIndex.get(comp.id) ?? compIndex.size;
        compIndex.set(comp.id, idx);
      }
      w.num(l.thickness, idx, comp ? comp.joinPriority : Number.NaN);
    }
  }
  const out = core().compute_joins_flat(w.done());
  const r = new FlatReader(out);
  const status = r.num();
  if (status === 1) {
    // Wandtyp oder Bauteil unbekannt: denselben Fehler werfen wie die Modell-Helfer.
    const bad = walls[r.num()];
    if (bad) for (const l of getWallType(project, bad).layers) getComponent(project, l.componentId);
    throw new Error("computeJoins: unbekannter Wandtyp oder Bauteil");
  }
  const result = new Map<string, WallCuts>();
  if (status !== 0) {
    // Kaputte Eingabe (z. B. NaN-Koordinaten): keine Verschneidung.
    for (const wall of walls) result.set(wall.id, { startCut: null, endCut: null });
    return result;
  }
  for (const wall of walls) result.set(wall.id, readWallCuts(r));
  return result;
}

// ── Flache Kodierung der Cuts (s. `joins.rs`), auch für `toWalls3d/bands.ts` ──

function writeLine(w: FlatWriter, l: Line | null | undefined): void {
  if (l) w.num(1, l.point.x, l.point.y, l.dir.x, l.dir.y);
  else w.num(0, 0, 0, 0, 0);
}

function readLine(r: FlatReader): Line | null {
  const set = r.num();
  const point = { x: r.num(), y: r.num() };
  const dir = { x: r.num(), y: r.num() };
  return set === 1 ? { point, dir } : null;
}

/** Hängt die Cuts einer Wand flach an (fehlend = keine Cuts). */
export function writeWallCuts(w: FlatWriter, cuts: WallCuts | undefined): void {
  writeLine(w, cuts?.startCut);
  writeLine(w, cuts?.endCut);
  const lc = cuts?.layerCuts;
  const n = lc ? lc.start.length : 0;
  w.num(n);
  if (lc) for (const arr of [lc.start, lc.end, lc.startSide, lc.endSide]) for (let i = 0; i < n; i++) writeLine(w, arr[i]);
  const sc = cuts?.spanCutouts ?? [];
  w.num(sc.length);
  for (const s of sc) w.num(s.from, s.to, s.offA, s.offB);
}

/** Liest die Cuts einer Wand; `layerCuts`/`spanCutouts` nur, wenn vorhanden. */
export function readWallCuts(r: FlatReader): WallCuts {
  const cuts: WallCuts = { startCut: readLine(r), endCut: readLine(r) };
  const n = r.count();
  if (n > 0) {
    const arr = () => Array.from({ length: n }, () => readLine(r));
    cuts.layerCuts = { start: arr(), end: arr(), startSide: arr(), endSide: arr() };
  }
  const m = r.count();
  if (m > 0) {
    cuts.spanCutouts = [];
    for (let k = 0; k < m; k++) cuts.spanCutouts.push({ from: r.num(), to: r.num(), offA: r.num(), offB: r.num() });
  }
  return cuts;
}

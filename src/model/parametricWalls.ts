// Parametrische Wand-Engine — löst ParametricWall-Regelwerke zu Wall[]-Arrays auf.
//
// Die Rechnung liegt im Rust-Kern ([K4] S3, `src-tauri/core/src/parametric_walls.rs`); dieses Modul ist
// die dünne Fassade mit den bisherigen Signaturen und frei von React-, Store- und App.tsx-Importen.
// Eingabe ist ein ParametricWall-Regelwerk + Kontext (Geschoss, Grid-Achsen, bestehende Wände), Ausgabe
// sind neue Wall[]-Objekte, die direkt in project.walls eingefügt werden können. Der Zähler der erzeugten
// Wand-ids (`pw-<Geschoss>-<Art>-<n>`, sessionlokal, nicht persistent) ist der einzige Zustand und liegt hier.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type {
  ConditionalThicknessRule,
  DrawingLevel,
  GridRule,
  ModuleRule,
  ParametricRule,
  ParametricWall,
  ReferenceLineRule,
  SequenceRule,
  Vec2,
  Wall,
  WallType,
} from "./types";
import { core } from "../engine/coreWasm";

// ── Kontext-Typen ─────────────────────────────────────────────────────────

/**
 * Kontext, der dem Engine beim Auflösen übergeben wird.
 * Enthält alle Informationen, die für die Generierung von Wänden benötigt werden.
 */
export interface ParametricContext {
  /** Das Ziel-Geschoss. */
  floor: DrawingLevel;
  /**
   * Optionale Rasterachsen (Phase 3: verlinkter Grid-Ressource). Fehlen sie,
   * berechnet die Engine die Achsen aus `GridRule.spacing`.
   */
  gridAxes?: { x: number[]; y: number[] };
  /**
   * Optionales Clipping-Polygon (Meter). Fehlt es, reicht das Raster über
   * einen Standardbereich (0…spacing*count).
   */
  boundaryGeometry?: { boundary: Vec2[] };
  /**
   * Bereits im Projekt vorhandene Wände des Geschosses. Werden von
   * refinierenden Regeln (ConditionalThicknessRule, ReferenceLineRule) genutzt.
   * Optional — fehlt er, wird mit leerem Array gearbeitet.
   */
  existingWalls?: Wall[];
}

/** Interner Arbeitskontext, der durch den Rule-Dispatcher weitergereicht wird. */
interface RuleCtx {
  floorId: string;
  defaultWallType: WallType;
  context: ParametricContext;
  /** Wände, die bisher durch frühere Regeln erzeugt wurden. */
  existingWalls: Wall[];
}

// ── Kern-Aufruf ───────────────────────────────────────────────────────────

/** Laufende Nummer der erzeugten Wand-ids (sessionlokal, nicht persistent). */
let idCounter = 0;

function call<T>(name: string, arg: unknown): T {
  const out = core().parametric_call(name, JSON.stringify(arg));
  if (out === "") throw new Error(`Kern: Parametrik-Rechnung „${name}" fehlgeschlagen`);
  return JSON.parse(out) as T;
}

/** Rechnung mit Wand-Ergebnis: schreibt den Zähler der ids fort. */
function walls(name: string, arg: Record<string, unknown>): Wall[] {
  const r = call<{ walls: Wall[]; counter: number }>(name, { ...arg, counter: idCounter });
  idCounter = r.counter;
  return r.walls;
}

// ── Öffentliche API ───────────────────────────────────────────────────────

/**
 * Löst ein ParametricWall-Regelwerk zu einem Wall[]-Array für ein gegebenes
 * Geschoss auf.
 *
 * Ablauf:
 *   1. Regelwerk sequenziell ausführen; jede Regel erhält die Ausgabe der
 *      vorherigen als `existingWalls` (ermöglicht Verfeinerung).
 *   2. Duplikate (gleicher Start-/Endpunkt innerhalb `tolerance`) entfernen.
 *   3. Bereinigte Wall[]-Liste zurückgeben.
 *
 * Die Ausgabe ist sofort bereit zur Einfügung in `project.walls`. Es werden
 * keine Seiteneffekte erzeugt — kein Store, kein Dispatch, kein React.
 *
 * @param parametricWall - Das Regelwerk (aus Project.parametricWalls[]).
 * @param floorId        - ID des Ziel-Geschosses.
 * @param context        - Kontext (Geschoss-Objekt, Grid-Achsen, Grenzen, …).
 * @param defaultWallType - Fallback-Wandtyp, wenn eine Regel keinen nennt.
 * @param tolerance       - Näherungstoleranz für Duplikat-Erkennung (Meter, Default 0.01).
 * @returns Wall[]-Array, bereit zur Einfügung.
 */
export function resolveParametricWall(
  parametricWall: ParametricWall,
  floorId: string,
  context: ParametricContext,
  defaultWallType: WallType,
  tolerance = 0.01,
): Wall[] {
  return walls("resolve", { parametricWall, floorId, context, defaultWallType, tolerance });
}

/**
 * Dispatcher: delegiert eine Regel an die passende Implementierung (Raster, Modul, bedingte Dicke,
 * Referenzlinie, Sequenz); unbekannte Typen geben leer zurück.
 *
 * @param rule - Die auszuführende Regel.
 * @param ctx  - Interner Arbeitskontext.
 * @returns Wall[]-Array, das diese Regel erzeugt oder verändert hat.
 */
export function applyRule(rule: ParametricRule, ctx: RuleCtx): Wall[] {
  return walls("applyRule", { rule, ctx });
}

/** Raster-Regel: Wände entlang gleichmäßiger X-/Y-Achsen (Rasterachsen aus `gridAxes` oder `spacing`). */
export const applyGridRule = (rule: GridRule, ctx: RuleCtx): Wall[] => applyRule(rule, ctx);

/** Modul-Regel: Querwände an den Teilungspunkten einer Referenzspanne (Geschoss-Ausdehnung oder Referenzwand). */
export const applyModuleRule = (rule: ModuleRule, ctx: RuleCtx): Wall[] => applyRule(rule, ctx);

/** Bedingte-Dicken-Regel: MODIFIZIERTE KOPIEN passender Wände mit neuem `wallTypeId` (Originale bleiben). */
export const applyConditionalThicknessRule = (rule: ConditionalThicknessRule, ctx: RuleCtx): Wall[] => applyRule(rule, ctx);

/** Referenzlinien-Regel: MODIFIZIERTE KOPIEN passender Wände mit gesetzter `referenceLine`. */
export const applyReferenceLineRule = (rule: ReferenceLineRule, ctx: RuleCtx): Wall[] => applyRule(rule, ctx);

/** Sequenz-Regel: führt Unterregeln der Reihe nach aus (`stopOnMatch`: Abbruch nach dem ersten produktiven Schritt). */
export const applySequenceRule = (rule: SequenceRule, ctx: RuleCtx): Wall[] => applyRule(rule, ctx);

/**
 * Entfernt doppelte Wände aus der generierten Liste: gleicher Start- und Endpunkt innerhalb `tolerance`
 * (Meter), auch umgekehrt (A→B = B→A); behält jeweils die ERSTE Instanz.
 */
export function deduplicateWalls(input: Wall[], tolerance = 0.01): Wall[] {
  return call<Wall[]>("deduplicate", { walls: input, tolerance });
}

/**
 * Prüft, ob eine Wand die Bedingung einer ConditionalThicknessRule erfüllt: „exterior" (am Rand der
 * Bounding-Box des Kontexts), „interior" (Gegenteil), „bearing" (Wand liegt innerhalb 10° einer Achse);
 * sonst immer `false`.
 */
export function matchesCondition(wall: Wall, condition: string, ctx: RuleCtx): boolean {
  return call<boolean>("matchesCondition", { wall, condition, ctx });
}

/** Prüft, ob eine Wand dem Ziel einer ReferenceLineRule entspricht („all", „exterior"). */
export function matchesTarget(wall: Wall, target: string, ctx: RuleCtx): boolean {
  return call<boolean>("matchesTarget", { wall, target, ctx });
}

// DrawingLevel-Re-Export für Konsumenten, die keinen eigenen types-Import wollen.
export type { DrawingLevel };

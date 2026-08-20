// Parametrische Wand-Engine — löst ParametricWall-Regelwerke zu Wall[]-Arrays auf.
//
// Dieses Modul ist ABSICHTLICH frei von React-, Store- und App.tsx-Importen.
// Es ist eine reine Modell-Schicht: Eingabe ist ein ParametricWall-Regelwerk +
// Kontext (Geschoss, Grid-Achsen, bestehende Wände), Ausgabe sind neue Wall[]-
// Objekte, die direkt in project.walls eingefügt werden können.
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
  /** Wände, die bisher durch frühere Regeln erzeugt wurden (veränderbar). */
  existingWalls: Wall[];
}

// ── ID-Hilfsfunktion ──────────────────────────────────────────────────────

/** Einfacher Zähler für generierte Wand-IDs (sessionlokal, nicht persistent). */
let _idCounter = 0;

/**
 * Erzeugt eine eindeutige ID für eine parametrisch generierte Wand.
 * Format: „pw-<parametricWallId>-<counter>".
 */
function makeWallId(prefix: string): string {
  _idCounter += 1;
  return `pw-${prefix}-${_idCounter}`;
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
  const ctx: RuleCtx = {
    floorId,
    defaultWallType,
    context,
    existingWalls: context.existingWalls ?? [],
  };

  const generated: Wall[] = [];

  for (const rule of parametricWall.rules) {
    const ruleWalls = applyRule(rule, {
      ...ctx,
      existingWalls: [...ctx.existingWalls, ...generated],
    });
    generated.push(...ruleWalls);
  }

  return deduplicateWalls(generated, tolerance);
}

// ── Rule-Dispatcher ───────────────────────────────────────────────────────

/**
 * Dispatcher: delegiert eine Regel an die passende Implementierung.
 * Alle Branches sind exhaustiv — unbekannte Typen geben leer zurück.
 *
 * @param rule - Die auszuführende Regel.
 * @param ctx  - Interner Arbeitskontext.
 * @returns Wall[]-Array, das diese Regel erzeugt oder verändert hat.
 */
export function applyRule(rule: ParametricRule, ctx: RuleCtx): Wall[] {
  switch (rule.type) {
    case "grid":
      return applyGridRule(rule, ctx);
    case "module":
      return applyModuleRule(rule, ctx);
    case "conditional-thickness":
      return applyConditionalThicknessRule(rule, ctx);
    case "reference-line":
      return applyReferenceLineRule(rule, ctx);
    case "sequence":
      return applySequenceRule(rule, ctx);
    default: {
      // TypeScript exhaustiveness-Guard: niemals erreicht bei vollständiger Union.
      const _exhaustive: never = rule;
      void _exhaustive;
      return [];
    }
  }
}

// ── Regel-Implementierungen ────────────────────────────────────────────────

/**
 * Raster-Regel: generiert Wände entlang gleichmäßiger X-/Y-Achsen.
 *
 * MVP-Verhalten:
 *   - Rasterachsen aus `context.gridAxes` ODER gleichmäßigem `spacing`.
 *   - Standardbereich: 0 … `defaultExtent` (10 Einheiten × Spacing), wenn keine
 *     Grenzgeometrie vorhanden.
 *   - Clipping durch `context.boundaryGeometry` (nur einfache Bounding-Box, MVP).
 *   - Je Achse eine Wand senkrecht zur Richtung.
 *
 * @param rule - GridRule-Parameter.
 * @param ctx  - Arbeitskontext (Geschoss, Wandtyp, …).
 * @returns Wall[]-Array mit generierten Rasterwänden.
 */
export function applyGridRule(rule: GridRule, ctx: RuleCtx): Wall[] {
  const walls: Wall[] = [];
  const spacing = rule.spacing ?? 3.0;
  const wallTypeId = rule.wallTypeId ?? ctx.defaultWallType.id;
  const referenceLine = rule.referenceLine;
  const height = rule.height ?? (ctx.context.floor.floorHeight ?? 2.6);
  const floorId = ctx.floorId;
  const categoryCode = "20";

  // Bereich aus Grenzpolygon (Bounding-Box) oder Standardbereich ermitteln.
  const { minX, maxX, minY, maxY } = computeBounds(ctx.context, spacing);

  // X-Richtung: Wände parallel zur Y-Achse (also senkrecht zur X-Richtung).
  if (rule.directions === "x" || rule.directions === "both") {
    const axes = rule.gridId != null && ctx.context.gridAxes
      ? ctx.context.gridAxes.x
      : generateAxisPositions(minX, maxX, spacing);

    for (const axisX of axes) {
      const wall: Wall = {
        id: makeWallId(`${floorId}-gx`),
        type: "wall",
        floorId,
        categoryCode,
        start: { x: axisX, y: minY },
        end: { x: axisX, y: maxY },
        wallTypeId,
        height,
        ...(referenceLine != null ? { referenceLine } : {}),
      };
      walls.push(wall);
    }
  }

  // Y-Richtung: Wände parallel zur X-Achse (also senkrecht zur Y-Richtung).
  if (rule.directions === "y" || rule.directions === "both") {
    const axes = rule.gridId != null && ctx.context.gridAxes
      ? ctx.context.gridAxes.y
      : generateAxisPositions(minY, maxY, spacing);

    for (const axisY of axes) {
      const wall: Wall = {
        id: makeWallId(`${floorId}-gy`),
        type: "wall",
        floorId,
        categoryCode,
        start: { x: minX, y: axisY },
        end: { x: maxX, y: axisY },
        wallTypeId,
        height,
        ...(referenceLine != null ? { referenceLine } : {}),
      };
      walls.push(wall);
    }
  }

  return walls;
}

/**
 * Modul-Regel: unterteilt eine Referenzspanne proportional in Felder.
 *
 * MVP-Verhalten:
 *   - Spanne aus Geschoss-Ausdehnung (Bounding-Box) oder Referenzwand.
 *   - Teilungspunkte im `moduleSize`-Abstand.
 *   - Querwände (senkrecht zur `direction`) an jedem Teilungspunkt.
 *
 * @param rule - ModuleRule-Parameter.
 * @param ctx  - Arbeitskontext.
 * @returns Wall[]-Array mit Querwänden an Modul-Teilungspunkten.
 */
export function applyModuleRule(rule: ModuleRule, ctx: RuleCtx): Wall[] {
  const walls: Wall[] = [];
  const wallTypeId = rule.wallTypeId ?? ctx.defaultWallType.id;
  const referenceLine = rule.referenceLine;
  const height = rule.height ?? (ctx.context.floor.floorHeight ?? 2.6);
  const floorId = ctx.floorId;
  const categoryCode = "20";

  const { minX, maxX, minY, maxY } = computeBounds(ctx.context, rule.moduleSize);

  // Referenzwand: falls angegeben, Spanne aus dieser Wand ableiten.
  let spanStart: number;
  let spanEnd: number;
  let perpStart: number;
  let perpEnd: number;

  if (rule.referenceWallId != null) {
    const refWall = ctx.existingWalls.find((w) => w.id === rule.referenceWallId);
    if (refWall != null) {
      // Spanne entlang der Hauptachse der Referenzwand.
      if (rule.direction === "x") {
        spanStart = Math.min(refWall.start.x, refWall.end.x);
        spanEnd = Math.max(refWall.start.x, refWall.end.x);
        perpStart = minY;
        perpEnd = maxY;
      } else {
        spanStart = Math.min(refWall.start.y, refWall.end.y);
        spanEnd = Math.max(refWall.start.y, refWall.end.y);
        perpStart = minX;
        perpEnd = maxX;
      }
    } else {
      // Referenzwand nicht gefunden: Fallback auf Bounding-Box.
      spanStart = rule.direction === "x" ? minX : minY;
      spanEnd = rule.direction === "x" ? maxX : maxY;
      perpStart = rule.direction === "x" ? minY : minX;
      perpEnd = rule.direction === "x" ? maxY : maxX;
    }
  } else {
    spanStart = rule.direction === "x" ? minX : minY;
    spanEnd = rule.direction === "x" ? maxX : maxY;
    perpStart = rule.direction === "x" ? minY : minX;
    perpEnd = rule.direction === "x" ? maxY : maxX;
  }

  // Modul-Teilungspunkte (ohne Start und Ende der Spanne selbst).
  const positions = generateAxisPositions(spanStart, spanEnd, rule.moduleSize);
  // Ersten und letzten Punkt herausfiltern, da das dort bereits Außenwände gibt.
  const dividers = positions.filter((p) => p > spanStart + 1e-6 && p < spanEnd - 1e-6);

  for (const pos of dividers) {
    const wall: Wall = rule.direction === "x"
      ? {
          id: makeWallId(`${floorId}-mx`),
          type: "wall",
          floorId,
          categoryCode,
          start: { x: pos, y: perpStart },
          end: { x: pos, y: perpEnd },
          wallTypeId,
          height,
          ...(referenceLine != null ? { referenceLine } : {}),
        }
      : {
          id: makeWallId(`${floorId}-my`),
          type: "wall",
          floorId,
          categoryCode,
          start: { x: perpStart, y: pos },
          end: { x: perpEnd, y: pos },
          wallTypeId,
          height,
          ...(referenceLine != null ? { referenceLine } : {}),
        };
    walls.push(wall);
  }

  return walls;
}

/**
 * Bedingte-Dicken-Regel: weist bestehenden Wänden einen neuen Wandtyp zu,
 * wenn eine Bedingung erfüllt ist.
 *
 * Gibt MODIFIZIERTE KOPIEN der passenden Wände zurück (keine Mutation).
 * Die Originalwände in `existingWalls` bleiben unverändert.
 *
 * @param rule - ConditionalThicknessRule-Parameter.
 * @param ctx  - Arbeitskontext (enthält die zu prüfenden Wände).
 * @returns Wall[]-Array mit geändertem `wallTypeId` für passende Wände.
 */
export function applyConditionalThicknessRule(
  rule: ConditionalThicknessRule,
  ctx: RuleCtx,
): Wall[] {
  return ctx.existingWalls
    .filter((w) => matchesCondition(w, rule.condition, ctx))
    .map((w) => ({ ...w, id: makeWallId(`${ctx.floorId}-ct`), wallTypeId: rule.wallTypeId }));
}

/**
 * Referenzlinien-Regel: setzt `referenceLine` bei passenden Wänden einheitlich.
 *
 * Gibt MODIFIZIERTE KOPIEN der passenden Wände zurück.
 *
 * @param rule - ReferenceLineRule-Parameter.
 * @param ctx  - Arbeitskontext.
 * @returns Wall[]-Array mit gesetzter `referenceLine`.
 */
export function applyReferenceLineRule(
  rule: ReferenceLineRule,
  ctx: RuleCtx,
): Wall[] {
  return ctx.existingWalls
    .filter((w) => matchesTarget(w, rule.target, ctx))
    .map((w) => ({
      ...w,
      id: makeWallId(`${ctx.floorId}-rl`),
      referenceLine: rule.referenceLine,
    }));
}

/**
 * Sequenz-Regel: führt Unterregeln in Reihenfolge aus.
 *
 * Jede Unterregel erhält das bisherige Ergebnis als `existingWalls`, sodass
 * spätere Regeln die früheren verfeinern können (z. B. Raster → Dicke → Linie).
 * Mit `stopOnMatch=true` bricht die Sequenz nach dem ersten produktiven Schritt ab.
 *
 * @param rule - SequenceRule-Parameter (enthält `rules[]`).
 * @param ctx  - Arbeitskontext.
 * @returns Wall[]-Array (Summe aller Unterregel-Ausgaben, oder Abbruch bei stopOnMatch).
 */
export function applySequenceRule(rule: SequenceRule, ctx: RuleCtx): Wall[] {
  let result: Wall[] = [];

  for (const subrule of rule.rules) {
    const subruleCtx: RuleCtx = {
      ...ctx,
      existingWalls: [...ctx.existingWalls, ...result],
    };
    const subruleWalls = applyRule(subrule, subruleCtx);
    result = [...result, ...subruleWalls];

    if (rule.stopOnMatch === true && subruleWalls.length > 0) {
      break;
    }
  }

  return result;
}

// ── Hilfsfunktionen ───────────────────────────────────────────────────────

/**
 * Entfernt doppelte Wände aus der generierten Liste.
 *
 * Zwei Wände gelten als Duplikat, wenn Start- und Endpunkt jeweils innerhalb
 * `tolerance` (Meter) übereinstimmen — sowohl in der gleichen als auch in der
 * umgekehrten Orientierung (A→B = B→A).
 *
 * Behält jeweils die ERSTE Instanz; spätere Duplikate werden verworfen.
 *
 * @param walls     - Eingabe-Wall[]-Array (wird nicht mutiert).
 * @param tolerance - Abstandsschwelle in Metern (Default 0.01 m = 1 cm).
 * @returns Bereinigte Wall[]-Liste ohne Duplikate.
 */
export function deduplicateWalls(walls: Wall[], tolerance = 0.01): Wall[] {
  const unique: Wall[] = [];

  for (const candidate of walls) {
    const isDuplicate = unique.some((existing) => {
      const fwd =
        dist2(candidate.start, existing.start) <= tolerance &&
        dist2(candidate.end, existing.end) <= tolerance;
      const rev =
        dist2(candidate.start, existing.end) <= tolerance &&
        dist2(candidate.end, existing.start) <= tolerance;
      return fwd || rev;
    });

    if (!isDuplicate) {
      unique.push(candidate);
    }
  }

  return unique;
}

/**
 * Prüft, ob eine Wand die Bedingung einer ConditionalThicknessRule erfüllt.
 *
 * MVP-Implementierung:
 *   • „exterior"  — Wand liegt am Rand der Bounding-Box des Kontexts
 *     (innerhalb einer großzügigen Toleranz).
 *   • „interior"  — Gegenteil von „exterior".
 *   • „bearing"   — Wand ist in der Primärrichtung (X oder Y) ausgerichtet
 *     (einfaches Heuristikum für MVP).
 *   • Sonstige    — immer `false` (Phase 3: Wall.tags[]).
 *
 * @param wall      - Zu prüfende Wand.
 * @param condition - Bedingungsstring aus der Regel.
 * @param ctx       - Arbeitskontext (enthält Grenzgeometrie).
 * @returns `true`, wenn die Bedingung zutrifft.
 */
export function matchesCondition(
  wall: Wall,
  condition: string,
  ctx: RuleCtx,
): boolean {
  if (condition === "exterior") {
    return isExteriorWall(wall, ctx);
  }
  if (condition === "interior") {
    return !isExteriorWall(wall, ctx);
  }
  if (condition === "bearing") {
    // Heuristikum: Wand ist „tragend", wenn sie in X- oder Y-Richtung läuft
    // (nahezu horizontal/vertikal). Phase 3: strukturelle Klassifizierung.
    const dx = Math.abs(wall.end.x - wall.start.x);
    const dy = Math.abs(wall.end.y - wall.start.y);
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-6) return false;
    const angleFromX = Math.atan2(dy, dx);
    // Gilt als tragend, wenn Winkel innerhalb 10° von X- oder Y-Achse liegt.
    const tenDeg = (10 * Math.PI) / 180;
    return (
      angleFromX <= tenDeg ||
      angleFromX >= Math.PI / 2 - tenDeg
    );
  }
  // Unbekannte Bedingung — Phase 3: Tag-Matching.
  return false;
}

/**
 * Prüft, ob eine Wand dem Ziel einer ReferenceLineRule entspricht.
 *
 * @param wall   - Zu prüfende Wand.
 * @param target - Zielstring aus der Regel.
 * @param ctx    - Arbeitskontext.
 * @returns `true`, wenn die Wand dem Ziel entspricht.
 */
export function matchesTarget(
  wall: Wall,
  target: string,
  ctx: RuleCtx,
): boolean {
  if (target === "all") return true;
  if (target === "exterior") return isExteriorWall(wall, ctx);
  // Unbekanntes Ziel — Phase 3: Tag-Matching.
  return false;
}

// ── Interne Hilfsfunktionen ───────────────────────────────────────────────

/** Euklidischer Abstand zweier 2D-Punkte. */
function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Berechnet die Bounding-Box des Kontexts.
 * Nutzt `boundaryGeometry`, falls vorhanden; sonst einen Standardbereich,
 * der auf `spacing` basiert (0 … spacing × 10).
 */
function computeBounds(
  context: ParametricContext,
  spacing: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  if (context.boundaryGeometry != null && context.boundaryGeometry.boundary.length >= 2) {
    const pts = context.boundaryGeometry.boundary;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { minX, maxX, minY, maxY };
  }
  // Standardbereich: 10 Einheiten × Spacing.
  const extent = spacing * 10;
  return { minX: 0, maxX: extent, minY: 0, maxY: extent };
}

/**
 * Generiert gleichmäßig verteilte Achspositionen im Intervall [min, max].
 * Die erste Position liegt bei `min`, jede weitere `spacing` danach.
 * Enthält `max`, wenn dieser exakt auf einem Rasterpunkt liegt (±1e-6).
 */
function generateAxisPositions(min: number, max: number, spacing: number): number[] {
  if (spacing <= 0 || max <= min) return [];
  const positions: number[] = [];
  let pos = min;
  while (pos <= max + 1e-6) {
    positions.push(Math.round(pos * 1e6) / 1e6); // Rundungsfehler vermeiden
    pos += spacing;
  }
  return positions;
}

/**
 * Klassifiziert eine Wand als „außen" (Rand der Bounding-Box) oder „innen".
 *
 * MVP: Eine Wand gilt als außen, wenn BEIDE ihrer Endpunkte auf oder nahe
 * am Rand der Bounding-Box des Kontexts liegen (±`edgeTolerance`).
 */
function isExteriorWall(wall: Wall, ctx: RuleCtx): boolean {
  const { minX, maxX, minY, maxY } = computeBounds(ctx.context, 1.0);
  const edgeTol = 0.1; // 10 cm Toleranz am Rand.

  const isOnEdge = (p: Vec2): boolean =>
    Math.abs(p.x - minX) <= edgeTol ||
    Math.abs(p.x - maxX) <= edgeTol ||
    Math.abs(p.y - minY) <= edgeTol ||
    Math.abs(p.y - maxY) <= edgeTol;

  return isOnEdge(wall.start) && isOnEdge(wall.end);
}

// DrawingLevel-Re-Export für Konsumenten, die keinen eigenen types-Import wollen.
export type { DrawingLevel };

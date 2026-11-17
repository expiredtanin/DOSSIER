// [271] Umbau (Archicad „Renovation“): Status je Bauteil, Etappen, Umbaufilter. Die Regeln („sichtbar/wie gezeichnet im
// Filter F“) stehen im Kern (`src-tauri/core/src/renovation.rs`); hier nur, was die Oberfläche zum Lesen und Setzen braucht.

import type { CoreOp } from "../core/ops";
import { documentFor } from "../core/document";
import { addItems, patchItem, patchItems, setField } from "../core/opsBuild";
import type { LayerRenovation, Project, Renovation, RenovationPhase, RenovationShow, RenovationSide, RenovationStatus, Tree, TreeStatus, WallType } from "./types";

/** Eingebaute Umbaufilter (Ids; Namen über `t("renovation.filter.<id>")`). */
export const BUILTIN_RENOVATION_FILTERS = ["bestand", "abbruch", "neubau", "umbauplan", "endzustand"] as const;

/** Status in der Reihenfolge der Oberfläche. */
export const RENOVATION_STATUSES: readonly RenovationStatus[] = ["existing", "demolish", "new"];

/**
 * Listen mit Umbau-Status (Räume nur Sichtbarkeit/Flächen, keine Farbe). `drawings2d`: Möbel und Symbole der Bibliothek
 * (ohne Angabe = Bestand) sowie 2D-Elemente mit ausdrücklichem Status (Linienwerk, Masse …; Kern `drawing_takes_part`).
 */
export const RENOVATION_COLLECTIONS = ["walls", "openings", "ceilings", "roofs", "stairs", "columns", "extrudedSolids", "rooms", "drawings2d"] as const;
export type RenovationCollection = (typeof RENOVATION_COLLECTIONS)[number];

/**
 * Bäume tragen kein eigenes `renovation`: ihr Bestand (`Tree.status`, [149]) IST der Umbau-Status
 * (bestehend = Bestand, zu fällen = Abbruch, neu = Neu; Kern `renovation::tree_renovation`).
 */
const TREE_STATUS_OF: Record<RenovationStatus, TreeStatus> = { existing: "existing", demolish: "remove", new: "new" };
export const treeRenovationStatus = (t: Tree): RenovationStatus => (t.status === "remove" ? "demolish" : t.status === "new" ? "new" : "existing");

/** SIA-400-Vorgabe der Umbau-Farben (gleich wie `renovation::default_style` im Kern). */
export const DEFAULT_RENOVATION_STYLES: Record<RenovationStatus, { fill: string; line?: string; dashed: boolean }> = {
  existing: { fill: "#a6a6a6", dashed: false },
  demolish: { fill: "#ffd800", dashed: true },
  new: { fill: "#e3001b", line: "#c00016", dashed: false },
};

export interface RenovationFilterEntry {
  id: string;
  name: string;
  builtin: boolean;
}

/** Eingebaute und eigene Umbaufilter (Kern-Abfrage `renovationFilters`). */
export function renovationFilterList(project: Project): RenovationFilterEntry[] {
  return documentFor(project).query<RenovationFilterEntry[]>("renovationFilters");
}

/** Status eines Elements (fehlt/unbekannt ⇒ Bestand). */
export function renovationStatus(r: Renovation | undefined | null): RenovationStatus {
  return r?.status === "demolish" || r?.status === "new" ? r.status : "existing";
}

/** Etappen des Projekts in ihrer Reihenfolge. */
export function renovationPhases(project: Project): readonly RenovationPhase[] {
  return project.renovation?.phases ?? [];
}

/**
 * Umbau-Angaben für ein neues Element nach dem aktuellen Zeichen-Status: Bestand (Vorgabe) ohne Feld, sonst Status
 * und Etappe.
 */
export function renovationForNew(status: RenovationStatus, phase?: string | null): Renovation | undefined {
  if (status === "existing" && !phase) return undefined;
  return phase ? { status, phase } : { status };
}

/**
 * Ops: Status (und Etappe) für alle Elemente mit id in `ids` setzen (ein Undo-Schritt, wenn zusammen angewandt).
 * `phase`: `undefined` = Etappe unverändert, `null` = keine Etappe. Bestand ohne Etappe entfernt das Feld.
 */
export function setRenovationOps(project: Project, ids: Iterable<string>, status: RenovationStatus | undefined, phase?: string | null): CoreOp[] {
  const set = new Set(ids);
  const ops: CoreOp[] = [];
  for (const c of RENOVATION_COLLECTIONS) {
    ops.push(
      ...patchItems(project, c, set, (e) => {
        const old = (e as { renovation?: Renovation }).renovation;
        const st = status ?? renovationStatus(old);
        const ph = phase === undefined ? old?.phase : phase ?? undefined;
        const next = keepRenovated(renovationForNew(st, ph), old);
        const { renovation: _drop, ...rest } = e as { renovation?: Renovation } & Record<string, unknown>;
        void _drop;
        return (next ? { ...rest, renovation: next } : rest) as unknown as typeof e;
      }),
    );
  }
  // Bäume: der Status ist ihr Bestand (Etappen kennen sie nicht).
  if (status) ops.push(...patchItems(project, "trees", set, (t) => ({ ...t, status: TREE_STATUS_OF[status] })));
  return ops;
}

/** [274] Sanierung (`renovated`, `newTypeId`) beim Setzen von Status/Etappe behalten. */
function keepRenovated(next: Renovation | undefined, old: Renovation | undefined): Renovation | undefined {
  if (!old?.renovated && !old?.newTypeId) return next;
  const r: Renovation = { ...(next ?? { status: "existing" }) };
  if (old.renovated) r.renovated = true;
  if (old.newTypeId) r.newTypeId = old.newTypeId;
  return r;
}

/** Element-Ids der Auswahl, die einen Umbau-Status tragen können. */
export function renovatableIds(project: Project, ids: Iterable<string>): string[] {
  const set = new Set(ids);
  const out: string[] = [];
  for (const c of RENOVATION_COLLECTIONS) {
    for (const e of (project[c] ?? []) as { id: string }[]) if (set.has(e.id)) out.push(e.id);
  }
  for (const t of project.trees ?? []) if (set.has(t.id)) out.push(t.id);
  return out;
}

/** Gemeinsamer Status bzw. gemeinsame Etappe der Elemente `ids` (`"mixed"` bei verschiedenen Werten, `null` ohne Elemente). */
export function commonRenovation(project: Project, ids: Iterable<string>): { status: RenovationStatus | "mixed" | null; phase: string | "mixed" | null } {
  const set = new Set(ids);
  let status: RenovationStatus | "mixed" | null = null;
  let phase: string | "mixed" | null = null;
  let first = true;
  const add = (s: RenovationStatus, ph: string) => {
    if (first) {
      status = s;
      phase = ph;
      first = false;
    } else {
      if (status !== s) status = "mixed";
      if (phase !== ph) phase = "mixed";
    }
  };
  for (const c of RENOVATION_COLLECTIONS) {
    for (const e of (project[c] ?? []) as { id: string; renovation?: Renovation }[]) {
      if (set.has(e.id)) add(renovationStatus(e.renovation), e.renovation?.phase ?? "");
    }
  }
  for (const t of project.trees ?? []) if (set.has(t.id)) add(treeRenovationStatus(t), "");
  return { status, phase };
}

/** Ops: Etappen-Liste ersetzen (Namen, Reihenfolge); Elemente mit einer entfernten Etappe verlieren sie. */
export function setPhasesOps(project: Project, phases: readonly RenovationPhase[]): CoreOp[] {
  const keep = new Set(phases.map((p) => p.id));
  const settings = { ...(project.renovation ?? {}), phases: phases.length ? [...phases] : undefined };
  if (!settings.phases) delete settings.phases;
  const ops: CoreOp[] = [setField("renovation", Object.keys(settings).length ? settings : undefined)];
  for (const c of RENOVATION_COLLECTIONS) {
    ops.push(
      ...patchItems(
        project,
        c,
        (e) => {
          const ph = (e as { renovation?: Renovation }).renovation?.phase;
          return !!ph && !keep.has(ph);
        },
        (e) => {
          const r = (e as { renovation?: Renovation }).renovation!;
          const next = keepRenovated(renovationForNew(renovationStatus(r), null), r);
          const { renovation: _drop, ...rest } = e as { renovation?: Renovation } & Record<string, unknown>;
          void _drop;
          return (next ? { ...rest, renovation: next } : rest) as unknown as typeof e;
        },
      ),
    );
  }
  return ops;
}

/** Nächste freie Etappen-Id. */
export function newPhaseId(project: Project): string {
  const used = new Set(renovationPhases(project).map((p) => p.id));
  let i = used.size + 1;
  while (used.has(`etappe-${i}`)) i++;
  return `etappe-${i}`;
}

// ── Panel „Umbau“ (Dock): Filter-Vorschau, Auswahl nach Status ─────────────────────────────────────────────

/** Eingebaute Filter: Darstellung je Status (Spiegel von `renovation::builtin` im Kern; `renovation.test.ts` prüft ihn gegen den Plan). */
const BUILTIN_FILTER_SHOWS: Record<string, Record<RenovationStatus, RenovationShow>> = {
  bestand: { existing: "show", demolish: "show", new: "hide" },
  abbruch: { existing: "show", demolish: "override", new: "hide" },
  neubau: { existing: "show", demolish: "hide", new: "override" },
  umbauplan: { existing: "override", demolish: "override", new: "override" },
  endzustand: { existing: "show", demolish: "hide", new: "show" },
};

/** Darstellung je Status im Filter `id` (eingebaut oder eigen); `null` bei unbekanntem Filter. */
export function renovationFilterShows(project: Project, id: string): Record<RenovationStatus, RenovationShow> | null {
  const own = project.renovation?.filters?.find((f) => f.id === id);
  if (own) return { existing: own.existing, demolish: own.demolish, new: own.new };
  return BUILTIN_FILTER_SHOWS[id] ?? null;
}

/** Umbau-Farbe eines Status (Projekt-Vorgabe über SIA-400-Vorgabe). */
export function renovationStyleOf(project: Project, status: RenovationStatus): { fill: string; line?: string; dashed: boolean } {
  const d = DEFAULT_RENOVATION_STYLES[status];
  const o = project.renovation?.styles?.[status];
  return { fill: o?.fill ?? d.fill, line: o?.line ?? d.line, dashed: o?.dashed ?? d.dashed };
}

/** Möbel und Symbole (Objekte der Bibliothek, Blöcke): nehmen ohne Angabe als Bestand am Umbaufilter teil. */
function isFurnitureShape(d: unknown): boolean {
  const shape = (d as { geom?: { shape?: string } }).geom?.shape;
  return shape === "libobj" || shape === "block";
}

/** Auswahl-Art je Liste (`extrudedSolids` heissen in der Auswahl `solids`). */
const SELECTION_KEY: Record<RenovationCollection, string> = {
  walls: "walls",
  openings: "openings",
  ceilings: "ceilings",
  roofs: "roofs",
  stairs: "stairs",
  columns: "columns",
  extrudedSolids: "solids",
  rooms: "rooms",
  drawings2d: "drawings",
};

/**
 * Ids aller Elemente mit Status `status` (Öffnung ohne eigenen Status: der der Wand), je Auswahl-Art.
 * `floorId`: nur dieses Geschoss (Öffnungen über ihre Wand); `phase`: nur diese Etappe (`""` = ohne Etappe).
 */
export function idsByRenovationStatus(
  project: Project,
  status: RenovationStatus,
  opts: { floorId?: string | null; phase?: string } = {},
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const wallOf = new Map(project.walls.map((w) => [w.id, w]));
  for (const c of RENOVATION_COLLECTIONS) {
    const ids: string[] = [];
    for (const e of (project[c] ?? []) as { id: string; floorId?: string; hostWallId?: string; renovation?: Renovation }[]) {
      // Zeichnungen ohne ausdrücklichen Status (Linien, Masse …) nehmen nicht teil; Möbel und Symbole gelten als Bestand.
      if (c === "drawings2d" && !e.renovation && !isFurnitureShape(e)) continue;
      const wall = c === "openings" && e.hostWallId ? wallOf.get(e.hostWallId) : undefined;
      const floor = e.floorId ?? (e as { levelId?: string }).levelId ?? wall?.floorId;
      if (opts.floorId && floor && floor !== opts.floorId) continue;
      const r = e.renovation ?? wall?.renovation;
      if (renovationStatus(r) !== status) continue;
      if (opts.phase !== undefined && (r?.phase ?? "") !== opts.phase) continue;
      ids.push(e.id);
    }
    if (ids.length) out[SELECTION_KEY[c]] = ids;
  }
  const trees = (project.trees ?? []).filter((t) => treeRenovationStatus(t) === status && (!opts.floorId || t.floorId === opts.floorId) && (opts.phase === undefined || opts.phase === "")).map((t) => t.id);
  if (trees.length) out.trees = trees;
  return out;
}

/** Zahl der Elemente je Status (Öffnungen ohne eigenen Status zählen mit dem der Wand). */
export function renovationCounts(project: Project, floorId?: string | null): Record<RenovationStatus, number> {
  const n: Record<RenovationStatus, number> = { existing: 0, demolish: 0, new: 0 };
  for (const s of RENOVATION_STATUSES) n[s] = Object.values(idsByRenovationStatus(project, s, { floorId })).reduce((a, v) => a + v.length, 0);
  return n;
}

/** Zahl der Elemente, die Etappe `phaseId` tragen (für die Rückfrage beim Löschen). */
export function phaseUsage(project: Project, phaseId: string): number {
  let n = 0;
  for (const c of RENOVATION_COLLECTIONS) {
    for (const e of (project[c] ?? []) as { renovation?: Renovation }[]) if (e.renovation?.phase === phaseId) n++;
  }
  return n;
}

// ── [274] Sanierung je Schicht: Typ-Paar Bestand → Sanierungstyp (Regeln im Kern `renovation::build_up`) ────────────

/** Neuer Aufbau einer Wand: keiner, der Sanierungstyp ihres Wandtyps oder ein anderer Wandtyp (Ausnahme). */
export type RenovationBuildUp = { kind: "none" } | { kind: "type" } | { kind: "other"; typeId: string };

/** Neuer Aufbau einer Wand aus ihren Umbau-Angaben. */
export function wallBuildUp(r: Renovation | undefined | null): RenovationBuildUp {
  if (r?.newTypeId) return { kind: "other", typeId: r.newTypeId };
  return r?.renovated ? { kind: "type" } : { kind: "none" };
}

/** Schlüssel eines Aufbaus für Auswahllisten (`""` keiner, `"type"` wie Typ, sonst die Typ-Id mit Präfix). */
export function buildUpKey(b: RenovationBuildUp): string {
  return b.kind === "none" ? "" : b.kind === "type" ? "type" : `t:${b.typeId}`;
}

/** Gegenstück zu {@link buildUpKey}. */
export function parseBuildUpKey(k: string): RenovationBuildUp {
  if (k === "type") return { kind: "type" };
  if (k.startsWith("t:") && k.length > 2) return { kind: "other", typeId: k.slice(2) };
  return { kind: "none" };
}

function withBuildUp(r: Renovation | undefined, b: RenovationBuildUp): Renovation | undefined {
  const base: Renovation = { ...(r ?? { status: "existing" }) };
  delete base.renovated;
  delete base.newTypeId;
  if (b.kind === "type") base.renovated = true;
  if (b.kind === "other") {
    base.renovated = true;
    base.newTypeId = b.typeId;
  }
  const plain = base.status === "existing" && !base.phase && !base.renovated;
  return plain ? undefined : base;
}

/** Ops: neuer Aufbau für die Wände `ids` (ein Undo-Schritt); Status/Etappe bleiben. */
export function setBuildUpOps(project: Project, ids: Iterable<string>, b: RenovationBuildUp): CoreOp[] {
  const set = new Set(ids);
  return patchItems(project, "walls", set, (w) => {
    const next = withBuildUp(w.renovation, b);
    const { renovation: _drop, ...rest } = w;
    void _drop;
    return next ? { ...rest, renovation: next } : rest;
  });
}

/** Gemeinsamer Aufbau-Schlüssel ({@link buildUpKey}) der Wände `ids`: `"mixed"` bei verschiedenen, `null` ohne Wände. */
export function commonBuildUp(project: Project, ids: Iterable<string>): string | null {
  const set = new Set(ids);
  let out: string | null = null;
  for (const w of project.walls) {
    if (!set.has(w.id)) continue;
    const k = buildUpKey(wallBuildUp(w.renovation));
    if (out === null) out = k;
    else if (out !== k) return "mixed";
  }
  return out;
}

/** Ops: alle Wände des Bestandstyps `typeId` sanieren (Sanierungstyp des Typs; ein Undo-Schritt). */
export function renovateAllOfTypeOps(project: Project, typeId: string): CoreOp[] {
  const ids = project.walls.filter((w) => w.wallTypeId === typeId && renovationStatus(w.renovation) === "existing").map((w) => w.id);
  return setBuildUpOps(project, ids, { kind: "type" });
}

/** Nächste freie Wandtyp-Id mit Präfix. */
function freeTypeId(project: Project, base: string): string {
  const used = new Set(project.wallTypes.map((t) => t.id));
  let i = 1;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/**
 * Ops: „Sanierungstyp anlegen …“ — Kopie des Bestandstyps `typeId` als neuer Wandtyp `name` (zum Anpassen der Schichten)
 * und als Sanierungstyp des Bestandstyps eingetragen. Liefert die Ops und die neue Id.
 */
export function createRenovationTypeOps(project: Project, typeId: string, name: string): { ops: CoreOp[]; id: string } {
  const src = project.wallTypes.find((t) => t.id === typeId);
  if (!src) return { ops: [], id: "" };
  const id = freeTypeId(project, `${typeId}-saniert`);
  const copy: WallType = { id, name, layers: src.layers.map((l) => ({ ...l })) };
  return { ops: [...addItems("wallTypes", [copy]), ...setTypePairOps(project, typeId, { target: id, old: null, new: null })], id };
}

/** Ops: Typ-Paar am Bestandstyp ändern (Sanierungstyp, Bezugsseite, manuelle Zuordnung; `null` entfernt). */
export function setTypePairOps(
  project: Project,
  typeId: string,
  patch: { target?: string | null; side?: RenovationSide | null; old?: LayerRenovation[] | null; new?: LayerRenovation[] | null },
): CoreOp[] {
  return patchItem(project, "wallTypes", typeId, (t) => {
    const next: WallType = { ...t };
    const put = <K extends keyof WallType>(k: K, v: WallType[K] | null | undefined) => {
      if (v === undefined) return;
      if (v === null || (Array.isArray(v) && v.every((x) => x === "auto"))) delete next[k];
      else next[k] = v;
    };
    put("renovationTarget", patch.target);
    put("renovationSide", patch.side === "inside" ? null : patch.side);
    put("renovationOld", patch.old);
    put("renovationNew", patch.new);
    return next;
  });
}

/** Schicht eines Typ-Paars (Kern-Abfrage `renovationPair`). */
export interface RenovationPairLayer {
  componentId: string;
  name: string;
  color: string;
  thickness: number;
  fate: "kept" | "demolish" | "new";
}
/** Teilstück eines Ergebnis-Streifens. */
export interface RenovationStripPiece {
  thickness: number;
  kind: "kept" | "demolish" | "new" | "newOverDemolish";
  fill: string;
}
export interface RenovationPair {
  type: string;
  target: string;
  side: RenovationSide;
  old: RenovationPairLayer[];
  new: RenovationPairLayer[];
  oldStrip: RenovationStripPiece[];
  newStrip: RenovationStripPiece[];
  result: RenovationStripPiece[];
  walls: number;
  renovated: number;
}

/** Typ-Paar Bestandstyp → Sanierungstyp (`target` fehlt = eingetragener); `null` ohne gültiges Paar. */
export function renovationPair(project: Project, typeId: string, target?: string): RenovationPair | null {
  return documentFor(project).query<RenovationPair | null>("renovationPair", [], JSON.stringify({ type: typeId, target: target ?? "" }));
}

export interface RenovationPairsInfo {
  pairs: { type: string; name: string; target: string; targetName: string | null; walls: number; renovated: number }[];
  renovated: number;
}

/** Alle Typ-Paare mit Zählern (Umbau-Panel „Sanierung“). */
export function renovationPairs(project: Project): RenovationPairsInfo {
  return documentFor(project).query<RenovationPairsInfo>("renovationPairs");
}

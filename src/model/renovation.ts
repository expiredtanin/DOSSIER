// [271] Umbau (Archicad „Renovation“): Status je Bauteil, Etappen, Umbaufilter. Die Regeln („sichtbar/wie gezeichnet im
// Filter F“) stehen im Kern (`src-tauri/core/src/renovation.rs`); hier nur, was die Oberfläche zum Lesen und Setzen braucht.

import type { CoreOp } from "../core/ops";
import { documentFor } from "../core/document";
import { addItems, patchItem, patchItems, setField } from "../core/opsBuild";
import type { LayerRenovation, Project, Renovation, RenovationPhase, RenovationShow, RenovationSide, RenovationStatus, RenovationStyle, RenovationStyles, Tree, TreeStatus, WallType } from "./types";

/** Eingebaute Umbaufilter (Ids; Namen über `t("renovation.filter.<id>")`). */
export const BUILTIN_RENOVATION_FILTERS = ["bestand", "abbruch", "neubau", "umbauplan", "endzustand"] as const;

/** Status in der Reihenfolge der Oberfläche. */
export const RENOVATION_STATUSES: readonly RenovationStatus[] = ["existing", "demolish", "new"];

/**
 * Listen mit Umbau-Status (Räume nur Sichtbarkeit/Flächen, keine Farbe). `drawings2d`: Möbel und Symbole der Bibliothek
 * (ohne Angabe = Bestand) sowie 2D-Elemente mit ausdrücklichem Status (Linienwerk, Masse …; Kern `drawing_takes_part`).
 */
export const RENOVATION_COLLECTIONS = ["walls", "openings", "ceilings", "roofs", "stairs", "columns", "beams", "extrudedSolids", "rooms", "drawings2d", "railings"] as const;
export type RenovationCollection = (typeof RENOVATION_COLLECTIONS)[number];

/**
 * Bäume tragen kein eigenes `renovation`: ihr Bestand (`Tree.status`, [149]) IST der Umbau-Status
 * (bestehend = Bestand, zu fällen = Abbruch, neu = Neu; Kern `renovation::tree_renovation`).
 */
const TREE_STATUS_OF: Record<RenovationStatus, TreeStatus> = { existing: "existing", demolish: "remove", new: "new" };
export const treeRenovationStatus = (t: Tree): RenovationStatus => (t.status === "remove" ? "demolish" : t.status === "new" ? "new" : "existing");

/** Aufgelöste Umbau-Farbe eines Status (Stift schon in Farbe übersetzt). */
export interface RenovationStyleView {
  fill: string;
  line?: string;
  dashed: boolean;
}
export type RenovationStyleSet = Record<RenovationStatus, RenovationStyleView>;
/** [275] Umbau-Farben, wie der Kern sie auflöst: SIA-Vorgabe, Projekt, Etappen mit eigenen Farben (Id → je Status). */
export interface ResolvedRenovationStyles {
  defaults: RenovationStyleSet;
  project: RenovationStyleSet;
  phases: Record<string, RenovationStyleSet>;
}

type RawStyle = { fill: string; line: string | null; dashed: boolean };
const cleanSet = (x: Record<RenovationStatus, RawStyle>): RenovationStyleSet =>
  Object.fromEntries(RENOVATION_STATUSES.map((s) => [s, { fill: x[s].fill, ...(x[s].line ? { line: x[s].line } : {}), dashed: x[s].dashed }])) as RenovationStyleSet;

/**
 * [275] Umbau-Farben des Projekts (Kern-Abfrage `renovationStyles`, `renovation::style`/`phase_style`): eine Wahrheit
 * für Plan und Muster der Oberfläche — Stifte (aktiver Stiftsatz) und Etappen-Farben sind schon aufgelöst.
 */
export function resolvedRenovationStyles(project: Project): ResolvedRenovationStyles {
  const raw = documentFor(project).query<{ defaults: Record<RenovationStatus, RawStyle>; project: Record<RenovationStatus, RawStyle>; phases: Record<string, Record<RenovationStatus, RawStyle>> }>("renovationStyles");
  return {
    defaults: cleanSet(raw.defaults),
    project: cleanSet(raw.project),
    phases: Object.fromEntries(Object.entries(raw.phases ?? {}).map(([k, v]) => [k, cleanSet(v)])),
  };
}

/**
 * [275] Eine Umbau-Farbe ändern (`patch`; `null` = zurück auf die Vorgabe): fehlende Felder gelten als „wie Vorgabe“,
 * Farbe und Stift schliessen sich aus (wer eine freie Farbe setzt, löst den Stift und umgekehrt). `undefined` = leer.
 */
export function patchRenovationStyles(styles: RenovationStyles | undefined, status: RenovationStatus, patch: Partial<RenovationStyle> | null): RenovationStyles | undefined {
  const next: RenovationStyles = { ...(styles ?? {}) };
  if (patch === null) delete next[status];
  else {
    const merged: RenovationStyle = { ...(next[status] ?? {}), ...patch };
    if ("fill" in patch && patch.fill !== undefined) delete merged.fillPen;
    if ("fillPen" in patch && patch.fillPen !== undefined) delete merged.fill;
    if ("line" in patch && patch.line !== undefined) delete merged.linePen;
    if ("linePen" in patch && patch.linePen !== undefined) delete merged.line;
    for (const k of Object.keys(merged) as (keyof RenovationStyle)[]) if (merged[k] === undefined) delete merged[k];
    if (Object.keys(merged).length) next[status] = merged;
    else delete next[status];
  }
  return Object.keys(next).length ? next : undefined;
}

/** [275] Ops: Umbau-Farben des Projekts ersetzen (`undefined` = SIA-Vorgabe). */
export function setRenovationStylesOps(project: Project, styles: RenovationStyles | undefined): CoreOp[] {
  const next = { ...(project.renovation ?? {}) };
  if (styles) next.styles = styles;
  else delete next.styles;
  return [setField("renovation", Object.keys(next).length ? next : undefined)];
}

/** [275] Ops: eigene Umbau-Farben einer Etappe ersetzen (`undefined` = Farben des Projekts). */
export function setPhaseStylesOps(project: Project, phaseId: string, styles: RenovationStyles | undefined): CoreOp[] {
  const phases = renovationPhases(project).map((ph) => {
    if (ph.id !== phaseId) return ph;
    const { styles: _drop, ...rest } = ph;
    void _drop;
    return styles ? { ...rest, styles } : rest;
  });
  return setPhasesOps(project, phases);
}

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

/** Umbau-Farbe eines Status (Etappe `phaseId` mit eigenen Farben, sonst Projekt, sonst SIA-Vorgabe; Kern löst auf). */
export function renovationStyleOf(project: Project, status: RenovationStatus, phaseId?: string | null): RenovationStyleView {
  const r = resolvedRenovationStyles(project);
  return (phaseId ? r.phases[phaseId]?.[status] : undefined) ?? r.project[status];
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
  beams: "columns", // [280] Träger liegen im Auswahlkanal der Stützen
  extrudedSolids: "solids",
  rooms: "rooms",
  drawings2d: "drawings",
  railings: "railings",
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
    if (ids.length) out[SELECTION_KEY[c]] = [...(out[SELECTION_KEY[c]] ?? []), ...ids];
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

/** Neuer Aufbau eines Bauteils (Wand, Decke, Dach) aus seinen Umbau-Angaben. */
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

/** [274] Bauteilart einer Sanierung je Schicht: Wand, Decke oder Dach (je mit eigenem Typ-Katalog). */
export type RenovationHost = "wall" | "ceiling" | "roof";
export const RENOVATION_HOSTS: readonly RenovationHost[] = ["wall", "ceiling", "roof"];

/** Element-Liste, Typ-Liste und Typ-Feld je Bauteilart. */
const HOST = {
  wall: { items: "walls", types: "wallTypes", typeKey: "wallTypeId" },
  ceiling: { items: "ceilings", types: "ceilingTypes", typeKey: "ceilingTypeId" },
  roof: { items: "roofs", types: "roofTypes", typeKey: "roofTypeId" },
} as const;

/** Mehrschichtiger Typ mit Sanierungs-Angaben (Wand-, Decken- oder Dachtyp). */
export type LayeredType = Pick<WallType, "id" | "name" | "layers" | "renovationTarget" | "renovationSide" | "renovationOld" | "renovationNew" | "renovationCore">;
type HostItem = { id: string; renovation?: Renovation } & Record<string, unknown>;

/** Typen einer Bauteilart (Wandtypen, Deckentypen, Dachtypen). */
export function renovationTypes(project: Project, host: RenovationHost = "wall"): readonly LayeredType[] {
  return ((project as unknown as Record<string, unknown>)[HOST[host].types] as LayeredType[] | undefined) ?? [];
}

function hostItems(project: Project, host: RenovationHost): readonly HostItem[] {
  return ((project as unknown as Record<string, unknown>)[HOST[host].items] as HostItem[] | undefined) ?? [];
}

/** Typ-Id eines Elements (Wand-, Decken-, Dachtyp; Decke/Dach ohne Typ: `undefined`). */
export function hostTypeId(e: unknown, host: RenovationHost = "wall"): string | undefined {
  return ((e as Record<string, unknown>)[HOST[host].typeKey] as string | undefined) || undefined;
}

/** Ops: neuer Aufbau für die Elemente `ids` der Bauteilart `host` (ein Undo-Schritt); Status/Etappe bleiben. */
export function setBuildUpOps(project: Project, ids: Iterable<string>, b: RenovationBuildUp, host: RenovationHost = "wall"): CoreOp[] {
  const set = new Set(ids);
  const fn = (w: HostItem): HostItem => {
    const next = withBuildUp(w.renovation, b);
    const { renovation: _drop, ...rest } = w;
    void _drop;
    return next ? { ...rest, renovation: next } : rest;
  };
  return patchItems(project, HOST[host].items, set, fn as never);
}

/** Gemeinsamer Aufbau-Schlüssel ({@link buildUpKey}) der Elemente `ids`: `"mixed"` bei verschiedenen, `null` ohne. */
export function commonBuildUp(project: Project, ids: Iterable<string>, host: RenovationHost = "wall"): string | null {
  const set = new Set(ids);
  let out: string | null = null;
  for (const w of hostItems(project, host)) {
    if (!set.has(w.id)) continue;
    const k = buildUpKey(wallBuildUp(w.renovation));
    if (out === null) out = k;
    else if (out !== k) return "mixed";
  }
  return out;
}

/** Ops: alle Elemente des Bestandstyps `typeId` sanieren (Sanierungstyp des Typs; ein Undo-Schritt). */
export function renovateAllOfTypeOps(project: Project, typeId: string, host: RenovationHost = "wall"): CoreOp[] {
  const ids = hostItems(project, host).filter((w) => hostTypeId(w, host) === typeId && renovationStatus(w.renovation) === "existing").map((w) => w.id);
  return setBuildUpOps(project, ids, { kind: "type" }, host);
}

/** Nächste freie Typ-Id mit Präfix. */
function freeTypeId(project: Project, base: string, host: RenovationHost): string {
  const used = new Set(renovationTypes(project, host).map((t) => t.id));
  let i = 1;
  while (used.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

/**
 * Ops: „Sanierungstyp anlegen …“ — Kopie des Bestandstyps `typeId` als neuer Typ `name` (zum Anpassen der Schichten)
 * und als Sanierungstyp des Bestandstyps eingetragen. Liefert die Ops und die neue Id.
 */
export function createRenovationTypeOps(project: Project, typeId: string, name: string, host: RenovationHost = "wall"): { ops: CoreOp[]; id: string } {
  const src = renovationTypes(project, host).find((t) => t.id === typeId);
  if (!src) return { ops: [], id: "" };
  const id = freeTypeId(project, `${typeId}-saniert`, host);
  const copy: LayeredType = { id, name, layers: src.layers.map((l) => ({ ...l })) };
  return { ops: [...addItems(HOST[host].types, [copy] as never), ...setTypePairOps(project, typeId, { target: id, old: null, new: null }, host)], id };
}

/** Ops: Typ-Paar am Bestandstyp ändern (Sanierungstyp, Bezugsseite, manuelle Zuordnung; `null` entfernt). */
export function setTypePairOps(
  project: Project,
  typeId: string,
  patch: { target?: string | null; side?: RenovationSide | null; old?: LayerRenovation[] | null; new?: LayerRenovation[] | null; core?: number | null },
  host: RenovationHost = "wall",
): CoreOp[] {
  return patchItem(project, HOST[host].types, typeId, ((t: LayeredType) => {
    const next: LayeredType = { ...t };
    const put = <K extends keyof LayeredType>(k: K, v: LayeredType[K] | null | undefined) => {
      if (v === undefined) return;
      if (v === null || (Array.isArray(v) && v.every((x) => x === "auto"))) delete next[k];
      else next[k] = v;
    };
    put("renovationTarget", patch.target);
    put("renovationSide", patch.side === "inside" ? null : patch.side);
    put("renovationOld", patch.old);
    put("renovationNew", patch.new);
    // [286] Dominante Schicht an Ecken (Index der Bestandsschicht; nur Wandtypen).
    put("renovationCore", patch.core);
    return next;
  }) as never);
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
  kind: RenovationHost;
  type: string;
  target: string;
  side: RenovationSide;
  old: RenovationPairLayer[];
  new: RenovationPairLayer[];
  oldStrip: RenovationStripPiece[];
  newStrip: RenovationStripPiece[];
  result: RenovationStripPiece[];
  /** Elemente des Bestandstyps bzw. davon mit diesem Sanierungstyp saniert. */
  elements: number;
  renovated: number;
  /** [286] Nur Wände: dominante Schicht an Ecken (Index in `old`) — wirksam, Vorgabe, gewählt (`null` = automatisch). */
  core?: number | null;
  coreAuto?: number | null;
  coreSet?: number | null;
}

/** Typ-Paar Bestandstyp → Sanierungstyp (`target` fehlt = eingetragener); `null` ohne gültiges Paar. */
export function renovationPair(project: Project, typeId: string, target?: string, host: RenovationHost = "wall"): RenovationPair | null {
  return documentFor(project).query<RenovationPair | null>("renovationPair", [], JSON.stringify({ type: typeId, target: target ?? "", kind: host }));
}

export interface RenovationPairsInfo {
  pairs: { kind: RenovationHost; type: string; name: string; target: string; targetName: string | null; elements: number; renovated: number }[];
  renovated: number;
}

/** Alle Typ-Paare (Wände, Decken, Dächer) mit Zählern (Umbau-Panel „Sanierung“). */
export function renovationPairs(project: Project): RenovationPairsInfo {
  return documentFor(project).query<RenovationPairsInfo>("renovationPairs");
}

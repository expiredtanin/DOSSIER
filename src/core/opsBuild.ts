// Op-Bauhelfer ([K4] S3, zweite Etappe): Aktionen beschreiben ihre Änderung direkt als
// {@link CoreOp}s statt als Projekt → Projekt-Funktion, die `setProject` erst per `diffToOps` über
// alle Listen zurückübersetzen muss (bei 3000 Wänden ≈ 2,4 ms je Mausschritt). Die Helfer lesen
// nur das betroffene Element; unveränderte Elemente bleiben unberührt (Identität in der
// TS-Leseansicht, `applyOps`).
//
// Store: `applyChange(ops | (p) => ops, coalesceKey?)`. Wo eine Schnittstelle weiter eine
// Projekt → Projekt-Funktion erwartet (Befehle: `CommandResult.commit`), trägt
// {@link opsMutation} die Ops mit — `setProject` nimmt dann die Ops ohne Differenz.

import type { Project } from "../model/types";
import { applyOps, diffToOps } from "./ops";
import type { CoreOp } from "./ops";

/** Projekt-Felder, die Listen von Elementen mit `id` sind (walls, drawings2d, rooms, …). */
export type EntityCollection = {
  [K in keyof Project]-?: NonNullable<Project[K]> extends readonly (infer E)[]
    ? E extends { id: string }
      ? K
      : never
    : never;
}[keyof Project];

/** Elementtyp einer Liste. */
export type EntityOf<K extends EntityCollection> = NonNullable<Project[K]> extends readonly (infer E)[] ? E : never;

type AnyEntity = { id: string } & Record<string, unknown>;

/** Die Liste `collection` (fehlend = leer). */
export function itemsOf<K extends EntityCollection>(p: Project, collection: K): readonly EntityOf<K>[] {
  const v = (p as unknown as Record<string, unknown>)[collection];
  return Array.isArray(v) ? (v as EntityOf<K>[]) : [];
}

/** Element `id` aus `collection` (erstes Vorkommen). */
export function findItem<K extends EntityCollection>(p: Project, collection: K, id: string): EntityOf<K> | undefined {
  return itemsOf(p, collection).find((e) => (e as { id: string }).id === id);
}

/** Ersetzt ein Element (gleiche id, Position bleibt). */
export function replaceItem<K extends EntityCollection>(collection: K, entity: EntityOf<K>): CoreOp {
  return { kind: "replace", collection, entity: entity as unknown as AnyEntity };
}

/**
 * Ändert Element `id` in `collection`: `patch` als Teilobjekt (`{ ...e, ...patch }`) oder Funktion.
 * Leer, wenn das Element fehlt oder die Funktion dasselbe Objekt zurückgibt (keine Änderung).
 */
export function patchItem<K extends EntityCollection>(
  p: Project,
  collection: K,
  id: string,
  patch: Partial<EntityOf<K>> | ((e: EntityOf<K>) => EntityOf<K>),
): CoreOp[] {
  const old = findItem(p, collection, id);
  if (old === undefined) return [];
  const next = typeof patch === "function" ? patch(old) : ({ ...old, ...patch } as EntityOf<K>);
  return next === old ? [] : [replaceItem(collection, next)];
}

/**
 * Ändert alle Elemente, deren id in `ids` liegt (bzw. für die `ids(e)` wahr ist), mit `fn`; eine
 * `replace`-Op je tatsächlich geändertem Element, in Listen-Reihenfolge.
 */
export function patchItems<K extends EntityCollection>(
  p: Project,
  collection: K,
  ids: ReadonlySet<string> | readonly string[] | ((e: EntityOf<K>) => boolean),
  fn: (e: EntityOf<K>) => EntityOf<K>,
): CoreOp[] {
  const hit = idTest(ids);
  const ops: CoreOp[] = [];
  for (const e of itemsOf(p, collection)) {
    if (!hit(e)) continue;
    const next = fn(e);
    if (next !== e) ops.push(replaceItem(collection, next));
  }
  return ops;
}

/** Fügt Elemente an `at` (Default: Ende) ein; leer ohne Elemente. */
export function addItems<K extends EntityCollection>(collection: K, items: readonly EntityOf<K>[], at?: number): CoreOp[] {
  if (items.length === 0) return [];
  const op: CoreOp = { kind: "add", collection, items: items as unknown as AnyEntity[] };
  if (at !== undefined) op.at = at;
  return [op];
}

/** Entfernt die Elemente aus `ids` (bzw. für die `ids(e)` wahr ist), die es gibt; leer, wenn keines trifft. */
export function removeItems<K extends EntityCollection>(
  p: Project,
  collection: K,
  ids: ReadonlySet<string> | readonly string[] | ((e: EntityOf<K>) => boolean),
): CoreOp[] {
  const hit = idTest(ids);
  const drop: string[] = [];
  const seen = new Set<string>();
  for (const e of itemsOf(p, collection)) {
    const id = (e as { id: string }).id;
    if (hit(e) && !seen.has(id)) {
      seen.add(id);
      drop.push(id);
    }
  }
  return drop.length ? [{ kind: "remove", collection, ids: drop }] : [];
}

/**
 * Ersetzt Elemente durch je eine Liste neuer Elemente AN DERSELBEN STELLE (Zeichenreihenfolge bleibt;
 * leere Liste = Element entfernen). Ein Eintrag, der nur das Original selbst enthält (gleiche
 * Referenz), ändert nichts. Ein `remove` für alle ersetzten, danach je ein `add` an der Endposition
 * (aufsteigend), sodass `applyOps` die Liste so liefert, als wäre sie in einem Zug neu aufgebaut worden.
 */
export function replaceWithMany<K extends EntityCollection>(
  p: Project,
  collection: K,
  replacements: ReadonlyMap<string, readonly EntityOf<K>[]>,
): CoreOp[] {
  const dropped: string[] = [];
  const inserts: { at: number; items: readonly EntityOf<K>[] }[] = [];
  let len = 0; // Länge der Liste nach dem Entfernen = Position im Ergebnis
  for (const e of itemsOf(p, collection)) {
    const id = (e as { id: string }).id;
    const items = replacements.get(id);
    if (items === undefined || (items.length === 1 && items[0] === e)) {
      len++;
      continue;
    }
    dropped.push(id);
    if (items.length > 0) inserts.push({ at: len, items });
    len += items.length;
  }
  if (dropped.length === 0) return [];
  const ops: CoreOp[] = [{ kind: "remove", collection, ids: dropped }];
  for (const ins of inserts) ops.push(...addItems(collection, ins.items, ins.at));
  return ops;
}

/** Setzt ein Projekt-Feld (`undefined` ⇒ Feld entfernen). */
export function setField<K extends keyof Project>(key: K, value: Project[K] | undefined): CoreOp {
  return value === undefined ? { kind: "setField", key } : { kind: "setField", key, value };
}

/** Setzt ein Projekt-Feld nur, wenn sich der Wert (per Referenz) ändert. */
export function setFieldIfChanged<K extends keyof Project>(p: Project, key: K, value: Project[K] | undefined): CoreOp[] {
  return p[key] === value ? [] : [setField(key, value)];
}

function idTest<E>(ids: ReadonlySet<string> | readonly string[] | ((e: E) => boolean)): (e: E) => boolean {
  if (typeof ids === "function") return ids;
  const set = ids instanceof Set ? ids : new Set(ids as readonly string[]);
  return (e) => set.has((e as unknown as { id: string }).id);
}

// ── Projekt → Projekt mit mitgeführten Ops ─────────────────────────────────

/** Projekt → Projekt-Funktion, die ihre Ops mitträgt (s. {@link opsMutation}). */
export type ProjectMutation = ((p: Project) => Project) & { readonly toOps: (p: Project) => CoreOp[] };

/**
 * Verpackt einen Op-Bauer als Projekt → Projekt-Funktion (für Schnittstellen wie
 * `CommandResult.commit`). Aufgerufen liefert sie `applyOps(p, build(p))`; `setProject` erkennt
 * sie an `toOps` und übergibt die Ops ohne `diffToOps` an den Kern.
 */
export function opsMutation(build: (p: Project) => CoreOp[]): ProjectMutation {
  const fn = (p: Project): Project => applyOps(p, build(p));
  return Object.assign(fn, { toOps: build });
}

/** Ob `fn` ihre Ops mitträgt. */
export function isOpsMutation(fn: unknown): fn is ProjectMutation {
  return typeof fn === "function" && typeof (fn as Partial<ProjectMutation>).toOps === "function";
}

/**
 * Ops, die das Feld `key` auf `value` bringen — für KLEINE Listen, die eine Hilfsfunktion als Ganzes
 * neu liefert (Ebenen nach `recomputeFloorElevations`, Kategorien-Baum …): Differenz nur über
 * dieses eine Feld (Elemente mit id einzeln, sonst `setField`). Grosse Listen (Wände, 2D) gehören
 * über {@link patchItem}/{@link patchItems}/{@link addItems}/{@link removeItems}.
 */
export function fieldOps<K extends keyof Project>(p: Project, key: K, value: Project[K] | undefined): CoreOp[] {
  if (p[key] === value) return [];
  const before = { [key]: p[key] } as unknown as Project;
  const after = (value === undefined ? {} : { [key]: value }) as unknown as Project;
  return diffToOps(before, after);
}

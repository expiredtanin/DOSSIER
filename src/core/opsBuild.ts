// Op-Bauhelfer ([K4] S3, zweite Etappe): Aktionen beschreiben ihre Änderung direkt als
// {@link CoreOp}s statt als Projekt → Projekt-Funktion (früher übersetzte `setProject` sie per
// Projekt-Differenz zurück: bei 3000 Wänden ≈ 2,4 ms je Mausschritt; die Differenz ist gelöscht). Die Helfer lesen
// nur das betroffene Element; unveränderte Elemente bleiben unberührt (Identität in der
// TS-Leseansicht, `applyOps`).
//
// Store: `applyChange(ops | (p) => ops, coalesceKey?)`. Wo eine Schnittstelle weiter eine
// Projekt → Projekt-Funktion erwartet (Befehle: `CommandResult.commit`), trägt
// {@link opsMutation} die Ops mit — `setProject` nimmt dann die Ops ohne Differenz.

import type { Project } from "../model/types";
import { applyOps } from "./ops";
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
/** Gleich auf erster Ebene (gleiche Schlüssel, gleiche Werte per `===`): ein „Patch" auf denselben Wert
 *  ergibt dann keine Op und damit keinen leeren Undo-Schritt. */
function sameShallow(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if ((a as Record<string, unknown>)[k] !== (b as Record<string, unknown>)[k]) return false;
  }
  return true;
}

export function patchItem<K extends EntityCollection>(
  p: Project,
  collection: K,
  id: string,
  patch: Partial<EntityOf<K>> | ((e: EntityOf<K>) => EntityOf<K>),
): CoreOp[] {
  const old = findItem(p, collection, id);
  if (old === undefined) return [];
  const next = typeof patch === "function" ? patch(old) : ({ ...old, ...patch } as EntityOf<K>);
  return sameShallow(next, old) ? [] : [replaceItem(collection, next)];
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
    if (!sameShallow(next, e)) ops.push(replaceItem(collection, next));
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
 * `CommandResult.commit`). Aufgerufen liefert sie `applyOps(p, build(p))`; `setProject` übergibt
 * ihre `toOps` an den Kern.
 */
export function opsMutation(build: (p: Project) => CoreOp[]): ProjectMutation {
  const fn = (p: Project): Project => applyOps(p, build(p));
  return Object.assign(fn, { toOps: build });
}

/**
 * Ops, die das Feld `key` auf `value` bringen — für KLEINE Listen, die eine Hilfsfunktion als Ganzes
 * neu liefert (Ebenen nach `recomputeFloorElevations`, Kategorien-Baum …): Differenz nur über
 * dieses eine Feld (Elemente mit id einzeln: `remove`/`replace`/`reorder`/`add`, sonst `setField`).
 * `applyOps(p, fieldOps(p, key, v))[key]` ist inhaltlich `v`, Elemente aus `v` behalten ihre Identität.
 * Grosse Listen (Wände, 2D) gehören über {@link patchItem}/{@link patchItems}/{@link addItems}/{@link removeItems}.
 */
export function fieldOps<K extends keyof Project>(p: Project, key: K, value: Project[K] | undefined): CoreOp[] {
  const va = p[key] as unknown;
  const vb = value as unknown;
  if (va === vb) return [];
  // Häufigster Fall (eine Änderung in einer grossen Liste): Elemente an Ort und Stelle ersetzt,
  // gleiche ids — ein Durchgang ohne Mengen und Kopien (10 000 Zeichnungen: ~18 → ~1 ms).
  if (Array.isArray(vb) && Array.isArray(va) && va.length === vb.length && uniqueIdList(va)) {
    const changed = replacedInPlace(va as AnyEntity[], vb);
    if (changed) {
      knownUnique.set(vb, true);
      return changed.map((entity) => ({ kind: "replace", collection: key, entity }));
    }
  }
  if (uniqueIdList(va) && uniqueIdList(vb)) return diffList(key, va as AnyEntity[], vb as AnyEntity[]);
  return [vb === undefined ? { kind: "setField", key } : { kind: "setField", key, value: vb }];
}

/** Liste → ob sie eine id-Liste mit eindeutigen ids ist (Projektdaten werden nicht verändert). */
const knownUnique = new WeakMap<object, boolean>();

function uniqueIdList(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  let r = knownUnique.get(v);
  if (r === undefined) {
    r = isIdList(v) && uniqueIds(v);
    knownUnique.set(v, r);
  }
  return r;
}

/** Die ersetzten Elemente, wenn `vb` sich von `va` nur durch Elemente mit gleicher id an gleicher Stelle unterscheidet, sonst `null`. */
function replacedInPlace(va: AnyEntity[], vb: unknown[]): AnyEntity[] | null {
  const out: AnyEntity[] = [];
  for (let i = 0; i < va.length; i++) {
    const b = vb[i];
    if (b === va[i]) continue;
    if (b === null || typeof b !== "object" || (b as AnyEntity).id !== va[i].id) return null;
    out.push(b as AnyEntity);
  }
  return out;
}

const isEntityList = (v: unknown): v is AnyEntity[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => x !== null && typeof x === "object" && typeof (x as AnyEntity).id === "string");

/** Ob `v` eine (auch leere) Liste ist, deren Elemente — falls vorhanden — alle `id`s tragen. */
const isIdList = (v: unknown): v is AnyEntity[] => Array.isArray(v) && (v.length === 0 || isEntityList(v));

/** Eindeutige ids? (Voraussetzung für die Element-Ops.) */
function uniqueIds(list: AnyEntity[]): boolean {
  const seen = new Set<string>();
  for (const e of list) {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
  }
  return true;
}

function diffList(collection: string, va: AnyEntity[], vb: AnyEntity[]): CoreOp[] {
  const ops: CoreOp[] = [];
  const inB = new Set(vb.map((e) => e.id));
  const mapA = new Map(va.map((e) => [e.id, e]));
  const removed = va.filter((e) => !inB.has(e.id)).map((e) => e.id);
  if (removed.length) ops.push({ kind: "remove", collection, ids: removed });
  // Geänderte Elemente (gleiche id, andere Referenz).
  for (const e of vb) {
    const old = mapA.get(e.id);
    if (old !== undefined && old !== e) ops.push({ kind: "replace", collection, entity: e });
  }
  // Reihenfolge der behaltenen Elemente in vb.
  const kept = va.filter((e) => inB.has(e.id)).map((e) => e.id);
  const keptSet = new Set(kept);
  const keptInB = vb.map((e) => e.id).filter((id) => keptSet.has(id));
  if (keptInB.some((id, idx) => id !== kept[idx])) ops.push({ kind: "reorder", collection, ids: keptInB });
  // Neue Elemente: zusammenhängende Läufe, von links nach rechts direkt an ihrer Zielposition
  // in `vb` eingefügt (frühere Läufe stehen dann schon, die Position stimmt).
  let i = 0;
  while (i < vb.length) {
    if (keptSet.has(vb[i].id)) {
      i++;
      continue;
    }
    const at = i;
    const run: AnyEntity[] = [];
    while (i < vb.length && !keptSet.has(vb[i].id)) run.push(vb[i++]);
    ops.push({ kind: "add", collection, items: run, at });
  }
  return ops;
}

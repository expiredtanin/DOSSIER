// Änderungen am Projekt als DATEN (Phase B der Kern/UI-Trennung, docs/core-ui-split.md;
// lessons-bimcraft [6]/[8], Grundlage für [7] und [16]).
//
// Die interaktive Befehlslogik (Schritte, Prompts, Vorschau, Panels, Griffe) bleibt in der Hülle
// und liefert weiterhin Projekt → Projekt-Funktionen. `setProject` übersetzt jede Änderung
// über {@link diffToOps} in eine Folge von {@link CoreOp}s und wendet SIE mit {@link applyOps}
// an — das Projekt ändert sich ausschliesslich durch Ops. Ops sind JSON-serialisierbar
// (Undo-Verlauf [84], Makros [85], MCP [9], später ein Rust-Kern).
//
// Granularität (bewusst grob, aber stabil):
//  • Listen aus Elementen mit `id` (walls, ceilings, drawings2d, …): `add` / `replace` / `remove`
//    / `reorder` je Element — unveränderte Elemente behalten ihre Objekt-Identität
//    (structural sharing, billiger Änderungstest für Plan/Schnitt/3D).
//  • Alles andere (Skalare, Objekte, Listen ohne ids): `setField` mit dem ganzen Wert.

import type { Project } from "../model/types";

type Entity = { id: string } & Record<string, unknown>;

export type CoreOp =
  /** Fügt Elemente an `at` (Default: Ende) in die Liste `collection` ein. */
  | { kind: "add"; collection: string; items: Entity[]; at?: number }
  /** Ersetzt das Element mit `entity.id` in `collection` (Position bleibt). */
  | { kind: "replace"; collection: string; entity: Entity }
  /** Entfernt Elemente per id. */
  | { kind: "remove"; collection: string; ids: string[] }
  /** Setzt die Reihenfolge der Liste (`ids` ist eine Permutation der vorhandenen ids). */
  | { kind: "reorder"; collection: string; ids: string[] }
  /** Setzt ein Projekt-Feld auf `value` (`undefined`/fehlend ⇒ Feld entfernen). */
  | { kind: "setField"; key: string; value?: unknown };

const isEntityList = (v: unknown): v is Entity[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => x !== null && typeof x === "object" && typeof (x as Entity).id === "string");

/** Ob `v` eine (auch leere) Liste ist, deren Elemente — falls vorhanden — alle `id`s tragen. */
const isIdList = (v: unknown): v is Entity[] => Array.isArray(v) && (v.length === 0 || isEntityList(v));

/** Eindeutige ids? (Voraussetzung für die Element-Ops.) */
function uniqueIds(list: Entity[]): boolean {
  const seen = new Set<string>();
  for (const e of list) {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
  }
  return true;
}

/**
 * Berechnet die Ops, die `prev` in `next` überführen. `applyOps(prev, diffToOps(prev, next))`
 * ist inhaltlich gleich `next` (Test), Elemente aus `next` behalten ihre Identität.
 */
export function diffToOps(prev: Project, next: Project): CoreOp[] {
  if (prev === next) return [];
  const ops: CoreOp[] = [];
  const a = prev as unknown as Record<string, unknown>;
  const b = next as unknown as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    const va = a[key];
    const vb = b[key];
    if (va === vb) continue;
    if (isIdList(va) && isIdList(vb) && uniqueIds(va) && uniqueIds(vb)) {
      diffList(key, va, vb, ops);
    } else {
      ops.push(vb === undefined ? { kind: "setField", key } : { kind: "setField", key, value: vb });
    }
  }
  return ops;
}

function diffList(collection: string, va: Entity[], vb: Entity[], ops: CoreOp[]): void {
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
    const run: Entity[] = [];
    while (i < vb.length && !keptSet.has(vb[i].id)) run.push(vb[i++]);
    ops.push({ kind: "add", collection, items: run, at });
  }
}

/** Wendet eine Op-Folge rein an (kein Zugriff auf Store/UI). */
export function applyOps(project: Project, ops: readonly CoreOp[]): Project {
  let cur = project as unknown as Record<string, unknown>;
  for (const op of ops) cur = applyOne(cur, op);
  return cur as unknown as Project;
}

function listOf(cur: Record<string, unknown>, collection: string): Entity[] {
  const v = cur[collection];
  return Array.isArray(v) ? (v as Entity[]) : [];
}

function applyOne(cur: Record<string, unknown>, op: CoreOp): Record<string, unknown> {
  switch (op.kind) {
    case "setField": {
      const next = { ...cur };
      if (op.value === undefined) delete next[op.key];
      else next[op.key] = op.value;
      return next;
    }
    case "add": {
      const list = listOf(cur, op.collection);
      const at = op.at === undefined ? list.length : Math.max(0, Math.min(list.length, op.at));
      return { ...cur, [op.collection]: [...list.slice(0, at), ...op.items, ...list.slice(at)] };
    }
    case "replace": {
      const list = listOf(cur, op.collection);
      const idx = list.findIndex((e) => e.id === op.entity.id);
      if (idx < 0) return { ...cur, [op.collection]: [...list, op.entity] };
      const out = list.slice();
      out[idx] = op.entity;
      return { ...cur, [op.collection]: out };
    }
    case "remove": {
      const drop = new Set(op.ids);
      return { ...cur, [op.collection]: listOf(cur, op.collection).filter((e) => !drop.has(e.id)) };
    }
    case "reorder": {
      const list = listOf(cur, op.collection);
      const byId = new Map(list.map((e) => [e.id, e]));
      const ordered = op.ids.map((id) => byId.get(id)).filter((e): e is Entity => e !== undefined);
      const inOps = new Set(op.ids);
      return { ...cur, [op.collection]: [...ordered, ...list.filter((e) => !inOps.has(e.id))] };
    }
  }
}

// ── Validierung ([7]) ────────────────────────────────────────────────────────

/**
 * Prüft ein Projekt auf Verstösse, die nie gewollt sind: nicht endliche Zahlen in Geometrie
 * und doppelte ids innerhalb einer Liste. Liefert Meldungen (leer = gültig). Bewusst
 * konservativ — gesperrt wird nur, was sicher kaputt ist.
 */
export function validateProject(p: Project): string[] {
  const problems: string[] = [];
  const rec = p as unknown as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const v = rec[key];
    if (!isIdList(v) || v.length === 0) continue;
    if (!uniqueIds(v)) problems.push(`Doppelte ids in „${key}".`);
    // Nicht endliche Zahlen in den Elementen (flache Suche bis Tiefe 3, ohne grosse Zahlenfelder).
    for (const e of v) {
      const bad = findNonFinite(e, 0);
      if (bad) {
        problems.push(`„${key}" ${e.id}: ${bad} ist nicht endlich.`);
        break;
      }
    }
  }
  return problems;
}

/**
 * Wie {@link validateProject}, aber nur für das, was `ops` anfassen (billig genug für jeden
 * Maus-Schritt eines Drags): nicht endliche Zahlen in neuen/ersetzten Elementen, doppelte ids
 * in den betroffenen Listen, nicht endliche `setField`-Zahlen.
 */
export function validateOps(after: Project, ops: readonly CoreOp[], before?: Project): string[] {
  const beforeRec = before as unknown as Record<string, unknown> | undefined;
  /** Alt-Dateien mit doppelten ids sollen weiter änderbar bleiben: nur NEUE Doppelungen melden. */
  const hadDup = (key: string) => {
    const l = beforeRec?.[key];
    return isIdList(l) && !uniqueIds(l);
  };
  const problems: string[] = [];
  const rec = after as unknown as Record<string, unknown>;
  const dupChecked = new Set<string>();
  for (const op of ops) {
    if (op.kind === "add" || op.kind === "replace") {
      const ents = op.kind === "add" ? op.items : [op.entity];
      for (const e of ents) {
        const bad = findNonFinite(e, 0);
        if (bad) problems.push(`„${op.collection}" ${e.id}: ${bad} ist nicht endlich.`);
      }
      if (op.kind === "add" && !dupChecked.has(op.collection)) {
        dupChecked.add(op.collection);
        const list = rec[op.collection];
        if (isIdList(list) && !uniqueIds(list) && !hadDup(op.collection)) problems.push(`Doppelte ids in „${op.collection}".`);
      }
    } else if (op.kind === "setField") {
      if (typeof op.value === "number" && !Number.isFinite(op.value)) {
        problems.push(`Feld „${op.key}": ${String(op.value)} ist nicht endlich.`);
      } else if (isEntityList(op.value) && !uniqueIds(op.value) && !hadDup(op.key)) {
        problems.push(`Doppelte ids in „${op.key}".`);
      }
    }
  }
  return problems;
}

function findNonFinite(v: unknown, depth: number): string | null {
  if (typeof v === "number") return Number.isFinite(v) ? null : String(v);
  if (depth > 3 || v === null || typeof v !== "object") return null;
  if (Array.isArray(v)) {
    if (v.length > 5000) return null; // Mesh-Arrays: nicht durchlaufen
    for (const x of v) {
      const r = findNonFinite(x, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const x of Object.values(v as Record<string, unknown>)) {
    const r = findNonFinite(x, depth + 1);
    if (r) return r;
  }
  return null;
}

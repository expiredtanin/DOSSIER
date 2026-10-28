// Änderungen am Projekt als DATEN (Phase B der Kern/UI-Trennung, docs/core-ui-split.md;
// lessons-bimcraft [6]/[8], Grundlage für [7] und [16]).
//
// Die interaktive Befehlslogik (Schritte, Prompts, Vorschau, Panels, Griffe) bleibt in der Hülle
// und liefert weiterhin Projekt → Projekt-Funktionen. `setProject` übersetzt jede Änderung
// über {@link diffToOps} in eine Folge von {@link CoreOp}s und wendet SIE mit {@link applyOps}
// an — das Projekt ändert sich ausschliesslich durch Ops. Ops sind JSON-serialisierbar
// (Undo-Verlauf [84], Makros [85], MCP [9], später ein Rust-Kern).
//
// [K4] S3: Prüfung (`validateOps`/`validateProject`), Anwendung mit Verlauf und Undo/Redo liegen im
// Rust-Kern (`src-tauri/core/src/ops.rs`, `document.rs`). Hier bleiben `diffToOps` (Adapter für die
// Befehle, die noch Projekt → Projekt liefern) und `applyOps` als Nachführung der TS-Leseansicht:
// TS wendet genau die Ops an, die der Kern angenommen oder für Undo/Redo geliefert hat —
// unveränderte Elemente behalten so ihre Objekt-Identität (Caches in Plan/3D).
//
// Granularität (bewusst grob, aber stabil):
//  • Listen aus Elementen mit `id` (walls, ceilings, drawings2d, …): `add` / `replace` / `remove`
//    / `reorder` je Element — unveränderte Elemente behalten ihre Objekt-Identität
//    (structural sharing, billiger Änderungstest für Plan/Schnitt/3D).
//  • Alles andere (Skalare, Objekte, Listen ohne ids): `setField` mit dem ganzen Wert.

import type { Project } from "../model/types";
import { core } from "../engine/coreWasm";

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
  /** Setzt ein Projekt-Feld auf `value` (`undefined`/fehlend ⇒ Feld entfernen). `at`: Position, falls
   *  das Feld neu eingefügt wird (vom Kern-Undo gesetzt, damit die Feld-Reihenfolge exakt zurückkommt). */
  | { kind: "setField"; key: string; value?: unknown; at?: number };

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

/**
 * Wendet eine Op-Folge rein an (kein Zugriff auf Store/UI). Unberührte Listen und Elemente behalten
 * ihre Identität. Innerhalb eines Aufrufs wird jede Liste höchstens einmal kopiert und für
 * `replace`-Serien (Auswahl verschieben: hunderte Elemente) über einen id-Index angesprochen —
 * Ergebnis gleich der einfachen Fassung (Test `ops.apply.test.ts`).
 */
export function applyOps(project: Project, ops: readonly CoreOp[]): Project {
  if (ops.length === 0) return project;
  const st: ApplyState = { cur: { ...(project as unknown as Record<string, unknown>) }, owned: new Set(), index: new Map() };
  for (const op of ops) applyOne(st, op);
  return st.cur as unknown as Project;
}

/** Zustand eines `applyOps`-Aufrufs: `cur` ist eine eigene Kopie der obersten Ebene; Listen in
 *  `owned` wurden in diesem Aufruf neu angelegt (dürfen verändert werden), `index` = id → Position
 *  (erstes Vorkommen) solcher Listen. */
interface ApplyState {
  cur: Record<string, unknown>;
  owned: Set<string>;
  /** `null` = einmal linear gesucht, der Index wird bei der nächsten Suche gebaut. */
  index: Map<string, Map<string, number> | null>;
}

function listOf(cur: Record<string, unknown>, collection: string): Entity[] {
  const v = cur[collection];
  return Array.isArray(v) ? (v as Entity[]) : [];
}

/** Setzt `collection` auf eine neue (eigene) Liste; ein vorhandener Index verfällt. */
function putList(st: ApplyState, collection: string, list: Entity[]): void {
  st.cur[collection] = list;
  st.owned.add(collection);
  st.index.delete(collection);
}

function applyOne(st: ApplyState, op: CoreOp): void {
  const cur = st.cur;
  switch (op.kind) {
    case "setField": {
      // Der Wert gehört dem Aufrufer: nie verändern.
      st.owned.delete(op.key);
      st.index.delete(op.key);
      if (op.value !== undefined && op.at !== undefined && !(op.key in cur)) {
        // Neues Feld an Position `at` (wie `shift_insert` im Kern).
        const entries = Object.entries(cur);
        entries.splice(Math.max(0, Math.min(entries.length, op.at)), 0, [op.key, op.value]);
        st.cur = Object.fromEntries(entries);
        return;
      }
      if (op.value === undefined) delete cur[op.key];
      else cur[op.key] = op.value;
      return;
    }
    case "add": {
      const list = listOf(cur, op.collection);
      const at = op.at === undefined ? list.length : Math.max(0, Math.min(list.length, op.at));
      putList(st, op.collection, [...list.slice(0, at), ...op.items, ...list.slice(at)]);
      return;
    }
    case "replace": {
      const c = op.collection;
      let list: Entity[];
      if (st.owned.has(c)) list = cur[c] as Entity[];
      else {
        list = listOf(cur, c).slice();
        putList(st, c, list);
      }
      // Erste Suche in dieser Liste linear (ein Drag-Schritt), ab der zweiten über den Index.
      let idx = st.index.get(c);
      let at: number | undefined;
      if (idx === undefined) {
        st.index.set(c, null);
        const i = list.findIndex((e) => e?.id === op.entity.id);
        at = i < 0 ? undefined : i;
      } else {
        if (idx === null) {
          idx = new Map();
          for (let i = 0; i < list.length; i++) {
            const id = list[i]?.id;
            if (!idx.has(id)) idx.set(id, i);
          }
          st.index.set(c, idx);
        }
        at = idx.get(op.entity.id);
      }
      if (at === undefined) {
        idx?.set(op.entity.id, list.length);
        list.push(op.entity);
      } else list[at] = op.entity;
      return;
    }
    case "remove": {
      const drop = new Set(op.ids);
      putList(st, op.collection, listOf(cur, op.collection).filter((e) => !drop.has(e.id)));
      return;
    }
    case "reorder": {
      const list = listOf(cur, op.collection);
      const byId = new Map(list.map((e) => [e.id, e]));
      const ordered = op.ids.map((id) => byId.get(id)).filter((e): e is Entity => e !== undefined);
      const inOps = new Set(op.ids);
      putList(st, op.collection, [...ordered, ...list.filter((e) => !inOps.has(e.id))]);
      return;
    }
  }
}

// ── Übergabe an den Kern ─────────────────────────────────────────────────────

/** Nicht endliche Zahlen als Marken-Text (JSON kennt sie nicht; der Kern prüft sie, s. `ops.rs`). */
function markNonFinite(_key: string, v: unknown): unknown {
  return typeof v === "number" && !Number.isFinite(v) ? `\u0001${String(v)}` : v;
}

/** Ops als JSON für den Kern (NaN/±Infinity als Marken). */
export function opsToJson(ops: readonly CoreOp[]): string {
  return JSON.stringify(ops, markNonFinite);
}

// ── Validierung ([7]) — im Kern (`ops.rs`) ───────────────────────────────────

function problemsOf(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? (v as string[]) : [];
  } catch {
    return ["Prüfung im Kern fehlgeschlagen."];
  }
}

/**
 * Prüft ein Projekt auf Verstösse, die nie gewollt sind: nicht endliche Zahlen in Geometrie
 * und doppelte ids innerhalb einer Liste. Liefert Meldungen (leer = gültig). Bewusst
 * konservativ — gesperrt wird nur, was sicher kaputt ist.
 */
export function validateProject(p: Project): string[] {
  return problemsOf(core().project_validate(JSON.stringify(p, markNonFinite)));
}

/**
 * Prüft angewendete Ops (nur was sie anfassen, billig genug für jeden Drag-Schritt): nicht
 * endliche Zahlen in neuen/ersetzten Elementen und `setField`-Zahlen, NEUE doppelte ids in den
 * betroffenen Listen. Im Store läuft die Prüfung direkt im Kern-Dokument (`ProjectDocument.commit`).
 */
export function validateOps(after: Project, ops: readonly CoreOp[], before?: Project): string[] {
  const keys = new Set(ops.map((op) => (op.kind === "setField" ? op.key : op.collection)));
  const pick = (p: Project | undefined): string => {
    if (!p) return "";
    const rec = p as unknown as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of keys) if (k in rec) out[k] = rec[k];
    return JSON.stringify(out);
  };
  return problemsOf(core().ops_validate(opsToJson(ops), pick(after), pick(before)));
}

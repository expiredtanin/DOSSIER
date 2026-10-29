// Änderungen am Projekt als DATEN (Phase B der Kern/UI-Trennung, docs/core-ui-split.md;
// lessons-bimcraft [6]/[8], Grundlage für [7] und [16]).
//
// Die interaktive Befehlslogik (Schritte, Prompts, Vorschau, Panels, Griffe) bleibt in der Hülle
// und beschreibt jede Änderung als Folge von {@link CoreOp}s (Bauhelfer `opsBuild.ts`) — das
// Projekt ändert sich ausschliesslich durch Ops. Ops sind JSON-serialisierbar (Undo-Verlauf [84],
// Makros [85], MCP [9]). Ein anderes Projekt als Ganzes lädt der Kern (`ProjectDocument.load`/`loadFile`).
//
// [K4] S3: Prüfung (`validateOps`/`validateProject`), Anwendung mit Verlauf und Undo/Redo liegen im
// Rust-Kern (`src-tauri/core/src/ops.rs`, `document.rs`). Hier bleibt `applyOps` als Nachführung der
// TS-Leseansicht: TS wendet genau die Ops an, die der Kern angenommen oder für Undo/Redo geliefert
// hat — unveränderte Elemente behalten so ihre Objekt-Identität (Caches in Plan/3D).
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

/** Wert als JSON mit Nicht-endlich-Marken (wie {@link opsToJson}), z. B. Anfragen an den Kern. */
export function toMarkedJson(v: unknown): string {
  return JSON.stringify(v, markNonFinite);
}

/** Nicht-endlich-Marken des Kerns (`"\u0001NaN"` …) zurück in Zahlen. */
function reviveNonFinite(_key: string, v: unknown): unknown {
  if (typeof v !== "string" || v.charCodeAt(0) !== 1) return v;
  const t = v.slice(1);
  return t === "NaN" ? NaN : t === "Infinity" ? Infinity : t === "-Infinity" ? -Infinity : v;
}

/** JSON des Kerns lesen; Nicht-endlich-Marken werden wieder Zahlen (nur wenn welche vorkommen). */
export function fromMarkedJson<T>(text: string): T {
  return (text.includes("\\u0001") ? JSON.parse(text, reviveNonFinite) : JSON.parse(text)) as T;
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
 * Warnungen zu einem Projekt, das trotzdem geladen und gerechnet wird (Kern `project_refs.rs`):
 * hängende Verweise (Wandtyp, Bauteil, Geschoss, Schraffur, Linienstil, Stift, Gruppe, Layout …),
 * Gruppen/Ordner, die sich selbst enthalten, und Werte, die nicht zum Modell passen. Die
 * Ableitungen setzen dort Vorgaben ein; `dossier-cli validate` meldet die Liste.
 */
export function projectWarnings(p: Project): string[] {
  return problemsOf(core().project_warnings(JSON.stringify(p)));
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

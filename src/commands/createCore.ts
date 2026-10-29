// Brücke der Zeichenbefehle zum Kern ([K4] S3, `src-tauri/core/src/cmd_create.rs`): die Befehle halten
// nur noch ihre Zustandsautomaten (Klicks, Tasten, Optionen) und die gesetzten Punkte; die neuen
// Elemente (Vorgaben aus Typen/Stilen, abgeleitete Felder, ids), die Vorschau je Mausschritt und die
// Treffer zwischen den Schritten rechnet der Kern.

import type { Project, Vec2 } from "../model/types";
import type { CommandContext, DraftShape } from "./types";
import type { ProjectMutation } from "../core";
import { cmdMutation, documentFor } from "../core/document";
import { toMarkedJson } from "../core/ops";
import { uniqueStamp } from "../tools/types";
import { decodeShapes } from "../tools/coreCmd";

/** Vorschau eines Zeichenbefehls: Formen, ob ein Commit hier etwas erzeugte, Zusatzzahlen je Befehl. */
export interface CreatePreview {
  shapes: DraftShape[];
  ok: boolean;
  info: number[];
}

/** Kontext der Anfrage: aktive Ebene/Geschoss, Kategorie, Wandtyp. */
function ctxReq(ctx: CommandContext): object {
  return {
    level: ctx.level.id,
    floorHeight: ctx.level.floorHeight ?? null,
    cat: ctx.defaultCategoryCode,
    wallType: ctx.activeWallTypeId,
  };
}

/** Commit eines Zeichenbefehls: `req` = `{cmd, …}`; der Kern baut die Elemente (ids aus dem Stempel). */
export function createMutation(ctx: CommandContext, req: { cmd: string } & Record<string, unknown>): ProjectMutation {
  return cmdMutation({ ...req, ctx: ctxReq(ctx), stamp: uniqueStamp() });
}

/** Punkt als Paar (Anfragen an den Kern). */
export const xy = (p: Vec2): [number, number] => [p.x, p.y];

// Je Mausschritt ändern sich meist nur die Punkte: sind Optionen und Kontext (flach verglichen, Objekte und
// Listen per Referenz) dieselben wie beim letzten Aufruf, rechnet der Kern mit den gemerkten Optionen
// (kein JSON je Mausschritt). Punkte dürfen als Paar `[x, y]` oder als `{x, y}` reisen.
let lastReq: Record<string, unknown> | null = null;
let lastCtx: { level: string; floorHeight: unknown; cat: string; wallType: string } | null = null;

function sameReq(req: Record<string, unknown>, ctx: CommandContext): boolean {
  const c = lastCtx;
  if (!lastReq || !c) return false;
  if (c.level !== ctx.level.id || !Object.is(c.floorHeight, ctx.level.floorHeight) || c.cat !== ctx.defaultCategoryCode || c.wallType !== ctx.activeWallTypeId) return false;
  const ka = Object.keys(req);
  if (ka.length !== Object.keys(lastReq).length) return false;
  for (const k of ka) {
    const v = req[k];
    // Objekte/Listen per Referenz: die Zustände der Befehle sind unveränderlich (neue Liste je Klick).
    if (!Object.is(v, lastReq[k])) return false;
  }
  return true;
}

/** Vorschau eines Zeichenbefehls: `req` = Optionen, `pts` = die Punkte (je Befehl, zuletzt der Cursor). */
export function createPreview(ctx: CommandContext, req: { cmd: string } & Record<string, unknown>, pts: readonly Vec2[]): CreatePreview {
  const flat = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    flat[2 * i] = pts[i].x;
    flat[2 * i + 1] = pts[i].y;
  }
  let json: string | null = null;
  if (!sameReq(req, ctx)) {
    json = toMarkedJson({ ...req, ctx: ctxReq(ctx) });
    lastReq = req;
    lastCtx = { level: ctx.level.id, floorHeight: ctx.level.floorHeight, cat: ctx.defaultCategoryCode, wallType: ctx.activeWallTypeId };
  }
  const f = documentFor(ctx.project).createPreview(json, flat);
  if (f.length < 2) return { shapes: [], ok: false, info: [] };
  const n = f[1];
  return { ok: f[0] === 1, info: Array.from(f.subarray(2, 2 + n)), shapes: decodeShapes(f.subarray(2 + n)) };
}

/** Treffer-Abfrage eines Zeichenbefehls (`cmd_create::query`) auf dem Dokument von `project`. */
export function createQuery<T>(project: Project, req: { q: string } & Record<string, unknown>): T {
  return documentFor(project).createQuery<T>(req);
}

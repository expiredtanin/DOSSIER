// [154] Bauteile aus Zeichnung erkennen: aus den 2D-Linien eines Grundrisses (DXF/DWG-Import aus ArchiCAD,
// Vectorworks, AutoCAD) Wände, Öffnungen (Dreh-, Schiebe-, Hebeschiebetüren, Fenster, Durchbrüche), Stützen und Räume. Quelle: die gewählten 2D-Elemente, sonst die Zeichnung des
// aktiven Geschosses, sonst die erste Ebene mit Zeichnung (Option E schaltet durch). Beim Start zeigt die Vorschau
// alles Erkannte (Wandbänder, Türen/Fenster/Durchbrüche, Räume, unklare Stellen als Kreuz), die Meldung zählt;
// B zeigt den Bericht (unklar, mit Grund). Enter übernimmt als EIN Undo-Schritt ins aktive Geschoss (Höhe =
// Geschosshöhe). Die Erkennung rechnet der Kern (`drawing_recognize.rs`).

import type { CmdOption, Command, CommandContext, CommandResult, CommandState, ToolDraft, Vec2 } from "../types";
import { createPreview } from "../createCore";
import { t, type TranslationKey } from "../../i18n";
import { recognizeMutation, recognizeReport, recognizeSourceLevels } from "../../core";
import type { RecognizeOptions, RecognizeReport } from "../../core";

interface RecognizeState extends CommandState {
  /** Gewählte Quell-Ebene (Option E) und ihr Name für die Befehlszeile. */
  sticky: { src?: string; name?: string };
}

const selectedIds = (ctx: CommandContext): string[] =>
  ctx.selection.drawingIds ?? (ctx.selection.drawingId ? [ctx.selection.drawingId] : []);

/** Quell-Ebene: gewählt, sonst das aktive Geschoss (hat es Zeichnung), sonst die erste Zeichnungsebene. */
function sourceOf(s: RecognizeState, ctx: CommandContext): string {
  const list = recognizeSourceLevels(ctx.project);
  if (s.sticky?.src && list.includes(s.sticky.src)) return s.sticky.src;
  if (list.includes(ctx.level.id)) return ctx.level.id;
  const drawing = list.find((id) => ctx.project.drawingLevels.find((l) => l.id === id)?.kind === "drawing");
  return drawing ?? list[0] ?? ctx.level.id;
}

function optionsOf(s: RecognizeState, ctx: CommandContext): RecognizeOptions {
  return {
    levelId: ctx.level.id,
    floorHeight: ctx.level.floorHeight,
    sourceLevelId: sourceOf(s, ctx),
    ids: selectedIds(ctx),
    categoryCode: ctx.defaultCategoryCode,
    wallTypeId: ctx.activeWallTypeId,
    typeName: t("cmd.recognize.typeName"),
    roomName: t("cmd.recognize.roomName"),
    slideTypeName: t("cmd.recognize.slideTypeName"),
    liftSlideTypeName: t("cmd.recognize.liftSlideTypeName"),
  };
}

interface Evaluated {
  report: RecognizeReport;
  draft: ToolDraft;
}

// Je Mausschritt dieselbe Erkennung: gemerkt je Projektstand und Anfrage.
let cache: { project: unknown; key: string; value: Evaluated } | null = null;

function evaluate(s: RecognizeState, ctx: CommandContext): Evaluated {
  const o = optionsOf(s, ctx);
  const key = JSON.stringify(o);
  if (cache && cache.project === ctx.project && cache.key === key) return cache.value;
  const report = recognizeReport(ctx.project, o);
  const pv = createPreview(ctx, { cmd: "recognize", src: o.sourceLevelId, ids: o.ids, typeName: o.typeName, roomName: o.roomName }, []);
  const value = { report, draft: { preview: pv.shapes, vertices: [] } };
  cache = { project: ctx.project, key, value };
  return value;
}

const countParams = (r: RecognizeReport) => ({
  walls: r.walls,
  doors: r.doors,
  windows: r.windows,
  voids: r.voids,
  sliding: r.slidingDoors,
  columns: r.columns,
  rooms: r.rooms,
  unclear: r.unclear.length,
});

/** Kurzzeile am Cursor. */
const hudText = (r: RecognizeReport): string => t("cmd.recognize.hud", countParams(r));

/** Bericht: unklare Stellen je Grund gezählt. */
export function reportText(r: RecognizeReport): string {
  const by = new Map<string, number>();
  for (const u of r.unclear) by.set(u.code, (by.get(u.code) ?? 0) + 1);
  const parts = [...by].map(([code, n]) => `${n}× ${t(`cmd.recognize.reason.${code}` as TranslationKey)}`);
  const thick = r.thicknesses.map((x) => `${Math.round(x * 1000) / 10}`).join(" / ");
  const head = t("cmd.recognize.reportHead", { thick: thick || "—", filled: r.filledWalls, arcs: r.arcWalls, unnamed: r.unnamedRooms });
  const filter = r.layerFilter ? ` ${t("cmd.recognize.layerFilter")}` : "";
  return parts.length ? `${head}${filter} ${t("cmd.recognize.unclearList", { list: parts.join("; ") })}` : `${head}${filter} ${t("cmd.recognize.noUnclear")}`;
}

function show(s: RecognizeState, ctx: CommandContext): CommandResult {
  const { report, draft } = evaluate(s, ctx);
  if (report.walls === 0) return { draft: null, notice: { key: "cmd.recognize.nothing", kind: "warning" } };
  return { draft, notice: { key: "cmd.recognize.summary", params: countParams(report), kind: "info" } };
}

const done = (): [CommandState, CommandResult] => [{ phase: "confirm", lastPoint: null }, { draft: null, done: true }];

export const recognizeCommand: Command = {
  name: "erkennen",
  labelKey: "cmd.recognize.label",
  floorOnly: true,
  prompt: () => "cmd.recognize.prompt",
  accepts: () => ["option"],
  options: (state): CmdOption[] => {
    const s = state as RecognizeState;
    return [
      { id: "source", labelKey: "cmd.recognize.source", key: "E", value: s.sticky?.name ?? t("cmd.recognize.sourceAuto") },
      { id: "report", labelKey: "cmd.recognize.report", key: "B" },
    ];
  },
  precondition: (ctx) => (recognizeSourceLevels(ctx.project).length === 0 && selectedIds(ctx).length === 0 ? "cmd.recognize.noDrawing" : null),
  init: (): RecognizeState => ({ phase: "confirm", lastPoint: null, sticky: {} }),

  autoRun: (ctx) => show({ phase: "confirm", lastPoint: null, sticky: {} }, ctx),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as RecognizeState;
    if (input.kind === "option" && input.id === "source") {
      const list = recognizeSourceLevels(ctx.project);
      const cur = sourceOf(s, ctx);
      const next = list[(list.indexOf(cur) + 1) % Math.max(1, list.length)] ?? cur;
      const name = ctx.project.drawingLevels.find((l) => l.id === next)?.name;
      const ns: RecognizeState = { ...s, sticky: { src: next, name } };
      return [ns, show(ns, ctx)];
    }
    if (input.kind === "option" && input.id === "report") {
      const { report, draft } = evaluate(s, ctx);
      return [s, { draft, notice: { key: "cmd.recognize.reportNotice", params: { text: reportText(report) }, kind: "info" } }];
    }
    return [s, { draft: evaluate(s, ctx).draft }];
  },

  onMove: (state, point: Vec2, _snap, ctx): [CommandState, CommandResult] => {
    const { report, draft } = evaluate(state as RecognizeState, ctx);
    return [state, { draft: { ...draft, hud: { at: point, text: hudText(report) } } }];
  },

  onConfirm: (state, ctx): [CommandState, CommandResult] => {
    const s = state as RecognizeState;
    const { report } = evaluate(s, ctx);
    cache = null;
    if (report.walls === 0) return [s, { draft: null, done: true, notice: { key: "cmd.recognize.nothing", kind: "warning" } }];
    const commit = recognizeMutation(optionsOf(s, ctx));
    return [{ phase: "confirm", lastPoint: null }, { draft: null, done: true, commit, notice: { key: "cmd.recognize.done", params: countParams(report), kind: "info" } }];
  },
  onCancel: () => {
    cache = null;
    return done();
  },
};

// Solid — B-Rep-Grundkörper (truck): Kugel, Zylinder, Kegel, Torus, Quader. Der Körper wird als
// `ExtrudedSolid` mit `brep`-Spezifikation abgelegt (Grundriss-Fläche für Auswahl/2D-Umriss,
// Verschieben/Kopieren/Löschen laufen über die vorhandene Extrusions-Pipeline); gerendert
// und nach STEP exportiert wird die EXAKTE B-Rep-Geometrie (`SolidSpec`, trucksolid).
//
// Schritte je Form (Zahl tippen ODER in die Zeichnung klicken — ein Klick liefert das Mass
// als Abstand zum Mittelpunkt):
//   Kugel      Mittelpunkt → Radius
//   Zylinder   Mittelpunkt → Radius → Höhe
//   Kegel      Mittelpunkt → Radius → Höhe
//   Torus      Mittelpunkt → Hauptradius → Rohrradius
//   Quader     Ecke → Gegenecke → Höhe
// Der Körper steht auf der Geschoss-UK (Z = 0 lokal).

import type { ExtrudedSolid } from "../../model/types";
import { uniqueId } from "../../tools/types";
import type {
  Command,
  CommandResult,
  CommandState,
  CmdOption,
  DraftShape,
  Project,
  ToolDraft,
  Vec2,
} from "../types";

export type SolidShape = "sphere" | "cylinder" | "cone" | "frustum" | "torus" | "cuboid";

const SHAPE_OPTIONS: CmdOption[] = [
  { id: "sphere", labelKey: "cmd.solid.shape.sphere" },
  { id: "cylinder", labelKey: "cmd.solid.shape.cylinder" },
  { id: "cone", labelKey: "cmd.solid.shape.cone" },
  { id: "frustum", labelKey: "cmd.solid.shape.frustum" },
  { id: "torus", labelKey: "cmd.solid.shape.torus" },
  { id: "cuboid", labelKey: "cmd.solid.shape.cuboid" },
];
const SHAPE_IDS = new Set(SHAPE_OPTIONS.map((o) => o.id));

type Step = "center" | "radius" | "topRadius" | "height" | "major" | "minor" | "corner2";

/** Schrittfolge je Form (erste Eingabe ist immer ein Punkt: Mittelpunkt bzw. Ecke). */
const STEPS: Record<SolidShape, Step[]> = {
  sphere: ["center", "radius"],
  cylinder: ["center", "radius", "height"],
  cone: ["center", "radius", "height"],
  frustum: ["center", "radius", "topRadius", "height"],
  torus: ["center", "major", "minor"],
  cuboid: ["center", "corner2", "height"],
};

const PROMPT: Record<Step, string> = {
  center: "cmd.solid.center",
  radius: "cmd.solid.radius",
  topRadius: "cmd.solid.topRadius",
  height: "cmd.solid.height",
  major: "cmd.solid.major",
  minor: "cmd.solid.minor",
  corner2: "cmd.solid.corner2",
};

interface SolidState extends CommandState {
  shape: SolidShape;
  /** Index des aktuellen Schritts in {@link STEPS}. */
  stepIdx: number;
  /** Erster Punkt (Mittelpunkt/Ecke). */
  p0: Vec2 | null;
  /** Zweiter Punkt (nur Quader: Gegenecke). */
  p1: Vec2 | null;
  /** Gesammelte Zahlen (Radius/Höhe/…). */
  nums: number[];
  cursor: Vec2 | null;
}

/** Persistente Defaults über Aufrufe hinweg (Enter übernimmt sie). */
let lastShape: SolidShape = "sphere";

const circlePts = (c: Vec2, r: number): Vec2[] =>
  Array.from({ length: 48 }, (_, i) => {
    const t = (i / 48) * Math.PI * 2;
    return { x: c.x + r * Math.cos(t), y: c.y + r * Math.sin(t) };
  });

const rectPts = (a: Vec2, b: Vec2): Vec2[] => {
  const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
  const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
  return [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
};

/** Grundriss-Fläche, Körperhöhe und B-Rep-Spezifikation (lokales Z ab 0) einer Form. */
export function solidFromInputs(
  shape: SolidShape,
  p0: Vec2,
  p1: Vec2 | null,
  nums: number[],
): { points: Vec2[]; height: number; spec: Record<string, unknown>; label: string } | null {
  const fmt = (v: number) => v.toFixed(2);
  switch (shape) {
    case "sphere": {
      const r = nums[0];
      if (!(r > 1e-6)) return null;
      return {
        points: circlePts(p0, r),
        height: 2 * r,
        spec: { kind: "sphere", center: [p0.x, p0.y, r], r },
        label: `Kugel r=${fmt(r)}`,
      };
    }
    case "cylinder":
    case "cone": {
      const [r, h] = nums;
      if (!(r > 1e-6) || !(h > 1e-6)) return null;
      return {
        points: circlePts(p0, r),
        height: h,
        spec: { kind: shape, cx: p0.x, cy: p0.y, z0: 0, r, height: h },
        label: `${shape === "cone" ? "Kegel" : "Zylinder"} r=${fmt(r)} h=${fmt(h)}`,
      };
    }
    case "frustum": {
      const [r, rt, h] = nums;
      if (!(r > 1e-6) || !(rt > 1e-6) || !(h > 1e-6)) return null;
      return {
        points: circlePts(p0, Math.max(r, rt)),
        height: h,
        spec: { kind: "revolve", cx: p0.x, cy: p0.y, profile: [0, 0, r, 0, rt, h, 0, h] },
        label: `Kegelstumpf r=${fmt(r)}/${fmt(rt)} h=${fmt(h)}`,
      };
    }
    case "torus": {
      const [major, minor] = nums;
      if (!(minor > 1e-6) || !(major > minor)) return null;
      return {
        points: circlePts(p0, major + minor),
        height: 2 * minor,
        spec: { kind: "torus", center: [p0.x, p0.y, minor], major, minor },
        label: `Torus R=${fmt(major)} r=${fmt(minor)}`,
      };
    }
    case "cuboid": {
      const h = nums[0];
      if (!p1 || !(h > 1e-6)) return null;
      const pts = rectPts(p0, p1);
      const [w, d] = [Math.abs(p1.x - p0.x), Math.abs(p1.y - p0.y)];
      if (w < 1e-6 || d < 1e-6) return null;
      return {
        points: pts,
        height: h,
        spec: { kind: "cuboid", min: [pts[0].x, pts[0].y, 0], max: [pts[2].x, pts[2].y, h] },
        label: `Quader ${fmt(w)}×${fmt(d)}×${fmt(h)}`,
      };
    }
  }
}

function draftOf(s: SolidState): ToolDraft | null {
  if (!s.p0) return null;
  const step = STEPS[s.shape][s.stepIdx];
  const preview: DraftShape[] = [];
  let hud: string | undefined;
  const cur = s.cursor ?? s.p0;
  const dist = Math.hypot(cur.x - s.p0.x, cur.y - s.p0.y);
  if (s.shape === "cuboid") {
    const b = s.p1 ?? cur;
    preview.push({ kind: "poly", pts: rectPts(s.p0, b), closed: true });
    hud = s.p1 ? `h = ${(s.nums[0] ?? 0).toFixed(2)} m` : `${Math.abs(b.x - s.p0.x).toFixed(2)} × ${Math.abs(b.y - s.p0.y).toFixed(2)} m`;
  } else {
    const r = step === "radius" || step === "major" ? dist : (s.nums[0] ?? dist);
    if (s.shape === "frustum" && step !== "radius") {
      preview.push({ kind: "poly", pts: circlePts(s.p0, Math.max(step === "topRadius" ? dist : (s.nums[1] ?? dist), 0.01)), closed: true });
    }
    preview.push({ kind: "poly", pts: circlePts(s.p0, Math.max(r, 0.01)), closed: true });
    if (s.shape === "torus" && step === "minor") {
      preview.push({ kind: "poly", pts: circlePts(s.p0, (s.nums[0] ?? 0) + dist), closed: true });
    }
    hud = `${step === "height" ? "h" : step === "topRadius" ? "r2" : "r"} = ${dist.toFixed(2)} m`;
  }
  return { preview, vertices: [s.p0], hud: { at: cur, text: hud } };
}

const reset = (shape: SolidShape): SolidState => ({
  phase: "solid",
  shape,
  stepIdx: 0,
  p0: null,
  p1: null,
  nums: [],
  cursor: null,
  lastPoint: null,
});

export const solidCommand: Command = {
  name: "solid",
  labelKey: "cmd.solid.label",
  floorOnly: true,
  prompt: (st) => {
    const s = st as SolidState;
    return PROMPT[STEPS[s.shape][s.stepIdx]] as never;
  },
  accepts: () => ["point", "number", "option"],
  options: () => SHAPE_OPTIONS,
  init: (): SolidState => reset(lastShape),

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    const s = state as SolidState;
    if (input.kind === "option" && SHAPE_IDS.has(input.id)) {
      lastShape = input.id as SolidShape;
      // Form-Wechsel setzt die Schritte zurück (der Mittelpunkt bleibt, falls schon gesetzt).
      const ns: SolidState = { ...reset(lastShape), p0: s.p0, stepIdx: s.p0 ? 1 : 0, cursor: s.cursor };
      return [ns, { draft: draftOf(ns) }];
    }
    const steps = STEPS[s.shape];
    const step = steps[s.stepIdx];

    // 1) Mittelpunkt / erste Ecke
    if (step === "center") {
      if (input.kind !== "point") return [s, { draft: draftOf(s) }];
      const ns: SolidState = { ...s, p0: input.point, stepIdx: 1, cursor: input.point, lastPoint: input.point };
      return [ns, { draft: draftOf(ns) }];
    }

    // Wert des aktuellen Schritts: getippte Zahl oder Klick-Abstand zum Mittelpunkt.
    let value: number | null = null;
    if (input.kind === "number") value = Math.abs(input.value);
    else if (input.kind === "point" && s.p0 && step !== "corner2") {
      value = Math.hypot(input.point.x - s.p0.x, input.point.y - s.p0.y);
    }

    // Quader: Gegenecke als Punkt
    if (step === "corner2") {
      if (input.kind !== "point") return [s, { draft: draftOf(s) }];
      const ns: SolidState = { ...s, p1: input.point, stepIdx: s.stepIdx + 1, cursor: input.point };
      return [ns, { draft: draftOf(ns) }];
    }
    if (value === null || !(value > 1e-6)) return [s, { draft: draftOf(s) }];

    const nums = [...s.nums, value];
    if (s.stepIdx + 1 < steps.length) {
      const ns: SolidState = { ...s, nums, stepIdx: s.stepIdx + 1 };
      return [ns, { draft: draftOf(ns) }];
    }
    // Letzter Schritt → committen.
    const built = solidFromInputs(s.shape, s.p0!, s.p1, nums);
    const levelId = ctx.level.id;
    return [
      reset(s.shape),
      {
        draft: null,
        done: true,
        commit: (p: Project) => {
          if (!built) return p;
          const solid: ExtrudedSolid = {
            id: uniqueId("body"),
            type: "extrudedSolid",
            levelId,
            points: built.points,
            height: built.height,
            brep: { spec: built.spec, origin: built.points[0], label: built.label },
          };
          return { ...p, extrudedSolids: [...(p.extrudedSolids ?? []), solid] };
        },
      },
    ];
  },

  onMove: (state, point): [CommandState, CommandResult] => {
    const s = state as SolidState;
    const ns: SolidState = { ...s, cursor: point };
    return [ns, { draft: draftOf(ns) }];
  },

  onConfirm: (state): [CommandState, CommandResult] => [reset((state as SolidState).shape), { draft: null, done: true }],
  onCancel: (state): [CommandState, CommandResult] => [reset((state as SolidState).shape), { draft: null, done: true }],
};

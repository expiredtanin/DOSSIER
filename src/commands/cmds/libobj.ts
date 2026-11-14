// Objekt der Bibliothek setzen ([253]) — platziert ein Objekt der Standard-Bibliothek (Palette „Objekte") als
// parametrische Instanz (`{shape:"libobj"}`: Katalog-Id + Parameter + Lage); der Kern erzeugt die Linien zur
// Plan-Zeit nach Detailgrad. Welches Objekt aktiv ist, setzt die Palette über `setActiveLibObject`.
//   „Einfügepunkt:" → Punkt (Klick setzt ein). Optionen: Drehen (R, +90°), Spiegeln (M). Drehung und Spiegelung
//   bleiben für die nächsten Objekte erhalten. Die Vorschau hängt am Cursor.
// Klasse (Möbel, Sanitär, Fahrzeuge & Freiflächen) bestimmt der Kern; fehlt sie im Projekt, legt der Befehl sie
// im selben Undo-Schritt an.

import { createMutation, xy } from "../createCore";
import { libGeometry, libGeometryToPolys, type LibParams } from "../../model/furnitureLib";
import type { CmdOption, Command, CommandResult, CommandState, Vec2 } from "../types";

interface ActiveLib {
  libId: string;
  params: LibParams;
}

let active: ActiveLib | null = null;
/** Drehung (Radiant) und Spiegelung der Objekte, die als Nächstes gesetzt werden. */
let rotation = 0;
let mirror = false;

/** Die Palette wählt das Objekt (und seine Parameter) für den Befehl `libobj`. */
export function setActiveLibObject(libId: string, params: LibParams = {}): void {
  active = { libId, params: { ...params } };
}

export function activeLibObject(): ActiveLib | null {
  return active;
}

/** Nur für Tests: Drehung/Spiegelung zurücksetzen. */
export function resetLibObjectPlacement(): void {
  rotation = 0;
  mirror = false;
}

interface LibState extends CommandState {
  phase: "point";
}

const OPTIONS: CmdOption[] = [
  { id: "rotate", labelKey: "cmd.libobj.rotate", key: "R" },
  { id: "mirror", labelKey: "cmd.libobj.mirror", key: "M" },
];

function instanceParams(): LibParams {
  const p: LibParams = { ...(active?.params ?? {}) };
  if (mirror) p.mirror = true;
  else delete p.mirror;
  return p;
}

function previewAt(at: Vec2): CommandResult {
  if (!active) return { draft: null };
  const c = Math.cos(rotation);
  const s = Math.sin(rotation);
  const geoms = libGeometry(active.libId, instanceParams(), "mittel", 0);
  const polys = libGeometryToPolys(geoms, (p) => ({ x: at.x + p.x * c - p.y * s, y: at.y + p.x * s + p.y * c }));
  return {
    draft: {
      preview: polys.map((pl) => ({ kind: "poly" as const, pts: pl.pts, closed: pl.closed })),
      vertices: [at],
    },
  };
}

const state0 = (): LibState => ({ phase: "point", lastPoint: null });

export const libobjCommand: Command = {
  name: "libobj",
  labelKey: "cmd.libobj.label",
  prompt: () => "cmd.libobj.point",
  accepts: () => ["point", "option"],
  options: () => OPTIONS.map((o) => (o.id === "mirror" ? { ...o, value: mirror ? "ja" : "nein" } : { ...o, value: `${Math.round((rotation * 180) / Math.PI) % 360}°` })),
  init: state0,

  onInput: (state, input, ctx): [CommandState, CommandResult] => {
    if (input.kind === "option") {
      if (input.id === "rotate") rotation = (rotation + Math.PI / 2) % (2 * Math.PI);
      else if (input.id === "mirror") mirror = !mirror;
      return [state, { draft: null }];
    }
    if (input.kind !== "point" || !active) return [state, { draft: null }];
    const commit = createMutation(ctx, {
      cmd: "libobj",
      lib: active.libId,
      at: xy(input.point),
      rotation,
      params: instanceParams(),
    });
    return [state0(), { draft: null, done: true, commit }];
  },

  onMove: (state, point): [CommandState, CommandResult] => [state, previewAt(point)],
  onConfirm: (): [CommandState, CommandResult] => [state0(), { draft: null, done: true }],
  onCancel: (): [CommandState, CommandResult] => [state0(), { draft: null, done: true }],
};

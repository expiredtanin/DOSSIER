// [154] Bauteile aus Zeichnung erkennen — dünne Fassade über den Kern (`src-tauri/core/src/drawing_recognize.rs`):
// aus den 2D-Linien eines Grundrisses (DXF/DWG-Import) Wände, Öffnungen und Räume. Erkennung, Vorschau, Bericht
// und Ops rechnet der Kern; hier nur die Anfrage (Quell-Ebene, Auswahl, Namensvorlagen, Ziel-Geschoss).

import type { Project } from "../model/types";
import type { ProjectMutation } from "../core/opsBuild";
import { cmdMutation, documentFor } from "../core/document";

/** Unklare Stelle: Grund (Schlüssel `cmd.recognize.reason.<code>`) und Lage. */
export interface RecognizeUnclear {
  code: "areaMismatch" | "areaOutside" | "lineUnpaired" | "doorArc" | "doorHalf" | "gapWide" | "tooMany";
  x: number;
  y: number;
}

/** Bericht der Erkennung (Abfrage `recognize`). */
export interface RecognizeReport {
  walls: number;
  doors: number;
  windows: number;
  voids: number;
  rooms: number;
  arcWalls: number;
  /** Wände mit Füllung/Schraffur zwischen den Linien. */
  filledWalls: number;
  unnamedRooms: number;
  /** Erkannte Wanddicken (m, auf mm gerundet). */
  thicknesses: number[];
  /** Nur Linien auf Wand-Layern verwendet („Wand“, „Mauer“, „A-WALL“ …). */
  layerFilter: boolean;
  unclear: RecognizeUnclear[];
}

export interface RecognizeOptions {
  /** Ziel-Geschoss (Wände, Höhe). */
  levelId: string;
  /** Geschosshöhe (Wandhöhe); fehlt → Kern-Vorgabe 2.6 m. */
  floorHeight?: number;
  /** Ebene mit der Zeichnung; fehlt → `levelId`. Ohne Wirkung, wenn `ids` gesetzt ist. */
  sourceLevelId?: string;
  /** Nur diese 2D-Elemente (Auswahl). */
  ids?: readonly string[];
  /** Kategorie, falls „20/21/60“ fehlen. */
  categoryCode?: string;
  /** Aktiver Wandtyp (Baustoff neuer Wandtypen). */
  wallTypeId?: string;
  /** Namensvorlage neuer Wandtypen, `{cm}` = Dicke. */
  typeName?: string;
  /** Namensvorlage unbenannter Räume, `{n}` = laufende Nummer. */
  roomName?: string;
}

let seq = 0;

function request(o: RecognizeOptions): Record<string, unknown> {
  return {
    cmd: "recognize",
    src: o.sourceLevelId ?? o.levelId,
    ids: o.ids && o.ids.length > 0 ? [...o.ids] : [],
    typeName: o.typeName ?? "",
    roomName: o.roomName ?? "",
    ctx: { level: o.levelId, floorHeight: o.floorHeight ?? null, cat: o.categoryCode ?? "20", wallType: o.wallTypeId ?? "" },
  };
}

/** Bericht (Zähler, unklare Stellen) ohne Änderung am Projekt. */
export function recognizeReport(project: Project, o: RecognizeOptions): RecognizeReport {
  const { cmd: _cmd, ctx: _ctx, ...rest } = request(o);
  return documentFor(project).createQuery<RecognizeReport>({ q: "recognize", level: o.levelId, ...rest });
}

/** Änderung: neue Wandtypen, Wände, Öffnungen, Räume als EIN Undo-Schritt. */
export function recognizeMutation(o: RecognizeOptions): ProjectMutation {
  seq += 1;
  return cmdMutation({ ...request(o), stamp: `${Date.now()}-r${seq}` });
}

/** Ebenen mit 2D-Zeichnung (Geschosse und Zeichnungsebenen), in Projekt-Reihenfolge. */
export function recognizeSourceLevels(project: Project): string[] {
  const used = new Set(project.drawings2d.map((d) => d.levelId));
  return project.drawingLevels.filter((l) => (l.kind === "floor" || l.kind === "drawing") && used.has(l.id)).map((l) => l.id);
}

// Kennzahlen und Raumprogramm-Prüfung (Wettbewerbswerkzeug, [41]/[61]/[62]/[70]).
//
//  • Flächen je Geschoss aus den Räumen (SIA 416: GF, NGF/aGF), Summe über das Gebäude.
//  • Gebäudevolumen (GV) aus den freien Körpern (Massenmodell); Abzugskörper zählen nicht mit,
//    ihr Volumen wird abgezogen.
//  • Ausnützungs-/Überbauungsziffer nur mit `project.parcelArea` oder der Parzellengrenze (`siteRules`).
//  • Raumprogramm (`project.roomProgram`, Soll) gegen die gezeichneten Räume.
// Exakt für Prismen/Kegelstümpfe/Kreise, Näherung sonst (Fasen/Rundungen). Raumflächen je
// Geschoss und Kategorie, Volumen, Parzellenfläche und die SIA-416-Zusammenfassung rechnet der
// Rust-Kern auf dem Projekt-Dokument (`src-tauri/core/src/kennzahlen.rs`).

import type { ExtrudedSolid, Project } from "../model/types";
import { core } from "../engine/coreWasm";
import { FlatWriter } from "../geometry/coreFlat";
import { documentFor } from "../core/document";
import { compareRoomProgram } from "./roomProgram";
import type { ProgramStatus } from "./roomProgram";

export interface LevelKennzahlen {
  levelId: string;
  name: string;
  /** Geschossfläche (SIA 416 GF) aus den Räumen. */
  gf: number;
  /** Anrechenbare Fläche ≈ Nettogeschossfläche NGF (NF + VF + FF). */
  agf: number;
  rooms: number;
}

export interface Kennzahlen {
  levels: LevelKennzahlen[];
  gf: number;
  agf: number;
  /** Gebäudevolumen aus den freien Körpern (m³), Abzugskörper abgezogen. */
  gv: number;
  /** Bebaute Fläche ≈ GF des untersten Geschosses (m²). */
  footprint: number;
  /** Ausnützungsziffer aGF / Parzelle; `null` ohne Parzellenfläche. */
  az: number | null;
  /** Überbauungsziffer bebaute Fläche / Parzelle; `null` ohne Parzellenfläche. */
  uez: number | null;
}

/** Volumen eines Extrusionskörpers (m³): Prisma, Kegel(stumpf) über `taper`, Kreis. */
export function solidVolume(s: ExtrudedSolid): number {
  return core().kz_solid_volume(new FlatWriter().pts(s.circle ? [] : s.points).done(), s.circle ? s.circle.r : Number.NaN, s.height, s.taper ?? 0);
}

/**
 * Flächen je Geschoss (SIA 416), Gebäudevolumen, Ausnützungs- und Überbauungsziffer. Rechnet der
 * Kern auf dem Projekt-Dokument (`kennzahlen.rs`, [K4] S2).
 */
export function computeKennzahlen(project: Project): Kennzahlen {
  return documentFor(project).query<Kennzahlen>("kennzahlen");
}

export type { ProgramStatus } from "./roomProgram";

export interface ProgramRowResult {
  name: string;
  targetArea: number;
  targetCount: number;
  /** Gefundene Räume (Anzahl, Gesamtfläche). */
  count: number;
  area: number;
  status: ProgramStatus;
}

export interface ProgramCheck {
  rows: ProgramRowResult[];
  /** Räume im Modell, die keiner Programmzeile zugeordnet sind. */
  extra: Array<{ id: string; name: string; area: number }>;
}

/** Prüft das Raumprogramm: Räume werden über den Namen zugeordnet. Rechnet der Kern (`room_program.rs`, Toleranz `Project.roomProgramTolerance`). */
export function checkRoomProgram(project: Project): ProgramCheck {
  const c = compareRoomProgram(project);
  return {
    rows: c.rows.map((r) => ({ name: r.name, targetArea: r.targetArea, targetCount: r.targetCount, count: r.count, area: r.ist, status: r.status })),
    extra: c.extra,
  };
}

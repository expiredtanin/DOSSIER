// Kennzahlen und Raumprogramm-Prüfung (Wettbewerbswerkzeug, [41]/[61]/[62]/[70]).
//
//  • Flächen je Geschoss nach SIA 416 (GF = NGF + KF, NGF, HNF), Summe über das Gebäude — dieselben Zahlen
//    wie die Flächentabelle ([225]: eine Quelle, `flaechen.rs`).
//  • Gebäudevolumen (GV) aus den freien Körpern (Massenmodell); Abzugskörper zählen nicht mit,
//    ihr Volumen wird abgezogen. Ohne freie Körper GF × Geschosshöhe wie die Flächentabelle ([206]).
//  • AZ/ÜZ wie die IVHB-Ziffern der Tabelle mit ihren Vorgaben (aGF = NGF oberirdisch, aGbF), nur mit
//    `project.parcelArea` oder der Parzellengrenze (`siteRules`).
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
  /** Geschossfläche SIA 416 (GF = NGF + KF), gleich der Zeile der Flächentabelle. */
  gf: number;
  /** Anrechenbare Geschossfläche (Vorgabe NGF; Untergeschosse 0). */
  agf: number;
  /** Nettogeschossfläche (NF + VF + FF). */
  ngf: number;
  /** Hauptnutzfläche. */
  hnf: number;
  rooms: number;
}

export interface Kennzahlen {
  levels: LevelKennzahlen[];
  /** Σ GF (SIA 416) = Summenzeile der Flächentabelle. */
  gf: number;
  /** Anrechenbare Geschossfläche (IVHB, Basis NGF, oberirdisch) = Zähler der AZ. */
  agf: number;
  ngf: number;
  hnf: number;
  /** Konstruktionsfläche (Σ). */
  kf: number;
  /** Gebäudevolumen aus den freien Körpern (m³), Abzugskörper abgezogen; ohne Körper GF × Geschosshöhe. */
  gv: number;
  /** Anrechenbare Gebäudefläche (IVHB aGbF, m²) = Zähler der ÜZ. */
  footprint: number;
  /** Ausnützungsziffer aGF / Parzelle; `null` ohne Parzellenfläche. */
  az: number | null;
  /** Überbauungsziffer aGbF / Parzelle; `null` ohne Parzellenfläche. */
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

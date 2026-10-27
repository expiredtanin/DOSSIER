// Kennzahlen und Raumprogramm-Prüfung (Wettbewerbswerkzeug, [41]/[61]/[62]/[70]).
//
//  • Flächen je Geschoss aus den Räumen (SIA 416: GF, NGF/aGF), Summe über das Gebäude.
//  • Gebäudevolumen (GV) aus den freien Körpern (Massenmodell); Abzugskörper zählen nicht mit,
//    ihr Volumen wird abgezogen.
//  • Ausnützungs-/Überbauungsziffer nur mit `project.parcelArea` oder der Parzellengrenze (`siteRules`).
//  • Raumprogramm (`project.roomProgram`, Soll) gegen die gezeichneten Räume.
// Alles rein und ohne Wasm — exakt für Prismen/Kegelstümpfe/Kreise, Näherung sonst (Fasen/Rundungen).

import type { ExtrudedSolid, Project } from "../model/types";
import { balance, polygonArea } from "../geometry/roomArea";
import type { SiaCategory } from "../geometry/roomArea";

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
  const area = s.circle ? Math.PI * s.circle.r * s.circle.r : polygonArea(s.points);
  const t = Math.min(1, Math.max(0, s.taper ?? 0));
  const k = 1 - t; // Massstab der Deckfläche
  return (area * s.height * (1 + k + k * k)) / 3;
}

const finite = (n: number): number => (Number.isFinite(n) ? n : 0);

export function computeKennzahlen(project: Project): Kennzahlen {
  const floors = project.drawingLevels
    .filter((l) => l.kind === "floor")
    .slice()
    .sort((a, b) => (a.baseElevation ?? 0) - (b.baseElevation ?? 0));
  const rooms = project.rooms ?? [];
  const levels: LevelKennzahlen[] = floors.map((l) => {
    const mine = rooms.filter((r) => r.floorId === l.id);
    const b = balance(mine.map((r) => ({ category: r.siaCategory as SiaCategory, area: finite(polygonArea(r.boundary)) })));
    return { levelId: l.id, name: l.name, gf: b.byKey.GF, agf: b.byKey.NGF, rooms: mine.length };
  });
  const gf = levels.reduce((s, l) => s + l.gf, 0);
  const agf = levels.reduce((s, l) => s + l.agf, 0);
  let gv = 0;
  for (const s of project.extrudedSolids ?? []) {
    const v = finite(solidVolume(s));
    gv += s.operation === "subtract" ? -v : v;
  }
  const footprint = levels.find((l) => l.gf > 0)?.gf ?? 0;
  // Parzellenfläche: eingegebene Zahl, sonst aus der Parzellengrenze des Baurechts.
  const fromRules = project.siteRules?.parcel && project.siteRules.parcel.length >= 3 ? finite(polygonArea(project.siteRules.parcel)) : 0;
  const parcel = project.parcelArea && project.parcelArea > 0 ? project.parcelArea : fromRules > 0 ? fromRules : null;
  return {
    levels,
    gf,
    agf,
    gv: Math.max(0, gv),
    footprint,
    az: parcel ? agf / parcel : null,
    uez: parcel ? footprint / parcel : null,
  };
}

export type ProgramStatus = "ok" | "zu klein" | "zu gross" | "fehlt" | "zu wenige" | "zu viele";

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

/** Toleranz der Flächenprüfung (relativ zur Soll-Fläche). */
const AREA_TOL = 0.1;

const norm = (s: string) => s.trim().toLowerCase();

/** Prüft das Raumprogramm: Räume werden über den Namen (Präfix, ohne Gross-/Kleinschreibung) zugeordnet. */
export function checkRoomProgram(project: Project): ProgramCheck {
  const rooms = (project.rooms ?? []).map((r) => ({ id: r.id, name: r.name, cat: r.siaCategory, area: finite(polygonArea(r.boundary)) }));
  const used = new Set<string>();
  const rows: ProgramRowResult[] = (project.roomProgram ?? []).map((row) => {
    const n = norm(row.name);
    // Leerer Name (Zeile im Editor noch unfertig) trifft nichts — „" wäre Präfix jedes Raums.
    const hits = rooms.filter((r) => n !== "" && !used.has(r.id) && norm(r.name).startsWith(n) && (!row.siaCategory || r.cat === row.siaCategory));
    hits.forEach((h) => used.add(h.id));
    const targetCount = Math.max(1, row.count ?? 1);
    const area = hits.reduce((s, h) => s + h.area, 0);
    const target = row.area * targetCount;
    let status: ProgramStatus;
    if (hits.length === 0) status = "fehlt";
    else if (hits.length < targetCount) status = "zu wenige";
    else if (hits.length > targetCount) status = "zu viele";
    else if (area < target * (1 - AREA_TOL)) status = "zu klein";
    else if (area > target * (1 + AREA_TOL)) status = "zu gross";
    else status = "ok";
    return { name: row.name, targetArea: row.area, targetCount, count: hits.length, area, status };
  });
  return { rows, extra: rooms.filter((r) => !used.has(r.id)).map((r) => ({ id: r.id, name: r.name, area: r.area })) };
}

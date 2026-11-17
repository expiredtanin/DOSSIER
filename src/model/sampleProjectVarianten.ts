// [272] „Beispiel Varianten": das Demo-Haus (sampleProject) mit zwei Variantensätzen — Vorlage für Tests, die Kurzanleitung
// (Abschnitt Varianten) und die Prüfbilder (`doc/review-272`).
//
// Satz „Dachform": A Flachdach (Hauptvariante, neues Dach RF2), B Satteldach (das Dach RF1 des Demo-Hauses).
// Satz „Fassade": A Lochfenster (Nordfenster O2 des Demo-Hauses, Hauptvariante), B Bandfenster (O-band, 3.6 m breit).
// Alles Übrige gehört zum Hauptmodell. Ein eigenes Beispiel, damit die bestehenden Goldens unverändert bleiben.

import type { DesignOptionCombination, DesignOptionSet, Opening, Project, Roof } from "./types";
import { sampleProject } from "./sampleProject";

export const VARIANTEN_SETS: DesignOptionSet[] = [
  { id: "dachform", name: "Dachform", options: [{ id: "a", name: "A Flachdach" }, { id: "b", name: "B Satteldach" }], primary: "a" },
  { id: "fassade", name: "Fassade", options: [{ id: "a", name: "A Lochfenster" }, { id: "b", name: "B Bandfenster" }], primary: "a" },
];

/** Zwei benannte Kombinationen (wie Archicads „Design Option Combinations“): Studie 1 = Hauptvarianten, Studie 2 = B + B. */
export const VARIANTEN_COMBINATIONS: DesignOptionCombination[] = [
  { id: "studie-1", name: "Studie 1 Flachdach/Lochfenster", choices: { dachform: "a", fassade: "a" } },
  { id: "studie-2", name: "Studie 2 Satteldach/Bandfenster", choices: { dachform: "b", fassade: "b" } },
];

/** Das Varianten-Beispiel (frische Kopie bei jedem Aufruf). */
export function buildVariantenSampleProject(): Project {
  const base = structuredClone(sampleProject);
  const rf1 = (base.roofs ?? [])[0];
  const roofs: Roof[] = [
    { ...rf1, designOption: { set: "dachform", option: "b" } },
    { ...rf1, id: "RF2", shape: "flach", pitchDeg: 0, overhang: 0.15, thickness: 0.3, designOption: { set: "dachform", option: "a" } },
  ];
  const openings: Opening[] = (base.openings ?? []).map((o) => (o.id === "O2" ? { ...o, designOption: { set: "fassade", option: "a" } } : o));
  const o2 = (base.openings ?? []).find((o) => o.id === "O2")!;
  openings.push({ ...o2, id: "O-band", position: 0.7, width: 3.6, height: 1.0, sillHeight: 1.1, designOption: { set: "fassade", option: "b" } });
  return {
    ...base,
    id: "beispiel-varianten",
    name: "Beispiel Varianten",
    roofs,
    openings,
    designOptionSets: structuredClone(VARIANTEN_SETS),
    designOptionCombinations: structuredClone(VARIANTEN_COMBINATIONS),
  };
}

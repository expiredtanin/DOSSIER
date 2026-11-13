// Anonyme Wettbewerbs-Abgabe ([208]): EINE Stelle, die sagt, welche Angaben in eine Ausgabe dürfen. Ist
// `Project.competition` anonym, trägt keine Ausgabe (PDF, IFC, DXF/DWG, SVG, CSV, Bilder, Blender-Paket, STEP …)
// Büro, Bearbeiter:in, Projektname, Projektnummer, Adresse oder Benutzername — nur das Kennwort. Jeder Exporter holt
// seine Angaben hier, statt `project.name` selbst zu lesen. Das Gegenstück im Kern: `src-tauri/core/src/competition.rs`
// (IFC-Sammler, DXF-Blattnamen, Plankopf); dort gilt dieselbe Regel.
//
// Bezeichner englisch, Kommentare deutsch.

import type { Project } from "../model/types";

type CompetitionSource = Pick<Project, "competition">;

/** Fester Zeitstempel anonymer Ausgaben (2000-01-01 00:00:00 UTC): keine Spur, wann und wo gespeichert wurde. */
export const NEUTRAL_DATE = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
/** Derselbe Zeitstempel als ISO-Text ohne Zone (STEP-/IFC-Kopf). */
export const NEUTRAL_ISO = "2000-01-01T00:00:00";

/** Ist die Abgabe anonym? */
export function isAnonymous(project: CompetitionSource): boolean {
  return project.competition?.anonymous === true;
}

/** Kennwort der Abgabe (getrimmt, leer ohne Wettbewerb). */
export function competitionKeyword(project: CompetitionSource): string {
  return (project.competition?.keyword ?? "").trim();
}

/** Projektname für Schriftfelder, Berichtsköpfe, Dateinamen und Metadaten der Exporte: bei anonymer Abgabe das Kennwort. */
export function exportProjectName(project: Pick<Project, "name" | "competition">): string {
  return isAnonymous(project) ? competitionKeyword(project) : (project.name ?? "");
}

/** Was eine Ausgabe über die Herkunft sagen darf. */
export interface CompetitionIdentity {
  anonymous: boolean;
  keyword: string;
  /** Projektname der Ausgabe (anonym: das Kennwort). */
  projectName: string;
  /** Bearbeiter:in der Ausgabe (anonym: leer). */
  author(raw?: string | null): string;
  /** Zeitstempel der Ausgabe (anonym: fest {@link NEUTRAL_DATE}). */
  timestamp(now?: Date): Date;
  /** Erzeuger-/Programmangabe in Metadaten (anonym: leer). */
  creator(name?: string): string;
}

/** Die Angaben, die in die Ausgaben dieses Projekts dürfen. */
export function competitionIdentity(project: Pick<Project, "name" | "competition">): CompetitionIdentity {
  const anonymous = isAnonymous(project);
  return {
    anonymous,
    keyword: competitionKeyword(project),
    projectName: exportProjectName(project),
    author: (raw) => (anonymous ? "" : (raw ?? "")),
    timestamp: (now = new Date()) => (anonymous ? NEUTRAL_DATE : now),
    creator: (name = "Dossier") => (anonymous ? "" : name),
  };
}

/**
 * Angaben des Projekts, die eine anonyme Ausgabe nicht verraten darf (Name, Nummer, Titelblock-Bearbeiter:in):
 * Grundlage für den Gegenprüfer {@link identityLeaks} und die Tests.
 */
export function identifyingTexts(project: Project): string[] {
  const out: string[] = [];
  const add = (s: string | null | undefined) => {
    const v = (s ?? "").trim();
    if (v.length >= 3) out.push(v);
  };
  add(project.name);
  add(project.projectNumber);
  for (const m of project.masterLayouts ?? []) {
    add(m.titleBlock?.projectName);
    add(m.titleBlock?.author);
  }
  return [...new Set(out)];
}

/** Kopf der Berichte (Flächen, Raumbuch, Kosten …): Projektname der Ausgabe und Anonym-Kennzeichen für das PDF. */
export function reportHead(project: Pick<Project, "name" | "competition">): { projectName: string; anonymous?: boolean } {
  return isAnonymous(project) ? { projectName: competitionKeyword(project), anonymous: true } : { projectName: project.name ?? "" };
}

/** STEP-Kopf anonym: der Zeitstempel in FILE_NAME wird fest ({@link NEUTRAL_ISO}); Autor und Organisation schreibt truck leer. */
export function neutralizeStepText(text: string): string {
  const stamp = `${NEUTRAL_ISO.replace("T", " ")}.000`;
  return text.replace(/(FILE_NAME\('[^']*', ')\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(')/, `$1${stamp}$2`);
}

/** Welche der Angaben stehen (ohne Beachtung der Gross-/Kleinschreibung) im Text? Leer = sauber. */
export function identityLeaks(project: Project, text: string): string[] {
  const hay = text.toLowerCase();
  return identifyingTexts(project).filter((s) => hay.includes(s.toLowerCase()));
}

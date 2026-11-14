// Tor vor jedem Export einer anonymen Wettbewerbs-Abgabe ([208]): prüft den Freitext des Projekts
// (`export/competitionCheck.ts`) und fragt bei Treffern in einem Overlay-Dialog (`ui/AnonymityDialog.tsx`,
// kein window.confirm) nach. Ohne Anonymität oder ohne Treffer läuft der Export ohne Rückfrage weiter.
//
// Bezeichner englisch, Kommentare deutsch.

import type { Project } from "../model/types";
import { anonymityFindings, type AnonymityExtraText, type AnonymityFinding } from "../export/competitionCheck";

export interface AnonymityRequest {
  findings: AnonymityFinding[];
  resolve: (proceed: boolean) => void;
}

let current: AnonymityRequest | null = null;
let projectFileName = "";
const listeners = new Set<() => void>();

/** Dateiname des geöffneten Projekts (nur als Suchbegriff; leer = unbekannt). */
export function setAnonymityProjectFileName(name: string | null | undefined): void {
  projectFileName = name ?? "";
}

export function subscribeAnonymityRequest(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAnonymityRequest(): AnonymityRequest | null {
  return current;
}

function emit(): void {
  for (const fn of listeners) fn();
}

/**
 * Prüft vor dem Export. `true` = weiter (sauber, nicht anonym oder „Trotzdem exportieren"), `false` = abgebrochen.
 * `outputFileNames` sind die Dateinamen der Ausgabe, die ebenfalls geprüft werden.
 */
export async function confirmAnonymousExport(project: Project, outputFileNames: string[] = []): Promise<boolean> {
  let findings: AnonymityFinding[];
  try {
    const texts: AnonymityExtraText[] = outputFileNames.map((text) => ({ area: "export", place: "fileName", text }));
    findings = anonymityFindings(project, { fileName: projectFileName, texts });
  } catch {
    return true; // Prüfung nicht verfügbar (Kern nicht geladen): Export nicht blockieren
  }
  if (findings.length === 0) return true;
  // Eine offene Rückfrage wird abgebrochen, bevor eine neue erscheint.
  current?.resolve(false);
  return new Promise<boolean>((resolve) => {
    let done = false;
    const request: AnonymityRequest = {
      findings,
      resolve: (proceed) => {
        if (done) return;
        done = true;
        if (current === request) current = null;
        emit();
        resolve(proceed);
      },
    };
    current = request;
    emit();
  });
}

/** Führt `run` erst nach bestandener Prüfung aus (Knopf-Handler der Berichte, Bild-Exporte …); bei Abbruch passiert nichts. */
export function runWithAnonymityGate(project: Project, outputFileNames: string[], run: () => void | Promise<void>): void {
  void confirmAnonymousExport(project, outputFileNames).then((ok) => {
    if (ok) return run();
  });
}

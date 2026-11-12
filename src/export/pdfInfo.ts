// PDF-Metadaten ([208]): Titel/Autor/Ersteller des Info-Wörterbuchs. Bei anonymer Wettbewerbs-Abgabe
// (`Project.competition`) enthält das PDF nur das Kennwort als Titel — keine Büro-, Autor- oder Programmangaben:
// jsPDF schreibt `/Producer (jsPDF x.y.z)` und `/CreationDate` immer selbst, darum wird die fertige Datei
// längengleich nachbearbeitet (Xref-Offsets bleiben gültig).
//
// Bezeichner englisch, Kommentare deutsch.

import type { jsPDF } from "jspdf";
import type { Project } from "../model/types";

/** Ist die Abgabe anonym? */
export function isAnonymous(project: Pick<Project, "competition">): boolean {
  return project.competition?.anonymous === true;
}

/** Kennwort der Abgabe (getrimmt, leer ohne Wettbewerb). */
export function competitionKeyword(project: Pick<Project, "competition">): string {
  return (project.competition?.keyword ?? "").trim();
}

/** Projektname für Schriftfelder und Dateinamen der Exporte: bei anonymer Abgabe das Kennwort. */
export function exportProjectName(project: Pick<Project, "name" | "competition">): string {
  return isAnonymous(project) ? competitionKeyword(project) : (project.name ?? "");
}

/** Info-Felder, die ins PDF gehören: anonym nur das Kennwort als Titel, sonst Projektname und Autor des Titelblocks. */
export function pdfInfoFields(project: Pick<Project, "name" | "competition">, author?: string): { title: string; author: string; subject: string; keywords: string; creator: string } {
  if (isAnonymous(project)) return { title: competitionKeyword(project), author: "", subject: "", keywords: "", creator: "" };
  return { title: project.name ?? "", author: author ?? "", subject: "", keywords: "", creator: "Dossier" };
}

/** Setzt die Info-Felder auf dem jsPDF-Dokument. */
export function applyPdfInfo(doc: jsPDF, project: Pick<Project, "name" | "competition">, author?: string): void {
  doc.setProperties(pdfInfoFields(project, author));
}

/**
 * Anonymisiert die fertigen PDF-Bytes: `/Producer (…)` wird durch Leerzeichen gleicher Länge ersetzt und das
 * Datum in `/CreationDate` auf einen festen Wert gesetzt. Gilt nur für anonyme Abgaben; sonst unverändert.
 */
export function finishPdfBytes(project: Pick<Project, "competition">, bytes: Uint8Array): Uint8Array {
  return isAnonymous(project) ? neutralizePdfInfo(bytes) : bytes;
}

/** Letzte Fundstelle des ASCII-Musters in den Bytes (-1: keine). */
function lastIndexOfAscii(bytes: Uint8Array, pattern: string): number {
  const n = pattern.length;
  outer: for (let i = bytes.length - n; i >= 0; i--) {
    for (let j = 0; j < n; j++) if (bytes[i + j] !== pattern.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** Längengleiche Ersetzung der Erzeuger- und Datumsangabe im Info-Wörterbuch (das letzte im Text, nahe dem Ende). */
export function neutralizePdfInfo(bytes: Uint8Array): Uint8Array {
  // Byteweise, nicht über TextDecoder: "latin1" ist dort windows-1252 und verfälschte Binärdaten.
  const out = new Uint8Array(bytes);
  const blank = (key: string, fn: (v: string) => string) => {
    const at = lastIndexOfAscii(out, `${key} (`);
    if (at < 0) return;
    const from = at + key.length + 2;
    let to = from;
    while (to < out.length && out[to] !== 0x29 /* ) */) to++;
    if (to >= out.length) return;
    let v = "";
    for (let i = from; i < to; i++) v += String.fromCharCode(out[i]);
    const next = fn(v);
    if (next.length !== v.length) return;
    for (let i = 0; i < next.length; i++) out[from + i] = next.charCodeAt(i);
  };
  blank("/Producer", (v) => " ".repeat(v.length));
  blank("/CreationDate", (v) => v.replace(/^D:\d{14}/, "D:20000101000000"));
  blank("/ModDate", (v) => v.replace(/^D:\d{14}/, "D:20000101000000"));
  return out;
}

/** Hilfsfunktion für Tests: das Info-Wörterbuch als Text. */
export function pdfInfoText(bytes: Uint8Array): string {
  const at = lastIndexOfAscii(bytes, "/Producer");
  if (at < 0) return "";
  const start = Math.max(0, at - 4);
  let s = "";
  for (let i = start; i < Math.min(bytes.length, at + 400); i++) s += String.fromCharCode(bytes[i]);
  const end = s.indexOf(">>");
  return end < 0 ? s : s.slice(0, end + 2);
}

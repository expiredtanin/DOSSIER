// Gauben ([G5]): Zustand aus dem Rust-Kern (`dormer.rs::status`). Eine zu hohe Gaube wird am First gekappt
// (`clamped`) oder ist nicht herstellbar (`invalid`) — die Hülle zeigt das als Hinweis (Objekt-Info, Toast).

import type { Project } from "../model/types";
import { documentFor } from "../core/document";

export interface DormerStatus {
  roofId: string;
  dormerId: string;
  /** Über den First hinaus und darum gekappt. */
  clamped: boolean;
  /** Nicht herstellbar (zu schmal/niedrig, Punkt nicht in einer geneigten Fläche …). */
  invalid: boolean;
  /** Tatsächliche Stirnhöhe (m) nach dem Kappen; 0 bei `invalid`. */
  effectiveHeight: number;
}

/** Zustand aller Gauben (leer ohne Gauben, ohne Kernaufruf). */
export function dormerStatus(project: Project): DormerStatus[] {
  if (!(project.roofs ?? []).some((r) => (r.dormers ?? []).length > 0)) return [];
  return documentFor(project).query<DormerStatus[]>("dormerStatus");
}

/** Schlüssel einer Gaube für Mengenvergleiche. */
export const dormerKey = (s: Pick<DormerStatus, "roofId" | "dormerId">) => `${s.roofId}/${s.dormerId}`;

/** Gauben, die jetzt gekappt/ungültig sind, vorher aber nicht (`before` = Schlüssel des vorigen Stands). */
export function newlyAffected(before: ReadonlySet<string>, now: readonly DormerStatus[]): DormerStatus[] {
  return now.filter((s) => (s.clamped || s.invalid) && !before.has(dormerKey(s)));
}

/** Schlüssel der gekappten/ungültigen Gauben. */
export const affectedKeys = (now: readonly DormerStatus[]): Set<string> => new Set(now.filter((s) => s.clamped || s.invalid).map(dormerKey));

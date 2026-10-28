// Sitzungszustand des BCF-Panels: die geladene BCF-Datei lebt AUSSERHALB des Projekts (eigene .bcfzip),
// aber über das Umschalten der Panel-Tabs hinweg — daher ein kleiner Modul-Speicher statt React-State.

import { useSyncExternalStore } from "react";
import type { BcfFile, BcfVersion } from "../io/bcf";

export interface BcfSession {
  file: BcfFile | null;
  fileName: string;
  dirty: boolean;
  selectedGuid: string | null;
  version: BcfVersion;
}

let state: BcfSession = { file: null, fileName: "", dirty: false, selectedGuid: null, version: "2.1" };
const listeners = new Set<() => void>();

export const getBcfSession = (): BcfSession => state;

export function setBcfSession(patch: Partial<BcfSession>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export function useBcfSession(): BcfSession {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getBcfSession,
  );
}

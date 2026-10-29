// Fenster-/Türtyp-Bibliothek ([95]) — dünne Fassade über die Vorlagen des Rust-Kerns
// (`src-tauri/core/src/opening_presets.rs`). Die Vorlagen kommen ohne Projekt-ids; wer eine
// übernimmt, vergibt eine neue id (`instantiatePreset`).

import { core } from "../engine/coreWasm";
import type { DoorType, WindowType } from "./types";

export interface OpeningTypePresets {
  windowTypes: WindowType[];
  doorTypes: DoorType[];
}

let cache: OpeningTypePresets | null = null;

/** Alle Vorlagen (einmal aus dem Kern gelesen). `id` ist die stabile Vorlagen-id (i18n `preset.<id>`). */
export function openingTypePresets(): OpeningTypePresets {
  if (!cache) {
    try {
      const parsed = JSON.parse(core().opening_type_presets_json()) as Partial<OpeningTypePresets>;
      cache = { windowTypes: parsed.windowTypes ?? [], doorTypes: parsed.doorTypes ?? [] };
    } catch {
      cache = { windowTypes: [], doorTypes: [] };
    }
  }
  return cache;
}

/** Kopie einer Vorlage mit neuer id und Namen (tiefe Kopie, damit Flügellisten nicht geteilt werden). */
export function instantiatePreset<T extends { id: string; name: string }>(preset: T, id: string, name: string): T {
  return { ...(JSON.parse(JSON.stringify(preset)) as T), id, name };
}

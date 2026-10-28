// Klassifikation im IFC-Export ([B5], 28.10.): welche Klassifikationssysteme das Modell hergibt und die
// Standard-Zuordnung nach eBKP-H. Reine Tabellen/Funktionen, kein IFC-Schreiben (das macht Rust über
// den Datensatz CLASSIFICATION, `ifc_export.rs`).
//
// Was das Modell führt: KEINEN eBKP-H-/BKP-Code. `categoryCode` an Bauteilen ist die Grafik-Ebene
// („20" Wände, „30" Decken …, `LayerCategory`), kein Kostenschlüssel. Daher zwei getrennte Wege:
//   • `layerCodes` — die Ebene des Modells als eigenes System „Dossier-Ebenen" (Code = `categoryCode`,
//     Name = Ebenenname). Stammt aus dem Modell, behauptet keinen Standard.
//   • `ebkph` — Standardzuordnung je Bauteilart auf eBKP-H-HAUPTGRUPPEN (siehe `EBKPH_GROUPS`).
//
// Quelle eBKP-H: CRB, „eBKP-H Elementbasierter Baukostenplan Hochbau", SN 506 511 (Ausgabe 2020).
// Gesichert sind nur die Hauptgruppen-Buchstaben und ihre Namen (A Grundstück, B Vorbereitung,
// C Konstruktion Gebäude, D Technik Gebäude, E Äussere Wandbekleidung Gebäude, F Bedachung Gebäude,
// G Ausbau Gebäude, H Nutzungsspezifische Anlagen Gebäude, I Umgebung Gebäude, J Ausstattung,
// V Planungsleistungen, W Nebenkosten, Y Reserve, Z Mehrwertsteuer). Keine Untergruppen (C01 …):
// die hängen von Konstruktionsart und Lage ab, die das Modell nicht trägt.
//
// Die Zuordnung ist deshalb bewusst grob und ein VORSCHLAG für die Kostenplanung, kein Ersatz für
// die Einordnung durch die Kostenplanerin:
//   Wand → C        (Wandkonstruktion; Aussen-/Innenbekleidung E/G und nichttragende Innenwände
//                    unterscheidet das Modell nicht — dafür fehlt ein Feld am Wandtyp)
//   Decke → C       (Deckenkonstruktion; Bodenbeläge/Unterdecken wären G)
//   Stütze → C
//   Treppe → C      (Treppenkonstruktion; Belag/Geländer wären G)
//   Dach → F        (Dachaufbau mit Eindeckung/Abdichtung; die reine Tragkonstruktion wäre C)
//   Fenster → E     (Fenster der Gebäudehülle)
//   Tür → keine     (Aussentür E, Innentür G — nicht unterscheidbar, daher nicht geraten)
//   Raum → keine    (Räume sind Flächen, kein Bauteil; sie haben die SIA-416-Zonen)

import type { LayerCategory, Project } from "../model/types";

/** Optionen der Klassifikation im IFC-Export. */
export interface IfcExportOptions {
  /** eBKP-H-Hauptgruppen je Bauteilart (Standardzuordnung, s. Dateikopf). */
  ebkph?: boolean;
  /** `categoryCode` (Ebene) des Modells als System „Dossier-Ebenen". */
  layerCodes?: boolean;
}

/** Bauteilarten, die klassifiziert werden können. */
export type ClassifiedKind = "wall" | "slab" | "roof" | "column" | "stair" | "window" | "door" | "space";

/** Ein Klassifikationssystem für IfcClassification. */
export interface ClassificationSystem {
  name: string;
  source: string;
  /** Ausgabe; leer = keine Angabe. */
  edition: string;
}

export const EBKPH_SYSTEM: ClassificationSystem = {
  name: "eBKP-H",
  source: "CRB Schweizerische Zentralstelle für Baurationalisierung",
  edition: "SN 506 511:2020",
};

export const LAYER_SYSTEM: ClassificationSystem = {
  name: "Dossier-Ebenen",
  source: "Dossier",
  edition: "",
};

/** Gesicherte eBKP-H-Hauptgruppen (nur die hier verwendeten). */
export const EBKPH_GROUPS = {
  C: "Konstruktion Gebäude",
  E: "Äussere Wandbekleidung Gebäude",
  F: "Bedachung Gebäude",
} as const;

const EBKPH_BY_KIND: Partial<Record<ClassifiedKind, keyof typeof EBKPH_GROUPS>> = {
  wall: "C",
  slab: "C",
  column: "C",
  stair: "C",
  roof: "F",
  window: "E",
};

/** eBKP-H-Hauptgruppe zur Bauteilart, oder `null` (Tür, Raum: nicht eindeutig). */
export function ebkphGroup(kind: ClassifiedKind): { code: string; name: string } | null {
  const code = EBKPH_BY_KIND[kind];
  return code ? { code, name: EBKPH_GROUPS[code] } : null;
}

function findLayer(list: readonly LayerCategory[], code: string): LayerCategory | undefined {
  for (const c of list) {
    if (c.code === code) return c;
    const sub = c.children ? findLayer(c.children, code) : undefined;
    if (sub) return sub;
  }
  return undefined;
}

/** Ebene (Code + Name) eines Bauteils; ohne Code `null`, ohne bekannte Ebene der Code als Name. */
export function layerClassification(project: Project, categoryCode: string | undefined): { code: string; name: string } | null {
  const code = categoryCode?.trim();
  if (!code) return null;
  return { code, name: findLayer(project.layers, code)?.name ?? code };
}

// Räume (Flächen) — Flächenberechnung und SIA-416-Klassifikation.
//
// Fassade über den Rust-Kern (`src-tauri/core/src/room_area.rs`, Bindungen `web/room_area.rs`):
// Polygon-Fläche, Schwerpunkt, Bewertung (`evaluateRoom`) und die Bilanz (`balance`) rechnet Rust.
// Die Zuordnung Blatt-Kategorie → NF/NGF/GF steht NUR dort (`rollup`); hier bleiben die Namen als
// Typ (`SiaCategory`; Reihenfolge = Index im Kern, von `roomArea.test.ts` gegen den Kern geprüft).
//
// Bewusst TS (rechnet nichts): deutsche Beschriftungen (`siaLabel`, `siaLabelFull`), Zeilenreihenfolge
// der Bilanz-Tabelle und der CSV-Aufbau (`roomsToCsv`: Quoting, Zeilen, Zahlenformat) — reine
// Text-/Tabellen-Logik, die UI-Sprache gehört in die Hülle.
//
// Bezeichner englisch, Kommentare/Labels deutsch (CONVENTIONS.md). Einheit: METER.

import type { Vec2 } from "../model/types";
import { core } from "../engine/coreWasm";
import { FlatWriter } from "./coreFlat";

// ── Polygon-Kennzahlen ───────────────────────────────────────────────────────

/** Absolute (immer positive) Polygonfläche in m²; Ring offen (Schlusskante wird ergänzt). */
export function polygonArea(pts: Vec2[]): number {
  return core().room_polygon_area(new FlatWriter().pts(pts).done());
}

/**
 * Flächenschwerpunkt (Centroid) eines geschlossenen Polygons — Ankerpunkt für
 * das Raum-Label. Degeneriert (Fläche ≈ 0) auf den Durchschnitt der Vertices.
 */
export function centroid(pts: Vec2[]): Vec2 {
  const c = core().room_centroid(new FlatWriter().pts(pts).done());
  return { x: c[0], y: c[1] };
}

// ── SIA-416-Kategorie-Hierarchie ─────────────────────────────────────────────
//
// SIA 416 gliedert die Geschossfläche (GF) eines Gebäudes hierarchisch:
//
//   GF  Geschossfläche
//   ├── KGF  Konstruktionsfläche (Wände, Stützen, Schächte-Wandungen …)
//   ├── AGF  Aussengeschossfläche (Balkone, Terrassen, Laubengänge …)
//   └── NGF  Nettogeschossfläche
//        ├── NF  Nutzfläche
//        │    ├── HNF  Hauptnutzfläche  (der eigentliche Nutzungszweck)
//        │    └── NNF  Nebennutzfläche  (unterstützende Nutzung, Lager, WC …)
//        ├── VF  Verkehrsfläche         (Flure, Treppen, Aufzüge, Rampen)
//        └── FF  Funktionsfläche        (technische Anlagen, Haustechnik)
//
// Die „Blatt"-Kategorien, die einem konkreten Raum zugewiesen werden, sind
// HNF, NNF, VF, FF, KGF und AGF. HNF+NNF = NF; NF+VF+FF = NGF; NGF+KGF+AGF = GF.
// AGF zählt zur Geschossfläche, ist aber ausserhalb der Gebäudehülle (Aussen-
// bereich) und fliesst daher NICHT in NGF (bzw. NF) ein.

/** Blatt-Kategorien nach SIA 416, die einem Raum direkt zugewiesen werden. */
export type SiaCategory = "HNF" | "NNF" | "VF" | "FF" | "KGF" | "AGF";

/** Aggregat-(Zwischensummen-)Ebenen der SIA-416-Hierarchie. */
export type SiaAggregate = "NF" | "NGF" | "GF";

/** Alle in der Bilanz vorkommenden Schlüssel (Blatt + Aggregat). */
export type SiaKey = SiaCategory | SiaAggregate;

/** Reihenfolge der Blatt-Kategorien für stabile Tabellen/CSV-Ausgabe. */
export const SIA_CATEGORIES: readonly SiaCategory[] = [
  "HNF",
  "NNF",
  "VF",
  "FF",
  "KGF",
  "AGF",
] as const;

const SIA_LABELS: Record<SiaKey, string> = {
  HNF: "Hauptnutzfläche",
  NNF: "Nebennutzfläche",
  VF: "Verkehrsfläche",
  FF: "Funktionsfläche",
  KGF: "Konstruktionsfläche",
  AGF: "Aussengeschossfläche",
  NF: "Nutzfläche",
  NGF: "Nettogeschossfläche",
  GF: "Geschossfläche",
};

/** Deutsche Bezeichnung zu einem SIA-Schlüssel. */
export function siaLabel(key: SiaKey): string {
  return SIA_LABELS[key];
}

/** „HNF — Hauptnutzfläche" o. ä. für Legenden/Dropdowns. */
export function siaLabelFull(key: SiaKey): string {
  return `${key} — ${SIA_LABELS[key]}`;
}

// ── Raum-Flächenergebnis ─────────────────────────────────────────────────────

/**
 * Ergebnis der Flächenbewertung eines einzelnen Raums.
 *
 * `grossArea` ist die geometrische Polygonfläche (Bruttofläche der Raum-Kontur).
 * `netArea` ist die anrechenbare Netto-Nutzfläche: standardmässig gleich der
 * Bruttofläche (die Raum-Kontur ist bereits die lichte Innenfläche zwischen den
 * Wänden). Über einen optionalen Abzug (`deduction`, z. B. für nicht anrechen-
 * bare Bereiche mit lichter Höhe < 1.0 m nach SIA 416) kann `netArea` reduziert
 * werden. `category`/`label` tragen die SIA-Klassifikation.
 */
export interface RoomAreaResult {
  grossArea: number;
  netArea: number;
  perimeter: number;
  centroid: Vec2;
  category: SiaCategory;
  /** Deutsche Bezeichnung der Kategorie (z. B. „Hauptnutzfläche"). */
  label: string;
}

/** Optionen für die Flächenbewertung eines Raums. */
export interface RoomAreaOptions {
  /**
   * Abzug von der Bruttofläche (m²), z. B. für Bereiche mit lichter Höhe unter
   * dem SIA-416-Grenzwert, die nicht zur anrechenbaren Fläche zählen. Default 0.
   */
  deduction?: number;
}

/**
 * Bewertet ein Raum-Polygon: berechnet Brutto-/Nettofläche, Umfang, Schwerpunkt
 * und hängt die SIA-416-Kategorie samt deutschem Label an.
 */
export function evaluateRoom(
  polygon: Vec2[],
  category: SiaCategory,
  options: RoomAreaOptions = {},
): RoomAreaResult {
  const r = core().room_evaluate(new FlatWriter().pts(polygon).done(), options.deduction ?? 0);
  return {
    grossArea: r[0],
    netArea: r[1],
    perimeter: r[2],
    centroid: { x: r[3], y: r[4] },
    category,
    label: SIA_LABELS[category],
  };
}

// ── Bilanz (Flächenaufstellung) ──────────────────────────────────────────────

/** Ein Zeileneintrag der Bilanz: Schlüssel, Label, Fläche, Raumanzahl. */
export interface BalanceRow {
  key: SiaKey;
  label: string;
  area: number;
  /** Anzahl Räume, die zu dieser (Blatt-)Kategorie zählen. Für Aggregate: Summe. */
  count: number;
  /** true, wenn es sich um eine Zwischensumme (NF/NGF/GF) handelt. */
  aggregate: boolean;
}

/** Vollständige SIA-416-Bilanz: geordnete Zeilen + Gesamtsumme (GF). */
export interface Balance {
  rows: BalanceRow[];
  /** Schneller Zugriff auf die Fläche je Schlüssel. */
  byKey: Record<SiaKey, number>;
  total: number;
}

/**
 * Aggregiert Räume je SIA-416-Kategorie und rollt die Zwischensummen
 * (NF, NGF, GF) korrekt auf. Erwartet je Raum die Blatt-Kategorie und die
 * anzurechnende Fläche (i. d. R. `netArea` aus {@link evaluateRoom}).
 *
 * Die zurückgegebenen `rows` sind in kanonischer Reihenfolge:
 *   HNF, NNF, NF(=Σ), VF, FF, NGF(=Σ), KGF, AGF, GF(=Σ)
 * — passend für die Bilanz-Tabelle und den CSV-Export.
 */
export function balance(
  rooms: { category: SiaCategory; area: number }[],
): Balance {
  // Kern: [6 Blatt-Flächen, 6 Blatt-Zahlen, 3 Summen-Flächen (NF, NGF, GF), 3 Summen-Zahlen].
  const r = core().room_balance(
    Float64Array.from(rooms, (x) => SIA_CATEGORIES.indexOf(x.category)),
    Float64Array.from(rooms, (x) => x.area),
  );
  const leafArea = (k: SiaCategory): number => r[SIA_CATEGORIES.indexOf(k)];
  const leafCount = (k: SiaCategory): number => r[6 + SIA_CATEGORIES.indexOf(k)];
  const AGG: SiaAggregate[] = ["NF", "NGF", "GF"];
  const aggArea = (k: SiaAggregate): number => r[12 + AGG.indexOf(k)];
  const aggCount = (k: SiaAggregate): number => r[15 + AGG.indexOf(k)];

  const byKey: Record<SiaKey, number> = {
    HNF: leafArea("HNF"),
    NNF: leafArea("NNF"),
    VF: leafArea("VF"),
    FF: leafArea("FF"),
    KGF: leafArea("KGF"),
    AGF: leafArea("AGF"),
    NF: aggArea("NF"),
    NGF: aggArea("NGF"),
    GF: aggArea("GF"),
  };

  const mkLeaf = (k: SiaCategory): BalanceRow => ({
    key: k,
    label: SIA_LABELS[k],
    area: leafArea(k),
    count: leafCount(k),
    aggregate: false,
  });
  const mkAgg = (k: SiaAggregate): BalanceRow => ({
    key: k,
    label: SIA_LABELS[k],
    area: aggArea(k),
    count: aggCount(k),
    aggregate: true,
  });

  const rows: BalanceRow[] = [
    mkLeaf("HNF"),
    mkLeaf("NNF"),
    mkAgg("NF"),
    mkLeaf("VF"),
    mkLeaf("FF"),
    mkAgg("NGF"),
    mkLeaf("KGF"),
    mkLeaf("AGF"),
    mkAgg("GF"),
  ];

  return { rows, byKey, total: byKey.GF };
}

// ── CSV-Serialisierung ───────────────────────────────────────────────────────

/** Ein Raum, wie er in den CSV-Export einfliesst. */
export interface RoomCsvRecord {
  /** Raum-Nummer/-Kennung (frei), z. B. „R.01". */
  number?: string;
  /** Raum-Name, z. B. „Wohnen". */
  name?: string;
  /** Geschoss/Ebene, optional. */
  level?: string;
  category: SiaCategory;
  /** Anzurechnende Fläche (m²) — i. d. R. netArea. */
  area: number;
}

/** Ein Feld CSV-sicher quoten (RFC 4180: „..." bei , " \n; " → ""). */
function csvField(value: string): string {
  if (/[",\n\r;]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Fläche auf 2 Nachkommastellen, Punkt als Dezimaltrenner (m²). */
function fmtArea(area: number): string {
  return (Math.round(area * 100) / 100).toFixed(2);
}

export interface RoomsToCsvOptions {
  /** Feldtrenner. Default „;" (Excel-DE-freundlich). */
  delimiter?: string;
  /** true (Default): Bilanz-Zwischensummen unter die Raumliste anhängen. */
  includeBalance?: boolean;
}

/**
 * Serialisiert eine Raumliste als CSV (reiner String, kein Datei-IO) für den
 * späteren Export. Kopfzeile deutsch; optional folgt die SIA-416-Bilanz als
 * Summenblock. Nutzt `;` als Trenner (Standard im DE-Excel-Umfeld).
 */
export function roomsToCsv(
  rooms: RoomCsvRecord[],
  options: RoomsToCsvOptions = {},
): string {
  const d = options.delimiter ?? ";";
  const includeBalance = options.includeBalance ?? true;
  const lines: string[] = [];

  const header = ["Nummer", "Name", "Geschoss", "Kategorie", "Bezeichnung", "Fläche [m²]"];
  lines.push(header.map(csvField).join(d));

  for (const r of rooms) {
    lines.push(
      [
        csvField(r.number ?? ""),
        csvField(r.name ?? ""),
        csvField(r.level ?? ""),
        csvField(r.category),
        csvField(SIA_LABELS[r.category]),
        fmtArea(r.area),
      ].join(d),
    );
  }

  if (includeBalance) {
    const bal = balance(rooms.map((r) => ({ category: r.category, area: r.area })));
    lines.push(""); // Leerzeile trennt Raumliste von Bilanz
    lines.push([csvField("Bilanz (SIA 416)"), "", "", "", "", ""].join(d));
    for (const row of bal.rows) {
      lines.push(
        [
          "",
          "",
          "",
          csvField(row.key),
          csvField(row.label),
          fmtArea(row.area),
        ].join(d),
      );
    }
  }

  return lines.join("\r\n");
}

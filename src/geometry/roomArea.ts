// Räume (Flächen) — Flächenberechnung und SIA-416-Klassifikation.
//
// Reiner Rechenkern für die Raum-Flächenbuchhaltung nach SIA 416 (Schweizer
// Norm „Flächen und Volumen von Gebäuden"). Keine UI, kein Datei-IO — nur
// Polygon-Geometrie, Kategorie-Hierarchie und Aggregation für die Bilanz.
//
// Bezeichner englisch, Kommentare/Labels deutsch (CONVENTIONS.md). Einheit: METER.

import type { Vec2 } from "../model/types";

// ── Polygon-Kennzahlen ───────────────────────────────────────────────────────

/**
 * Vorzeichenbehaftete Polygonfläche (Gauss'sche Trapezformel / Shoelace).
 * >0 = gegen den Uhrzeigersinn (CCW), <0 = im Uhrzeigersinn (CW). Der letzte
 * Punkt darf NICHT dupliziert sein (die Schlusskante n-1 → 0 wird ergänzt).
 */
export function signedArea(pts: Vec2[]): number {
  const n = pts.length;
  if (n < 3) return 0;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}

/** Absolute (immer positive) Polygonfläche in m². */
export function polygonArea(pts: Vec2[]): number {
  return Math.abs(signedArea(pts));
}

/** Umfang eines geschlossenen Polygons (Summe aller Kantenlängen). */
export function perimeter(pts: Vec2[]): number {
  const n = pts.length;
  if (n < 2) return 0;
  let p = 0;
  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

/**
 * Flächenschwerpunkt (Centroid) eines geschlossenen Polygons — Ankerpunkt für
 * das Raum-Label. Nutzt die momenten-gewichtete Formel; degeneriert (Fläche ≈ 0)
 * auf den Durchschnitt der Vertices.
 */
export function centroid(pts: Vec2[]): Vec2 {
  const n = pts.length;
  if (n === 0) return { x: 0, y: 0 };
  if (n < 3) {
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / n, y: sy / n };
  }
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % n];
    const cr = p.x * q.y - q.x * p.y;
    a += cr;
    cx += (p.x + q.x) * cr;
    cy += (p.y + q.y) * cr;
  }
  a /= 2;
  if (Math.abs(a) < 1e-12) {
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / n, y: sy / n };
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
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

/** Deutsche Bezeichnungen (Kurz + Lang) je SIA-416-Schlüssel. */
export interface SiaLabel {
  /** Kürzel, z. B. „HNF". */
  code: SiaKey;
  /** Ausgeschriebene deutsche Bezeichnung. */
  name: string;
}

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

/**
 * Zuordnung Blatt-Kategorie → übergeordnete Aggregate. Eine HNF trägt zu
 * NF, NGF und GF bei; eine KGF nur zu GF; VF/FF zu NGF und GF; NNF wie HNF.
 * AGF (Aussengeschossfläche) trägt nur zu GF bei — sie liegt ausserhalb der
 * Gebäudehülle und zählt NICHT zu NF/NGF. Wird für den Bilanz-Roll-up genutzt.
 */
const CATEGORY_ROLLUP: Record<SiaCategory, SiaAggregate[]> = {
  HNF: ["NF", "NGF", "GF"],
  NNF: ["NF", "NGF", "GF"],
  VF: ["NGF", "GF"],
  FF: ["NGF", "GF"],
  KGF: ["GF"],
  AGF: ["GF"],
};

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
  const gross = polygonArea(polygon);
  const deduction = Math.max(0, options.deduction ?? 0);
  const net = Math.max(0, gross - deduction);
  return {
    grossArea: gross,
    netArea: net,
    perimeter: perimeter(polygon),
    centroid: centroid(polygon),
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
  const leaf: Record<SiaCategory, number> = { HNF: 0, NNF: 0, VF: 0, FF: 0, KGF: 0, AGF: 0 };
  const leafCount: Record<SiaCategory, number> = { HNF: 0, NNF: 0, VF: 0, FF: 0, KGF: 0, AGF: 0 };
  const agg: Record<SiaAggregate, number> = { NF: 0, NGF: 0, GF: 0 };
  const aggCount: Record<SiaAggregate, number> = { NF: 0, NGF: 0, GF: 0 };

  for (const r of rooms) {
    const area = Number.isFinite(r.area) ? r.area : 0;
    leaf[r.category] += area;
    leafCount[r.category] += 1;
    for (const a of CATEGORY_ROLLUP[r.category]) {
      agg[a] += area;
      aggCount[a] += 1;
    }
  }

  const byKey: Record<SiaKey, number> = {
    HNF: leaf.HNF,
    NNF: leaf.NNF,
    VF: leaf.VF,
    FF: leaf.FF,
    KGF: leaf.KGF,
    AGF: leaf.AGF,
    NF: agg.NF,
    NGF: agg.NGF,
    GF: agg.GF,
  };

  const mkLeaf = (k: SiaCategory): BalanceRow => ({
    key: k,
    label: SIA_LABELS[k],
    area: leaf[k],
    count: leafCount[k],
    aggregate: false,
  });
  const mkAgg = (k: SiaAggregate): BalanceRow => ({
    key: k,
    label: SIA_LABELS[k],
    area: agg[k],
    count: aggCount[k],
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

  return { rows, byKey, total: agg.GF };
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

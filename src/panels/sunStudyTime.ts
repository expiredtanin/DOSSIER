// Zeitumrechnung des Schattenstudien-Reglers: gespeichert wird UTC (ISO 8601), bedient wird in
// Ortszeit des Rechners (Datum + Minuten seit Mitternacht).

export interface LocalTime {
  /** "YYYY-MM-DD" in Ortszeit. */
  date: string;
  /** Minuten seit Mitternacht in Ortszeit (0..1439). */
  minutes: number;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function isoToLocal(iso: string): LocalTime | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return {
    date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    minutes: d.getHours() * 60 + d.getMinutes(),
  };
}

export function localToIso(t: LocalTime): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t.date);
  if (!m || !Number.isFinite(t.minutes)) return null;
  const min = Math.min(1439, Math.max(0, Math.round(t.minutes)));
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Math.floor(min / 60), min % 60);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

export function formatMinutes(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Vorgabe beim ersten Einschalten: Tagundnachtgleiche des laufenden Jahres, 12:00 Ortszeit. */
export function defaultStudyIso(now = new Date()): string {
  return localToIso({ date: `${now.getFullYear()}-03-21`, minutes: 12 * 60 })!;
}

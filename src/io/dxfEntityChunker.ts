// Teilt eine DXF-Textdatei VOR dem eigentlichen Parsen in N unabhängige, für
// sich gültige Mini-DXF-Dokumente auf, damit `parseDxf` (dxf-parser, ein
// einziger monolithischer synchroner Pass ohne Streaming-/Teilbereichs-API)
// über mehrere Web Worker PARALLEL über mehrere CPU-Kerne laufen kann
// (Nutzer-Report 2026-10-09: Import eines 439-MB-Kataster-DXF "dauert ewig"
// — ein Worker nutzt nur einen Kern; s. `dxfParserAsync.ts`).
//
// Nur die ENTITIES-Sektion wird aufgeteilt (die mit Abstand grösste Sektion
// bei grossen Importen); HEADER/TABLES/BLOCKS werden unverändert für jeden
// Chunk vorangestellt (klein ggü. ENTITIES, und INSERT braucht die BLOCKS-
// Tabelle zur Auflösung von Block-Referenzen).
//
// SICHERHEIT (amtliche Vermessungsdaten — Korrektheit vor Geschwindigkeit):
// ein Split-Punkt darf NIE mitten in einen Datensatz schneiden. Gruppencode 0
// markiert jeden neuen Datensatz — aber drei Entity-Typen sind reine
// FORTSETZUNGEN eines vorangehenden Datensatzes, nie eigenständige
// Top-Level-Entities: VERTEX/SEQEND (gehören zu POLYLINE) und ATTRIB (gehört
// optional zu INSERT, gefolgt von SEQEND). Jeder ANDERE Gruppencode-0-Wert
// ist ein sicherer Split-Punkt (verifiziert an den bestehenden Tests,
// `dxfParser.test.ts:195-289` für INSERT/ATTRIB, `:548-600` für
// POLYLINE/VERTEX/SEQEND — kein Chunk kann je zwischen `POLYLINE`/`INSERT`
// und seinen Fortsetzungsdatensätzen landen, weil letztere nie als
// Split-Kandidat gezählt werden). Code/Wert stehen IMMER als festes
// Zeilenpaar — der Scanner liest daher strikt paarweise, nie "nach
// 0-Zeilen suchen" (ein MTEXT-Inhalt "0" auf eigener Zeile wäre sonst eine
// Falle, da Code- und Wertzeilen sonst verwechselt werden könnten).
//
// Jeder unsichere/unerwartete Fall (keine ENTITIES-Sektion, kaputtes/
// exotisches Format, Datei zu klein) liefert `null` — der Aufrufer fällt
// dann auf den bisherigen Einzel-Worker-Weg zurück. Lieber keine
// Parallelisierung als eine falsche.

/** Typen, die NIE einen neuen Top-Level-Datensatz einleiten (reine
 *  Fortsetzung eines vorangehenden POLYLINE/INSERT). */
const CONTINUATION_TYPES = new Set(["VERTEX", "SEQEND", "ATTRIB"]);

/** Unterhalb dieser Textgrösse lohnt sich der Aufteilungs-Overhead nicht. */
const MIN_SIZE_FOR_SPLIT = 20_000_000; // ~20 MB

/**
 * Abschluss, der jeden Chunk zu einem für sich gültigen DXF-Dokument macht.
 * OHNE führenden Zeilenumbruch: jeder Chunk endet selbst bereits mit einem
 * Zeilenumbruch (Chunk-Grenzen sind immer `next`-Offsets, also direkt NACH
 * einem Zeilenumbruch) — ein zusätzlicher würde eine leere Zeile einfügen
 * und die Code/Wert-Paarung um eine Zeile verschieben.
 */
export const DXF_CHUNK_CLOSER = "0\nENDSEC\n0\nEOF\n";

interface Pair {
  code: string;
  value: string;
  /** Zeichen-Offset, an dem die CODE-Zeile dieses Paars beginnt. */
  start: number;
  /** Zeichen-Offset, an dem das NÄCHSTE Paar beginnt. */
  next: number;
}

/**
 * Liest eine Zeile ab `pos` (Inhalt getrimmt NICHT hier — der Aufrufer
 * trimmt). Toleriert `\n` und `\r\n` als Zeilenende (wie `dxf-parser` selbst,
 * `split(/\r\n|\r|\n/g)`); eine Datei mit ausschliesslich altem
 * Mac-Classic-`\r`-Zeilenende (kein einziges `\n` in der ganzen restlichen
 * Datei) wird NICHT unterstützt — `findEntitiesSectionStart` schlägt dafür
 * sauber fehl (liefert `null`), statt falsch zu splitten.
 */
function readLine(text: string, pos: number): { raw: string; next: number } | null {
  if (pos >= text.length) return null;
  const nl = text.indexOf("\n", pos);
  if (nl === -1) return { raw: text.slice(pos), next: text.length };
  const crBeforeNl = nl > pos && text.charCodeAt(nl - 1) === 13;
  const end = crBeforeNl ? nl - 1 : nl;
  return { raw: text.slice(pos, end), next: nl + 1 };
}

/** Liest ein Gruppencode/Wert-Zeilenpaar ab `pos`; `null` am Textende. */
function readPair(text: string, pos: number): Pair | null {
  const l1 = readLine(text, pos);
  if (!l1) return null;
  const l2 = readLine(text, l1.next);
  if (!l2) return null;
  return { code: l1.raw.trim(), value: l2.raw.trim().toUpperCase(), start: pos, next: l2.next };
}

/**
 * Findet den Zeichen-Offset, an dem der INHALT der ENTITIES-Sektion beginnt
 * (direkt nach `0 SECTION` / `2 ENTITIES`), indem alle vorangehenden
 * Sektionen (HEADER/CLASSES/TABLES/BLOCKS, …) unangetastet übersprungen
 * werden (jede endet eindeutig mit `0 ENDSEC`, unabhängig davon, was darin
 * verschachtelt ist — z. B. `BLOCK`/`ENDBLK` in BLOCKS, die nie mit
 * `ENDSEC` verwechselt werden können). `null`, wenn keine ENTITIES-Sektion
 * gefunden wird (inkl. jeder Abweichung vom erwarteten Sektionsaufbau).
 */
function findEntitiesSectionStart(text: string): number | null {
  let pos = 0;
  for (;;) {
    const open = readPair(text, pos);
    if (!open || open.code !== "0" || open.value !== "SECTION") return null;
    const name = readPair(text, open.next);
    if (!name || name.code !== "2") return null;
    if (name.value === "ENTITIES") return name.next;
    // Andere Sektion: bis zum (eindeutigen) `0 ENDSEC` überspringen.
    let p = name.next;
    for (;;) {
      const pair = readPair(text, p);
      if (!pair) return null;
      p = pair.next;
      if (pair.code === "0" && pair.value === "ENDSEC") break;
    }
    pos = p;
  }
}

/**
 * Scannt die ENTITIES-Sektion ab `start` und liefert alle sicheren Split-
 * Offsets (Beginn jedes Top-Level-Datensatzes, inkl. `start` selbst als
 * erstes Element) sowie den Offset, an dem die Sektion endet (Beginn von
 * `0 ENDSEC`). `null`, wenn kein `ENDSEC` gefunden wird (malformed).
 */
function scanEntitySplitPoints(
  text: string,
  start: number,
): { offsets: number[]; end: number } | null {
  const offsets = [start];
  let pos = start;
  for (;;) {
    const pair = readPair(text, pos);
    if (!pair) return null;
    if (pair.code === "0") {
      if (pair.value === "ENDSEC") return { offsets, end: pair.start };
      if (pair.start !== start && !CONTINUATION_TYPES.has(pair.value)) {
        offsets.push(pair.start);
      }
    }
    pos = pair.next;
  }
}

/** Index des Elements in einem aufsteigend sortierten Array, das `target` am
 *  nächsten liegt (Binärsuche). */
function nearestIndex(sorted: number[], target: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && Math.abs(sorted[lo - 1] - target) <= Math.abs(sorted[lo] - target)) return lo - 1;
  return lo;
}

/**
 * Nur die Zeichen-OFFSETS der sicheren Split-Punkte (keine String-Slices!).
 * Das eigentliche Scannen ist der teure Teil (ein voller linearer Durchlauf
 * über die ganze Datei, bei 439 MB real gemessen ~2 s) — diese Funktion ist
 * bewusst von `buildDxfChunks` (dem billigen Slicing) getrennt, damit der
 * Aufrufer (`dxfParserAsync.ts`) sie in einem WORKER laufen lassen kann.
 * Würde stattdessen `splitDxfForParallelParse` direkt im Haupt-Thread
 * aufgerufen, würde genau diese ~2 s die UI einfrieren — derselbe Fehler,
 * den der Worker für `parseDxf` selbst schon beheben sollte (Nutzer-Report
 * 2026-10-09: "keine Rückmeldung, hängt").
 *
 * `null` bei denselben Bedingungen wie `splitDxfForParallelParse`.
 */
export interface DxfSplitOffsets {
  /** Aufsteigend sortierte Chunk-Grenzen: `[entitiesStart, …, entitiesEnd]`. */
  breakpoints: number[];
}

export function computeDxfSplitOffsets(text: string, chunkCount: number): DxfSplitOffsets | null {
  if (chunkCount <= 1 || text.length < MIN_SIZE_FOR_SPLIT) return null;
  const entitiesStart = findEntitiesSectionStart(text);
  if (entitiesStart === null) return null;
  const scan = scanEntitySplitPoints(text, entitiesStart);
  if (!scan) return null;
  const { offsets, end } = scan;
  if (offsets.length < 2) return null; // keine (oder nur eine) Top-Level-Entity

  const n = Math.min(chunkCount, offsets.length);
  const breakpoints = new Set<number>([entitiesStart, end]);
  for (let k = 1; k < n; k++) {
    const target = entitiesStart + (k * (end - entitiesStart)) / n;
    breakpoints.add(offsets[nearestIndex(offsets, target)]);
  }
  const sorted = Array.from(breakpoints).sort((a, b) => a - b);
  if (sorted.length < 3) return null; // weniger als 2 Chunks gewonnen

  return { breakpoints: sorted };
}

/**
 * Billiges Slicing anhand bereits berechneter Offsets (`computeDxfSplitOffsets`)
 * — reine `String.slice`-Aufrufe (in V8/JSC für grosse Strings O(1)-Views,
 * kein Zeichen-Kopieren), unbedenklich im Haupt-Thread. `preamble` (HEADER/
 * TABLES/BLOCKS/…) muss jedem Chunk vorangestellt werden; jeder Chunk
 * braucht zusätzlich `DXF_CHUNK_CLOSER`, um für sich ein gültiges
 * DXF-Dokument zu ergeben: `preamble + chunk + DXF_CHUNK_CLOSER`.
 *
 * `null` nur als Sicherheitsnetz (Off-by-one in den Offsets) — sollte bei
 * Offsets aus `computeDxfSplitOffsets` nie eintreten.
 */
export function buildDxfChunks(
  text: string,
  offsets: DxfSplitOffsets,
): { preamble: string; chunks: string[] } | null {
  const { breakpoints } = offsets;
  const chunks: string[] = [];
  for (let i = 0; i + 1 < breakpoints.length; i++) {
    chunks.push(text.slice(breakpoints[i], breakpoints[i + 1]));
  }
  if (chunks.length < 2) return null;

  // Sicherheitsnetz: die Summe muss exakt die Sektion abdecken (fängt
  // Off-by-one-Fehler in der Offset-Arithmetik ab) — bei Abweichung lieber
  // gar nicht aufteilen als riskieren, Daten zu verlieren/doppeln.
  let total = 0;
  for (const c of chunks) total += c.length;
  if (total !== breakpoints[breakpoints.length - 1] - breakpoints[0]) return null;

  return { preamble: text.slice(0, breakpoints[0]), chunks };
}

/**
 * Bequemlichkeits-Wrapper (`computeDxfSplitOffsets` + `buildDxfChunks` in
 * einem) — NUR für Tests/Benchmarks gedacht, wo das Blockieren des
 * Haupt-Threads keine Rolle spielt. Der Produktionscode
 * (`dxfParserAsync.ts`) ruft die beiden Hälften GETRENNT auf (die teure
 * Scan-Hälfte in einem Worker).
 */
export function splitDxfForParallelParse(
  text: string,
  chunkCount: number,
): { preamble: string; chunks: string[] } | null {
  const offsets = computeDxfSplitOffsets(text, chunkCount);
  return offsets ? buildDxfChunks(text, offsets) : null;
}

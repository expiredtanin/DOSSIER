// Geometrie-Helfer für Öffnungen (Fenster/Türen) — reine Funktionen, die eine
// `Opening` relativ zu ihrer Wirts-Wand in konkrete Welt-Geometrie auflösen:
//   • die Öffnungs-Lücke entlang der Wandachse (from/to in Metern),
//   • die Fenster-Rahmen-/Glaslinien quer über die Lücke (`windowSymbol`, Fassade über den Rust-Kern),
//   • die vertikale Lage (UK/OK der Öffnung, absolut in Metern).
//
// Da JEDE Größe aus der aktuellen Wandachse (`wall.start`/`wall.end`) abgeleitet
// wird, folgt eine Öffnung ihrer Wand automatisch, sobald die Wand bewegt wird —
// es gibt keine eingebackenen Weltkoordinaten.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Opening, Project, SashDef, Vec2, Wall } from "../model/types";
import { core } from "../engine/coreWasm";
import { getWallType, wallTypeThickness } from "../model/types";
import { add, along, leftNormal, normalize, scale, sub } from "../model/geometry";
import { wallReferenceOffset, wallVerticalExtent } from "../model/wall";

/** Achslänge einer Wand (Meter). */
export function wallAxisLength(wall: Wall): number {
  return Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
}

/**
 * Öffnungs-Intervall entlang der Wandachse (from..to in Metern), auf die
 * Achslänge geklemmt. Liefert null, wenn das Intervall entartet (Breite ≤ 0 oder
 * vollständig außerhalb der Achse).
 */
export function openingInterval(
  wall: Wall,
  o: Opening,
): { from: number; to: number } | null {
  const axis = wallAxisLength(wall);
  const from = Math.max(0, Math.min(o.position, axis));
  const to = Math.max(from, Math.min(o.position + o.width, axis));
  if (to - from < 1e-4) return null;
  return { from, to };
}

/**
 * Vertikale Lage einer Öffnung (absolute Z-Werte in Metern) relativ zur Wand-UK.
 * Türen sitzen am Boden (sillHeight 0); Fenster ab Brüstung. Die OK wird auf die
 * Wand-OK geklemmt, damit die Öffnung nie über den Wandkopf hinausragt.
 */
export function openingVerticalExtent(
  project: Project,
  wall: Wall,
  o: Opening,
): { zBottom: number; zTop: number } {
  const { zBottom, zTop } = wallVerticalExtent(project, wall);
  const sill = Math.max(0, o.sillHeight);
  const oBottom = zBottom + sill;
  const oTop = Math.min(zTop, oBottom + o.height);
  return { zBottom: oBottom, zTop: oTop };
}

/** Einheits-Laufrichtung (u) und linke Normale (n) der Wandachse. */
export function wallAxisFrame(wall: Wall): { u: Vec2; n: Vec2 } {
  const u = normalize(sub(wall.end, wall.start));
  return { u, n: leftNormal(u) };
}

/** Die beiden Pfosten-Punkte (auf der Achse) einer Öffnung im Grundriss. */
export function openingJambs(
  wall: Wall,
  o: Opening,
): { jambStart: Vec2; jambEnd: Vec2 } | null {
  const iv = openingInterval(wall, o);
  if (!iv) return null;
  return {
    jambStart: along(wall.start, wall.end, iv.from),
    jambEnd: along(wall.start, wall.end, iv.to),
  };
}

/**
 * Die Lücken-Rechteck-Ecken (über die volle Wanddicke), z. B. um im Plan die
 * Öffnung als Aussparung zu markieren (Auswahl-Highlight). Reihenfolge:
 * jambStart(+n/2) → jambEnd(+n/2) → jambEnd(−n/2) → jambStart(−n/2).
 */
export function openingGapQuad(project: Project, wall: Wall, o: Opening): Vec2[] | null {
  const jambs = openingJambs(wall, o);
  if (!jambs) return null;
  const { n } = wallAxisFrame(wall);
  const total = wallTypeThickness(getWallType(project, wall));
  const refOff = wallReferenceOffset(wall, total);
  const outer = refOff + total / 2;
  const inner = refOff - total / 2;
  const { jambStart, jambEnd } = jambs;
  return [
    add(jambStart, scale(n, outer)),
    add(jambEnd, scale(n, outer)),
    add(jambEnd, scale(n, inner)),
    add(jambStart, scale(n, inner)),
  ];
}

/** Mittelpunkt einer Öffnung im Grundriss (Achse) — für HUD/Auswahl-Anker. */
export function openingCenter(wall: Wall, o: Opening): Vec2 | null {
  const iv = openingInterval(wall, o);
  if (!iv) return null;
  return along(wall.start, wall.end, (iv.from + iv.to) / 2);
}

// ── Fenster-Symbol (Plan) ────────────────────────────────────────────────────

/** Aufgelöste Fenster-Linien im Grundriss (Weltkoordinaten). */
export interface WindowSymbol {
  /** Rahmen-Rechteck (volle Dicke) als Ecken. */
  frame: Vec2[];
  /** Glaslinien-Segmente quer über die Lücke (1–3 parallele Linien). */
  glassLines: [Vec2, Vec2][];
  /**
   * Flügel-/Pfosten-Trennlinien, jeweils von einer Laibungsseite zur anderen
   * (parallel zu den Laibungslinien, quer zur Öffnungsrichtung). Ist `sashes`
   * (dritter Parameter von {@link windowSymbol}) gesetzt, ergeben sich die
   * Positionen aus den Flügel-/Pfostenbreiten (siehe `sashSegments`); sonst
   * (Alt-Fall) `wingCount − 1` gleichmäßig verteilte Querlinien. Entspricht den
   * Mittelpfosten in `_make_oeffnung_pieces` des Rhino-Plugins (`oeff_fluegel`).
   */
  mullionLines: [Vec2, Vec2][];
  /**
   * Flügelrahmen (Flügelkontur) je ÖFFENBAREM Flügel (Dreh/Kipp/Drehkipp/
   * Schiebe): ein Rechteck INNERHALB des Blendrahmens (Schachtelung
   * Blendrahmen → Flügelrahmen → Glas), das den öffenbaren Flügel vom festen
   * Feld unterscheidet. Feste Flügel (`opening:"fest"`) bekommen KEINEN
   * Flügelrahmen — dort sitzt das Glas direkt im Blendrahmen. Nur befüllt im
   * neuen (spec-)Pfad; leer im Alt-Fall (kein `spec`).
   */
  sashFrames: Vec2[][];
  /**
   * (Alt-Feld, für Rückwärtskompatibilität der Schnittstelle beibehalten) — im
   * neuen Pfad leer; die Öffenbarkeit wird jetzt über {@link sashFrames}
   * ausgedrückt statt über eine Diagonale quer über die Box.
   */
  sashOpeningLines: [Vec2, Vec2][];
  /**
   * Stulp-/Flügelstoss-Marken (SIA-„kleines Quadrat mittig", Figur 37/38): je
   * Flügel-Trennung ein kleines Rechteck-Polygon auf der Glasebene, das den
   * Anschlag der zwei zusammenstossenden Flügelprofile darstellt. Bei „mittel"
   * ein Quadrat je Stoss, bei „fein" zwei (die beiden Stulpprofile). „grob":
   * leer. Zählt zur "Fenster"-Linien-Kategorie (Flügel/Sprossen), NICHT zum
   * Blendrahmen — separat von {@link jambMarks} steuerbar. Der Aufrufer
   * zeichnet sie als dünne Umriss-Rechtecke.
   */
  meetingMarks: Vec2[][];
  /**
   * Blendrahmen-Querschnittsblöcke an den beiden Laibungs-Enden (ein Block je
   * Seite, unabhängig von Flügelanzahl/Detailgrad) — Teil des Blendrahmens,
   * zählt zur "Rahmen"-Linien-Kategorie (im Unterschied zu {@link meetingMarks},
   * die an inneren Flügelstössen sitzen und zur "Fenster"-Kategorie zählen).
   */
  jambMarks: Vec2[][];
}

/**
 * Render-Parameter des Fensters für die reiche 2D-Symbolik (aus dem
 * referenzierten {@link WindowType}): Flügeltabelle, Profilbreite, Rahmentiefe
 * und Schichteinzug. Fehlt der Spec (kein Typ auflösbar), zeichnet
 * {@link windowSymbol} das schlichte Alt-Symbol (`o.wingCount`, volle Wanddicke).
 */
export interface WindowRenderSpec {
  sashes: SashDef[];
  /** Sichtbare Profilbreite (Meter) von Blend-/Flügelrahmen in der Öffnungsebene. */
  frameWidth: number;
  /** Rahmentiefe quer zur Wand (Meter); fehlt ⇒ {@link DEFAULT_FRAME_DEPTH}. */
  frameDepth?: number;
  /** Schichteinzug: Abstand der Rahmen-Vorderkante von {@link insetFace} (Meter). */
  insetFromFace?: number;
  /** Bezugsfläche des Schichteinzugs; Default "aussen". */
  insetFace?: "aussen" | "innen";
}

/**
 * Löst die Fenster-Symbolik auf: ein Rahmen-Rechteck über die Lücke (volle
 * Wanddicke) plus 1–3 Glaslinien (dünne parallele Linien in der Wandmitte,
 * `glassCount` steuert die Anzahl) plus optionale Flügel-/Pfosten-Trennlinien
 * und Öffnungsandeutungen je Flügel.
 *
 * `sashes` (optional) ist die aufgelöste Flügeltabelle (siehe
 * `sashesOfWindowType`) EINES referenzierten Fenstertyps. Fehlt sie (kein Typ
 * referenziert/auflösbar), bleibt die Mittelpfosten-Berechnung beim
 * BISHERIGEN Verhalten — `o.wingCount` gleichmäßig verteilt, KEINE
 * Öffnungsandeutungen — exakt wie vor dieser Erweiterung (Rückwärtskompatibilität).
 *
 * Die Berechnung läuft im Rust-Kern (`src-tauri/core/src/opening_geom.rs`, [K3a]); diese Funktion
 * ist die Fassade mit unveränderter Signatur.
 */
export function windowSymbol(
  project: Project,
  wall: Wall,
  o: Opening,
  glassCount: number,
  spec?: WindowRenderSpec,
  detail: "grob" | "mittel" | "fein" = "fein",
): WindowSymbol | null {
  const total = wallTypeThickness(getWallType(project, wall));
  const b: number[] = [
    wall.start.x, wall.start.y, wall.end.x, wall.end.y, total, wallReferenceOffset(wall, total),
    o.position, o.width, glassCount, o.wingCount ?? Number.NaN,
    detail === "grob" ? 0 : detail === "mittel" ? 1 : 2,
    spec ? 1 : 0,
    spec?.frameWidth ?? 0, spec?.frameDepth ?? Number.NaN, spec?.insetFromFace ?? Number.NaN,
    spec?.insetFace === "innen" ? 1 : 0,
    spec?.sashes.length ?? 0,
  ];
  for (const s of spec?.sashes ?? []) {
    b.push(s.kind === "pfosten" ? 1 : 0, s.autoWidth === false ? 0 : 1, s.width ?? Number.NaN, s.postWidth ?? Number.NaN,
      s.opening && s.opening !== "fest" ? 1 : 0);
  }
  const f = core().window_symbol_flat(Float64Array.from(b));
  if (f.length === 0) return null;
  let i = 1;
  const pt = (): Vec2 => ({ x: f[i++], y: f[i++] });
  const frame = [pt(), pt(), pt(), pt()];
  const segs = (): [Vec2, Vec2][] => {
    const n = f[i++];
    const out: [Vec2, Vec2][] = [];
    for (let k = 0; k < n; k++) out.push([pt(), pt()]);
    return out;
  };
  const rings = (): Vec2[][] => {
    const n = f[i++];
    const out: Vec2[][] = [];
    for (let k = 0; k < n; k++) {
      const m = f[i++];
      out.push(Array.from({ length: m }, pt));
    }
    return out;
  };
  const glassLines = segs();
  const mullionLines = segs();
  const sashFrames = rings();
  const meetingMarks = rings();
  const jambMarks = rings();
  return { frame, glassLines, mullionLines, sashFrames, sashOpeningLines: [], meetingMarks, jambMarks };
}

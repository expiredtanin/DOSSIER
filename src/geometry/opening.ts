// Geometrie-Helfer für Öffnungen (Fenster/Türen) — reine Funktionen, die eine
// `Opening` relativ zu ihrer Wirts-Wand in konkrete Welt-Geometrie auflösen:
//   • die Öffnungs-Lücke entlang der Wandachse (from/to in Metern),
//   • das Türblatt (Scharnier → offenes/geschlossenes Ende) + Schwenkbogen,
//   • die Fenster-Rahmen-/Glaslinien quer über die Lücke,
//   • die vertikale Lage (UK/OK der Öffnung, absolut in Metern).
//
// Da JEDE Größe aus der aktuellen Wandachse (`wall.start`/`wall.end`) abgeleitet
// wird, folgt eine Öffnung ihrer Wand automatisch, sobald die Wand bewegt wird —
// es gibt keine eingebackenen Weltkoordinaten.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { Opening, Project, SashDef, Vec2, Wall } from "../model/types";
import { getWallType, wallTypeThickness } from "../model/types";
import { add, along, leftNormal, normalize, scale, sub } from "../model/geometry";
import { wallReferenceOffset, wallVerticalExtent } from "../model/wall";

const DEG = Math.PI / 180;

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

// ── Tür-Symbol (Plan) ────────────────────────────────────────────────────────

/** Aufgelöste Tür-Symbol-Geometrie im Grundriss (Weltkoordinaten). */
export interface DoorSymbol {
  /** Scharnierpunkt (auf der Achse). */
  hinge: Vec2;
  /** Ende des Blatts in GEÖFFNETER Stellung. */
  openEnd: Vec2;
  /** Ende des Blatts in GESCHLOSSENER Stellung (Bogen-Startpunkt). */
  closedEnd: Vec2;
  /** Radius (= Türbreite) des Schwenkbogens. */
  radius: number;
  /** Beide Pfosten-Punkte (für Rahmen-/Anschlagstriche). */
  jambStart: Vec2;
  jambEnd: Vec2;
  /** Achs-Normale (für kurze Anschlagstriche quer zur Wand). */
  normal: Vec2;
}

/**
 * Löst die Tür-Symbolik auf. `swing` wählt die Aufschlagseite (linke/rechte
 * Achs-Normale), `openingDir` ("out") spiegelt sie auf die andere Seite,
 * `hinge` wählt den Scharnier-Pfosten, `swingAngle` (Grad, Default 90) bestimmt,
 * wie weit das Blatt in der offenen Stellung aufsteht.
 */
export function doorSymbol(wall: Wall, o: Opening): DoorSymbol | null {
  const jambs = openingJambs(wall, o);
  if (!jambs) return null;
  const { u, n } = wallAxisFrame(wall);
  const { jambStart, jambEnd } = jambs;
  const width = Math.hypot(jambEnd.x - jambStart.x, jambEnd.y - jambStart.y);

  const swingSign = (o.swing ?? "left") === "left" ? 1 : -1;
  const dirSign = (o.openingDir ?? "in") === "in" ? 1 : -1;
  const swingDir = scale(n, swingSign * dirSign);

  const hinge = (o.hinge ?? "start") === "start" ? jambStart : jambEnd;
  // Geschlossene Richtung zeigt vom Scharnier zum GEGENüberliegenden Pfosten.
  const closedDir = (o.hinge ?? "start") === "start" ? u : scale(u, -1);

  const angle = (o.swingAngle ?? 90) * DEG;
  // Offenes Blatt-Ende: um `angle` von der geschlossenen Richtung zur
  // Schwenkrichtung gedreht (Interpolation über die Basis closedDir/swingDir).
  const openDir = {
    x: closedDir.x * Math.cos(angle) + swingDir.x * Math.sin(angle),
    y: closedDir.y * Math.cos(angle) + swingDir.y * Math.sin(angle),
  };
  return {
    hinge,
    openEnd: add(hinge, scale(openDir, width)),
    closedEnd: add(hinge, scale(closedDir, width)),
    radius: width,
    jambStart,
    jambEnd,
    normal: n,
  };
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
   * Öffnungsandeutung je NICHT-festem Flügel (Dreh/Kipp/Drehkipp/Schiebe): eine
   * einzelne Diagonale über die Flügelfläche, von der äusseren Ecke der
   * Bandseite GEGENüberliegenden Seite (aussen) zur Bandseite (innen) — eine
   * schlichte Andeutung der Öffnungsrichtung, analog zur Schwenkbogen-Andeutung
   * bei Türen, aber ohne Bogen (P0-Minimalfassung). Nur befüllt, wenn `sashes`
   * übergeben wird; leer im Alt-Fall (kein `sashes`).
   */
  sashOpeningLines: [Vec2, Vec2][];
}

/** Ein Segment (Flügel/Pfosten) der Flügeleinteilung, mit aufgelöster Breite. */
interface SashSegment {
  sash: SashDef;
  /** Abstand vom Laibungsstart in Metern (0 = jambStart). */
  from: number;
  /** Abstand vom Laibungsstart in Metern. */
  to: number;
}

/** Default-Pfostenbreite (Meter), wenn ein `kind:"pfosten"`-Eintrag keine `postWidth` angibt. */
const DEFAULT_POST_WIDTH = 0.06;

/**
 * Löst eine Flügeleinteilung ({@link SashDef}-Liste) zu konkreten Segment-
 * Intervallen (Meter, gemessen ab Laibungsstart) über die gegebene
 * Gesamtbreite auf: `kind:"pfosten"` und Flügel mit `autoWidth === false`
 * erhalten ihre feste Breite (`postWidth` bzw. `width`), die restlichen
 * (`autoWidth`, Default) teilen sich die verbleibende Breite gleichmäßig.
 * Degeneriert bei GLEICHMÄSSIGEN Flügeln (alle `autoWidth`, keine Pfosten) zur
 * bisherigen `wingCount`-Gleichverteilung (Regressionssicherheit).
 */
function sashSegments(sashes: SashDef[], totalWidth: number): SashSegment[] {
  if (sashes.length === 0) return [];
  let fixedSum = 0;
  let autoCount = 0;
  for (const s of sashes) {
    if (s.kind === "pfosten") fixedSum += Math.max(0, s.postWidth ?? DEFAULT_POST_WIDTH);
    else if (s.autoWidth === false) fixedSum += Math.max(0, s.width ?? 0);
    else autoCount++;
  }
  const remaining = Math.max(0, totalWidth - fixedSum);
  const autoWidth = autoCount > 0 ? remaining / autoCount : 0;
  const segs: SashSegment[] = [];
  let cursor = 0;
  for (const s of sashes) {
    const w =
      s.kind === "pfosten"
        ? Math.max(0, s.postWidth ?? DEFAULT_POST_WIDTH)
        : s.autoWidth === false
          ? Math.max(0, s.width ?? 0)
          : autoWidth;
    segs.push({ sash: s, from: cursor, to: cursor + w });
    cursor += w;
  }
  return segs;
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
 */
export function windowSymbol(
  project: Project,
  wall: Wall,
  o: Opening,
  glassCount: number,
  sashes?: SashDef[],
): WindowSymbol | null {
  const jambs = openingJambs(wall, o);
  if (!jambs) return null;
  const { n } = wallAxisFrame(wall);
  const total = wallTypeThickness(getWallType(project, wall));
  const refOff = wallReferenceOffset(wall, total);
  const outer = refOff + total / 2;
  const inner = refOff - total / 2;
  const { jambStart, jambEnd } = jambs;
  const frame = [
    add(jambStart, scale(n, outer)),
    add(jambEnd, scale(n, outer)),
    add(jambEnd, scale(n, inner)),
    add(jambStart, scale(n, inner)),
  ];
  const glassLines: [Vec2, Vec2][] = [];
  const count = Math.max(1, glassCount);
  for (let i = 0; i < count; i++) {
    // Glaslinien symmetrisch um die Wandmitte verteilt (Abstand = Dicke/8).
    const spread = total / 8;
    const off = refOff + (count === 1 ? 0 : (i - (count - 1) / 2) * spread * 2);
    glassLines.push([add(jambStart, scale(n, off)), add(jambEnd, scale(n, off))]);
  }
  const mullionLines: [Vec2, Vec2][] = [];
  const sashOpeningLines: [Vec2, Vec2][] = [];
  if (sashes && sashes.length > 0) {
    // Neuer Weg: Trennlinien + Öffnungsandeutungen aus der Flügeltabelle.
    const axisWidth = Math.hypot(jambEnd.x - jambStart.x, jambEnd.y - jambStart.y);
    const segs = sashSegments(sashes, axisWidth);
    const postDepth = total * 0.6;
    const pOuter = refOff + postDepth / 2;
    const pInner = refOff - postDepth / 2;
    for (let i = 0; i < segs.length - 1; i++) {
      const onAxis = along(jambStart, jambEnd, segs[i].to);
      mullionLines.push([add(onAxis, scale(n, pOuter)), add(onAxis, scale(n, pInner))]);
    }
    for (const seg of segs) {
      if (seg.sash.kind !== "fluegel") continue;
      const kind = seg.sash.opening;
      if (!kind || kind === "fest") continue;
      // Bandseite "left" = Scharnier am Laibungsstart (jambStart-Seite), "right"
      // = am Laibungsende. Die Diagonale läuft von der GEGENüberliegenden
      // Aussenecke zur Bandecke (innen) — schlichte Andeutung, kein Schwenkbogen.
      const hingeAtStart = (seg.sash.hingeSide ?? "left") === "left";
      const hingeAxis = along(jambStart, jambEnd, hingeAtStart ? seg.from : seg.to);
      const farAxis = along(jambStart, jambEnd, hingeAtStart ? seg.to : seg.from);
      sashOpeningLines.push([add(farAxis, scale(n, outer)), add(hingeAxis, scale(n, inner))]);
    }
  } else {
    // Alt-Fall (kein sashes): (wingCount − 1) Querlinien gleichmäßig zwischen
    // den Pfosten. Jede Linie läuft quer über die Öffnung (n-Richtung), auf
    // ~60 % der Mauerdicke symmetrisch um die Wandmitte (Referenz-Offset) —
    // analog Rhino, wo die Pfosten x_mid = inner_l + span·(i/fluegel) über die
    // Rahmentiefe sitzen. UNVERÄNDERT gegenüber dem bisherigen Verhalten.
    const wings = Math.max(1, Math.min(4, Math.round(o.wingCount ?? 1)));
    if (wings > 1) {
      const postDepth = total * 0.6;
      const pOuter = refOff + postDepth / 2;
      const pInner = refOff - postDepth / 2;
      for (let i = 1; i < wings; i++) {
        const t = i / wings; // gleichmäßige Teilung entlang der Achse
        const onAxis = add(jambStart, scale(sub(jambEnd, jambStart), t));
        mullionLines.push([add(onAxis, scale(n, pOuter)), add(onAxis, scale(n, pInner))]);
      }
    }
  }
  return { frame, glassLines, mullionLines, sashOpeningLines };
}

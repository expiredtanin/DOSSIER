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

/** Ein einzelnes Türblatt (Grundriss): Scharnier + geschlossenes/offenes Ende + Radius. */
export interface DoorLeaf {
  hinge: Vec2;
  openEnd: Vec2;
  closedEnd: Vec2;
  radius: number;
}

/** Blatt-Geometrie aus Scharnier, geschlossener Richtung, Schwenkrichtung, Winkel, Breite. */
function computeLeaf(
  hinge: Vec2,
  closedDir: Vec2,
  swingDir: Vec2,
  angle: number,
  width: number,
): DoorLeaf {
  const openDir = {
    x: closedDir.x * Math.cos(angle) + swingDir.x * Math.sin(angle),
    y: closedDir.y * Math.cos(angle) + swingDir.y * Math.sin(angle),
  };
  return {
    hinge,
    openEnd: add(hinge, scale(openDir, width)),
    closedEnd: add(hinge, scale(closedDir, width)),
    radius: width,
  };
}

/**
 * Türblätter im Grundriss (1 oder 2 Flügel). Einflüglig: ein Blatt über die
 * volle Breite (Scharnier je `o.hinge`). Zweiflüglig (`leafCount === 2`): zwei
 * halbbreite Blätter, an den GEGENüberliegenden Pfosten angeschlagen, beide zur
 * selben Seite schwenkend (symmetrische Doppeltür / Stulptür). `doorSymbol`
 * bleibt unverändert (einflügelig) für Bestandspfade/Parität; dies ist additiv.
 */
export function doorLeaves(wall: Wall, o: Opening, leafCount: number): DoorLeaf[] {
  const jambs = openingJambs(wall, o);
  if (!jambs) return [];
  const { u, n } = wallAxisFrame(wall);
  const { jambStart, jambEnd } = jambs;
  const width = Math.hypot(jambEnd.x - jambStart.x, jambEnd.y - jambStart.y);
  const swingSign = (o.swing ?? "left") === "left" ? 1 : -1;
  const dirSign = (o.openingDir ?? "in") === "in" ? 1 : -1;
  const swingDir = scale(n, swingSign * dirSign);
  const angle = (o.swingAngle ?? 90) * DEG;
  if (leafCount >= 2) {
    const hw = width / 2;
    return [
      computeLeaf(jambStart, u, swingDir, angle, hw),
      computeLeaf(jambEnd, scale(u, -1), swingDir, angle, hw),
    ];
  }
  const hinge = (o.hinge ?? "start") === "start" ? jambStart : jambEnd;
  const closedDir = (o.hinge ?? "start") === "start" ? u : scale(u, -1);
  return [computeLeaf(hinge, closedDir, swingDir, angle, width)];
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
 * Default-Rahmentiefe (Meter), wenn ein Fenster-/Türtyp keine explizite
 * `frameDepth` trägt: reale Fensterrahmen sind ~70–90 mm tief (Holz/PVC/Alu),
 * unabhängig von der Wanddicke — NICHT die volle Wanddicke (das liess Fenster
 * wie einen massiven Block in der Öffnung wirken statt eines schlanken Rahmens
 * mit sichtbarer Laibung/Leibung ringsum, s. Recherche zu VW/ArchiCAD-Fenster-
 * konstruktion). Deckt sich mit `toWalls3d.ts::DEFAULT_FRAME_DEPTH` (2D=3D).
 */
const DEFAULT_FRAME_DEPTH = 0.07;

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
  spec?: WindowRenderSpec,
  detail: "grob" | "mittel" | "fein" = "fein",
): WindowSymbol | null {
  const jambs = openingJambs(wall, o);
  if (!jambs) return null;
  const { n } = wallAxisFrame(wall);
  const total = wallTypeThickness(getWallType(project, wall));
  const refOff = wallReferenceOffset(wall, total);
  const outer = refOff + total / 2;
  const inner = refOff - total / 2;
  const { jambStart, jambEnd } = jambs;

  // ── Reicher Pfad (typisiertes Fenster mit Flügeltabelle), SIA-Darstellung ─
  // Detailstufe = SIA-Massstab (fig. 36/37/38):
  //   • grob  (1:100): NUR Blendrahmen-Band + eine Glaslinie über die ganze
  //     Öffnung — schematisch (SIA fig. 36).
  //   • mittel(1:50):  Blendrahmen + Flügel-Trennlinien + je Flügel eine Glas-
  //     linie + kleines Stulp-Quadrat je Stoss (SIA fig. 37). KEINE Flügelrahmen.
  //   • fein  (1:20):  zusätzlich verschachtelte Flügelrahmen, Glas als Doppel-
  //     linie (Isolierverglasung) und je Stoss ZWEI Stulp-Quadrate (SIA fig. 38).
  if (spec && spec.sashes.length > 0) {
    const fw = Math.max(0.01, spec.frameWidth);
    const depth = Math.min(total, spec.frameDepth && spec.frameDepth > 1e-9 ? spec.frameDepth : DEFAULT_FRAME_DEPTH);
    const inset = Math.max(0, spec.insetFromFace ?? 0);
    const halfT = total / 2;
    const sign = (spec.insetFace ?? "aussen") === "innen" ? -1 : 1;
    // Rahmen-Vorderkante bündig mit der Bezugsfläche, um `inset` zurück; der
    // Körper reicht `depth` zur Wandmitte. Auf die Wanddicke geklemmt (mirror
    // von resolveFrameNormalRange im 3D). Alles relativ zur Referenzlinie.
    let frontRel = sign * (halfT - inset);
    let backRel = frontRel - sign * depth;
    frontRel = Math.max(-halfT, Math.min(halfT, frontRel));
    backRel = Math.max(-halfT, Math.min(halfT, backRel));
    const frameOuterN = refOff + Math.max(frontRel, backRel);
    const frameInnerN = refOff + Math.min(frontRel, backRel);
    const bandDepth = frameOuterN - frameInnerN;
    const gMidBase = (frameOuterN + frameInnerN) / 2;

    const frame = [
      add(jambStart, scale(n, frameOuterN)),
      add(jambEnd, scale(n, frameOuterN)),
      add(jambEnd, scale(n, frameInnerN)),
      add(jambStart, scale(n, frameInnerN)),
    ];

    const glassLines: [Vec2, Vec2][] = [];
    const mullionLines: [Vec2, Vec2][] = [];
    const sashFrames: Vec2[][] = [];
    const meetingMarks: Vec2[][] = [];
    const jambMarks: Vec2[][] = [];

    // grob (1:100): nur der Rahmenkasten + EINE Glaslinie über die ganze Öffnung.
    if (detail === "grob") {
      glassLines.push([add(jambStart, scale(n, gMidBase)), add(jambEnd, scale(n, gMidBase))]);
      return { frame, glassLines, mullionLines, sashFrames, sashOpeningLines: [], meetingMarks, jambMarks };
    }

    const fein = detail === "fein";
    const axisWidth = Math.hypot(jambEnd.x - jambStart.x, jambEnd.y - jambStart.y);
    const segs = sashSegments(spec.sashes, axisWidth);
    // Öffenbarer Flügel sitzt `reveal` tiefer im Blendrahmen (nur „fein").
    const reveal = fein ? Math.min(bandDepth * 0.3, fw * 0.7) : 0;
    // Profil-Block über die VOLLE Rahmentiefe (aussen bis innen), Breite `2·halfU`
    // entlang der Achse, zentriert bei `uCenter` (Achsabstand ab jambStart) — der
    // Rahmenquerschnitt, wie er im Grundriss-Schnitt sichtbar ist (Nutzer:
    // „Rahmen aussen als zwei Flächen gleichbreit wie das Fenster [tief]").
    const frameBlock = (uCenter: number, halfU: number): Vec2[] => {
      const a = along(jambStart, jambEnd, uCenter - halfU);
      const b = along(jambStart, jambEnd, uCenter + halfU);
      return [
        add(a, scale(n, frameOuterN)),
        add(b, scale(n, frameOuterN)),
        add(b, scale(n, frameInnerN)),
        add(a, scale(n, frameInnerN)),
      ];
    };
    // Laibungs-Pfosten an beiden Enden (Blendrahmen-Querschnitt an der Wand-
    // öffnung) — EIN Block je Seite, unabhängig vom Detailgrad. Teil des
    // Blendrahmens (jambMarks), NICHT der Flügelstoss-Marken (meetingMarks) —
    // separat steuerbar (Nutzer-Feedback).
    jambMarks.push(frameBlock(fw / 2, fw / 2), frameBlock(axisWidth - fw / 2, fw / 2));

    // Flügel-Trennlinien (Mittelpfosten) an den inneren Segmentgrenzen +
    // Stulp-Block: mittel 1, fein 2 (die beiden zusammenstossenden Profile) —
    // je über die volle Rahmentiefe. KEINE zusätzliche dünne Trennlinie mehr
    // daneben (Nutzer-Feedback: „keine vertikale Trennlinie, sondern ein
    // Rechteck") — der Block selbst markiert den Stoss.
    for (let i = 0; i < segs.length - 1; i++) {
      const uPos = segs[i].to;
      if (fein) {
        meetingMarks.push(frameBlock(uPos - fw / 2, fw / 2), frameBlock(uPos + fw / 2, fw / 2));
      } else {
        meetingMarks.push(frameBlock(uPos, fw / 2));
      }
    }

    for (const seg of segs) {
      if (seg.sash.kind === "pfosten") continue;
      const clearFrom = seg.from + fw;
      const clearTo = seg.to - fw;
      if (clearTo - clearFrom <= 1e-6) continue;
      const operable = !!seg.sash.opening && seg.sash.opening !== "fest";
      // „mittel" (SIA fig. 37) zeigt NUR Blendrahmen + Pfosten/Stulp — noch KEINE
      // Glaslinie/Flügelrahmen (Nutzer-Vorgabe: „im 1:50 muss man die Fenster-
      // linie noch nicht sehen, nur die Vierecke aussen/innen"). Das kommt erst
      // bei „fein" (SIA fig. 38) dazu.
      if (!fein) continue;
      const gOuterN = frameOuterN - (operable ? reveal : 0);
      const gInnerN = frameInnerN + (operable ? reveal : 0);
      // Verschachtelter Flügelrahmen NUR bei „fein" (SIA fig. 38); „mittel" bleibt
      // beim reinen Blendrahmen-Band (SIA fig. 37).
      // Keine Glaslinie mehr im Feld (auch nicht bei „fein") — Nutzer-Feedback:
      // eine feine Haarlinie mittig im Glasfeld wird nicht gebraucht, unabhängig
      // von der Fensterposition. Der Flügelrahmen (nur bei öffenbaren Flügeln)
      // bleibt als einzige zusätzliche Kontur bei „fein" bestehen.
      if (operable) {
        const sFrom = along(jambStart, jambEnd, clearFrom);
        const sTo = along(jambStart, jambEnd, clearTo);
        sashFrames.push([
          add(sFrom, scale(n, gOuterN)),
          add(sTo, scale(n, gOuterN)),
          add(sTo, scale(n, gInnerN)),
          add(sFrom, scale(n, gInnerN)),
        ]);
      }
    }
    return { frame, glassLines, mullionLines, sashFrames, sashOpeningLines: [], meetingMarks, jambMarks };
  }

  // ── Alt-Pfad (kein Typ auflösbar) ────────────────────────────────────────
  // UNVERÄNDERT (Rust-Parität kernel2d): Rahmen an voller Wanddicke, Glaslinien
  // mittig, (wingCount−1) gleichmäßige Mittelpfosten. Keine Flügelrahmen.
  const frame = [
    add(jambStart, scale(n, outer)),
    add(jambEnd, scale(n, outer)),
    add(jambEnd, scale(n, inner)),
    add(jambStart, scale(n, inner)),
  ];
  const glassLines: [Vec2, Vec2][] = [];
  const count = Math.max(1, glassCount);
  for (let i = 0; i < count; i++) {
    const spread = total / 8;
    const off = refOff + (count === 1 ? 0 : (i - (count - 1) / 2) * spread * 2);
    glassLines.push([add(jambStart, scale(n, off)), add(jambEnd, scale(n, off))]);
  }
  const mullionLines: [Vec2, Vec2][] = [];
  const wings = Math.max(1, Math.min(4, Math.round(o.wingCount ?? 1)));
  if (wings > 1) {
    const postDepth = total * 0.6;
    const pOuter = refOff + postDepth / 2;
    const pInner = refOff - postDepth / 2;
    for (let i = 1; i < wings; i++) {
      const t = i / wings;
      const onAxis = add(jambStart, scale(sub(jambEnd, jambStart), t));
      mullionLines.push([add(onAxis, scale(n, pOuter)), add(onAxis, scale(n, pInner))]);
    }
  }
  return { frame, glassLines, mullionLines, sashFrames: [], sashOpeningLines: [], meetingMarks: [], jambMarks: [] };
}

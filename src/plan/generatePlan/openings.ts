// Öffnungs-Domäne des Grundriss-Generators: Tür-/Fenstersymbole je Detailgrad
// (Blatt/Schwenkbogen/Anschlag bzw. Rahmen/Sprossen/Glas), das optionale
// Rahmenband (Zarge/Blockrahmen) samt Schichteinzug aus der Typ-Bibliothek,
// sowie das Legacy-Türsymbol (`Door`, vor der Öffnungs-Typ-Bibliothek).

import type { Opening, Project, Vec2, Wall } from "../../model/types";
import {
  getDoorType,
  getWindowType,
  getWallType,
  sashesOfWindowType,
  wallTypeThickness,
} from "../../model/types";
import {
  doorLeaves,
  doorSymbol,
  openingGapQuad,
  openingJambs,
  wallAxisFrame,
  windowSymbol,
} from "../../geometry/opening";
import { wallReferenceOffset } from "../../model/wall";
import { add, along, dot, leftNormal, normalize, scale, sub } from "../../model/geometry";
import {
  NO_HATCH,
  OVERHEAD_DASH,
  POCHE_STROKE,
  SYMBOL_HAIRLINE_MM,
  type DetailLevel,
  type Primitive,
} from "./shared";

/**
 * Tür-Symbol je Detailgrad:
 *  • grob   — nur die gerade Türblatt-Linie (die Öffnungs-Lücke kommt aus der
 *             ausgesparten Poché).
 *  • mittel — + Schwenkbogen (geschlossen → offen).
 *  • fein   — + Rahmen/Anschlag-Striche an beiden Pfosten (kurze Striche quer
 *             zur Wand, die den Türrahmen/-anschlag andeuten).
 */
export function addDoorSymbol(
  out: Primitive[],
  wall: Wall,
  door: Project["doors"][number],
  greyed: boolean,
  detail: DetailLevel,
  _doorLwMm: number,
): void {
  const u = normalize(sub(wall.end, wall.start));
  const n = leftNormal(u); // linke Seite der Wandachse
  const swingDir = door.swing === "left" ? n : scale(n, -1);

  const jambStart = along(wall.start, wall.end, door.position);
  const jambEnd = along(wall.start, wall.end, door.position + door.width);
  const hinge = door.hinge === "start" ? jambStart : jambEnd;
  const closedDir = door.hinge === "start" ? u : scale(u, -1);

  const openEnd = add(hinge, scale(swingDir, door.width));
  const closedEnd = add(hinge, scale(closedDir, door.width));

  // Türblatt in geöffneter Stellung (alle Stufen).
  out.push({
    kind: "line",
    a: hinge,
    b: openEnd,
    cls: "door-leaf",
    weightMm: SYMBOL_HAIRLINE_MM,
    greyed,
  });

  // mittel + fein: Schwenkbogen von geschlossen → offen.
  if (detail !== "grob") {
    out.push({
      kind: "arc",
      center: hinge,
      from: closedEnd,
      to: openEnd,
      r: door.width,
      cls: "door-swing",
      weightMm: SYMBOL_HAIRLINE_MM,
      greyed,
    });
  }

  // fein: Rahmen/Anschlag-Striche an beiden Pfosten (kurz quer zur Wand,
  // symmetrisch um die Achse über eine halbe Wanddicke-Andeutung).
  if (detail === "fein") {
    const reveal = 0.06; // 6 cm Anschlag-Andeutung je Seite
    for (const jamb of [jambStart, jambEnd]) {
      out.push({
        kind: "line",
        a: add(jamb, scale(n, reveal)),
        b: add(jamb, scale(n, -reveal)),
        cls: "door-frame",
        weightMm: SYMBOL_HAIRLINE_MM,
        greyed,
      });
    }
  }
}

/**
 * Aufgelöste Rahmen-Parameter (Typ-Bibliothek) einer Tür-/Fenster-Öffnung —
 * nur vorhanden, wenn die Öffnung einen Bauteil-Typ referenziert (`typeId`).
 * Fehlt der Typ, bleibt das heutige Inline-Verhalten unverändert (kein
 * Rahmenband, kein Oberlicht) — siehe `resolveOpeningFrameSpec`.
 */
interface OpeningFrameSpec {
  frameWidth: number;
  /** Nur bei Türen relevant; Fenster zeichnen stets die schmale Zargen-Optik. */
  frameKind: "zarge" | "blockrahmen";
  insetFromFace: number;
  insetFace: "aussen" | "innen";
  transomHeight: number;
}

/**
 * Löst die Rahmen-Parameter aus dem referenzierten Tür-/Fenstertyp auf (samt
 * Defaults); `undefined`, wenn kein Typ referenziert/auflösbar ist — die
 * Öffnung bleibt dann beim heutigen Inline-Verhalten (rückwärtskompatibel).
 */
function resolveOpeningFrameSpec(project: Project, o: Opening): OpeningFrameSpec | undefined {
  if (o.kind === "door") {
    const t = getDoorType(project, o);
    if (!t) return undefined;
    return {
      frameWidth: t.frameWidth ?? 0.06,
      frameKind: t.frameKind ?? "zarge",
      insetFromFace: t.insetFromFace ?? 0,
      insetFace: t.insetFace ?? "aussen",
      transomHeight: t.transomHeight ?? 0,
    };
  }
  const t = getWindowType(project, o);
  if (!t) return undefined;
  return {
    frameWidth: t.frameWidth ?? 0.06,
    frameKind: "zarge",
    insetFromFace: t.insetFromFace ?? 0,
    insetFace: t.insetFace ?? "aussen",
    transomHeight: t.transomHeight ?? 0,
  };
}

/**
 * Rahmenband + Oberlicht-Andeutung einer Tür-/Fenstertyp-Öffnung im
 * Grundriss-Schnitt. Nur aufgerufen, wenn `resolveOpeningFrameSpec` einen Typ
 * liefert — sonst bleibt die Darstellung exakt wie zuvor (kein neues Primitiv).
 *
 *  • Zarge             — schmales Umlauf-Rahmenband, ringsum um `frameWidth`
 *    von der vollen Öffnung (Pfosten × Wanddicke) nach innen eingezogen.
 *  • Blockrahmen (Tür) — kräftiges Rechteckprofil, sitzt PROUD an der
 *    gewählten Fläche (kein Einzug an den Pfosten, nur eine Tiefenscheibe von
 *    `frameWidth` ab der Nah-Fläche), kräftigere Linie.
 *  • Schichteinzug     — verschiebt die Nah-Fläche des Rahmens um
 *    `insetFromFace` von der gewählten Wandfläche nach innen; die Gegenfläche
 *    bleibt unverändert (der Rahmen reicht weiterhin bis dorthin).
 *  • Oberlicht         — Überkopf-Andeutung (gestrichelte Linie quer über die
 *    Öffnung), nur wenn `transomHeight > 0`.
 */
function addOpeningFrameBand(
  out: Primitive[],
  project: Project,
  wall: Wall,
  o: Opening,
  spec: OpeningFrameSpec,
  greyed: boolean,
): void {
  const jambs = openingJambs(wall, o);
  if (!jambs) return;
  const { n } = wallAxisFrame(wall);
  const total = wallTypeThickness(getWallType(project, wall));
  const refOff = wallReferenceOffset(wall, total);
  // "aussen" = die Fläche der ERSTEN Wandtyp-Schicht (kleinster Achs-Offset,
  // s. addWallPoche/`off` startet bei `refOff-total/2`) — mit `n = leftNormal(u)`
  // ist das die NEGATIVE Seite. Bug bis 2026-07-12: hier stand `+total/2` für
  // "aussen" (positive Seite, tatsächlich "innen") — Türrahmenbänder mit
  // insetFace:"aussen" landeten dadurch an der falschen Wandfläche.
  const outerFace = refOff - total / 2; // "aussen"-Fläche (−n, erste Schicht)
  const innerFace = refOff + total / 2; // "innen"-Fläche (+n, letzte Schicht)

  // Schichteinzug: die GEWÄHLTE Fläche rückt um `insetFromFace` nach innen; die
  // gegenüberliegende Fläche bleibt unverändert (der Rahmen reicht weiterhin
  // bis dorthin) — vgl. DoorType.insetFromFace/WindowType.insetFromFace.
  const clampedInset = Math.max(0, Math.min(spec.insetFromFace, total));
  const nearIsAussen = spec.insetFace !== "innen";
  // "Nach innen" heisst: von der gewählten Fläche RICHTUNG WANDMITTE (refOff) —
  // von aussen (negative Seite) aus AUFWÄRTS (+clampedInset), von innen
  // (positive Seite) aus ABWÄRTS (−clampedInset).
  const faceNear = nearIsAussen ? outerFace + clampedInset : innerFace - clampedInset;
  const faceFar = nearIsAussen ? innerFace : outerFace;
  const lo = Math.min(faceNear, faceFar);
  const hi = Math.max(faceNear, faceFar);

  const { jambStart, jambEnd } = jambs;
  const color = o.color ?? POCHE_STROKE;

  // Rahmen-Rechteck NUR bei Türen zeichnen. Beim Fenster stellt bereits
  // `windowSymbol` den Rahmen dar (voller Öffnungsumriss + Glaslinien); ein
  // zusätzliches Band ergäbe ein doppeltes, verschachteltes Rechteck — genau
  // das wirkte im 2D „nicht korrekt". Die Tür hat dort nur Blatt+Bogen, daher
  // ist ihr Rahmenband die einzige Rahmenkontur und bleibt.
  if (o.kind === "door") {
    const frameWidth = Math.max(0, spec.frameWidth);
    const isBlock = spec.frameKind === "blockrahmen";
    let bandLo: number;
    let bandHi: number;
    let jStart: Vec2;
    let jEnd: Vec2;
    let weightMm: number;
    if (isBlock) {
      // Blockrahmen: volle Öffnungsbreite (kein Pfosten-Einzug), nur eine
      // Tiefenscheibe von frameWidth ab der Nah-Fläche — sitzt proud VOR/auf der
      // Laibung, statt schmal darin zu verschwinden (Zargen-Optik). "aussen"
      // liegt bei `lo` (s. Kommentar zu outerFace/innerFace oben), die Scheibe
      // beginnt dort und wächst RICHTUNG WANDMITTE (Richtung `hi`).
      const depth = Math.min(frameWidth, hi - lo);
      bandLo = nearIsAussen ? lo : hi - depth;
      bandHi = nearIsAussen ? lo + depth : hi;
      jStart = jambStart;
      jEnd = jambEnd;
      weightMm = SYMBOL_HAIRLINE_MM * 2.2;
    } else {
      // Zarge: ringsum um frameWidth von der vollen Öffnung eingezogenes,
      // schmales Rahmenband (Laibungs-Anschlaglinie).
      const jambSpan = Math.hypot(jambEnd.x - jambStart.x, jambEnd.y - jambStart.y);
      const jambInset = Math.min(frameWidth, jambSpan / 2);
      jStart = along(jambStart, jambEnd, jambInset);
      jEnd = along(jambEnd, jambStart, jambInset);
      const depthInset = Math.min(frameWidth, (hi - lo) / 2);
      bandLo = lo + depthInset;
      bandHi = hi - depthInset;
      weightMm = SYMBOL_HAIRLINE_MM;
    }

    // Geschlossenes Rechteck aus 4 Kanten (Primitive "line", nicht "polygon" —
    // so bleibt das Band per `cls` selektierbar/testbar wie die übrigen Symbole).
    const p1 = add(jStart, scale(n, bandLo));
    const p2 = add(jEnd, scale(n, bandLo));
    const p3 = add(jEnd, scale(n, bandHi));
    const p4 = add(jStart, scale(n, bandHi));
    const edges: [Vec2, Vec2][] = [
      [p1, p2],
      [p2, p3],
      [p3, p4],
      [p4, p1],
    ];
    for (const [a, b] of edges) {
      out.push({
        kind: "line",
        a,
        b,
        cls: "opening-frame",
        weightMm,
        color,
        greyed,
        openingId: o.id,
      });
    }
  }

  // Die frühere Oberlicht-Andeutung (gestrichelte Linie quer über die ganze
  // Öffnung bei transomHeight>0) ist entfernt (Nutzer-Report: erscheint immer
  // auf der Wandachse, unabhängig davon, ob die Schnittebene den Kämpfer
  // überhaupt trifft — im horizontalen Grundriss-Schnitt architektonisch nicht
  // aussagekräftig, ein Kämpfer ist ein Höhen-, kein Grundriss-Merkmal).
}

/**
 * Öffnungs-Symbol (Fenster/Tür) je Detailgrad. Anders als das Legacy-`addDoorSymbol`
 * arbeitet diese Funktion über die reinen Geometrie-Helfer (opening.ts) und taggt
 * ihre Primitive mit `openingId`, sodass die Öffnung im Plan selektierbar ist.
 *
 * Tür:
 *  • grob   — gerade Türblatt-Linie (die Lücke kommt aus der ausgesparten Poché).
 *  • mittel — + Schwenkbogen (Öffnungswinkel).
 *  • fein   — + Anschlag-Striche an beiden Pfosten.
 * Fenster:
 *  • grob   — eine einzelne Glaslinie über die Lücke.
 *  • mittel — Rahmen-Rechteck (Umriss) + eine Glaslinie.
 *  • fein   — Rahmen + zwei Glaslinien (Doppelverglasung angedeutet).
 */
export function addOpeningSymbol(
  out: Primitive[],
  project: Project,
  wall: Wall,
  o: Opening,
  greyed: boolean,
  detail: DetailLevel,
  lwMm: number,
): void {
  if (o.kind === "door") {
    const sym = doorSymbol(wall, o);
    if (!sym) return;
    // Unsichtbares Pick-Polygon über der Öffnungslücke (Laibung × Wanddicke) —
    // damit die Tür wie ein Fenster per Punkt-in-Polygon über die ganze
    // Öffnungsfläche selektierbar ist (Türsymbol besteht sonst nur aus dünnem
    // Blatt + Bogen, die man exakt treffen müsste). fill/stroke "none" ⇒ zeichnet
    // nichts; `pickOpening` (PlanView) testet nur die `pts`.
    const gap = openingGapQuad(project, wall, o);
    if (gap) {
      out.push({
        kind: "polygon",
        pts: gap,
        fill: "none",
        stroke: "none",
        strokeWidthMm: 0,
        hatch: NO_HATCH,
        greyed,
        openingId: o.id,
      });
    }
    // Tür-Typ „wandoeffnung": reiner Wanddurchbruch — KEIN Türblatt, KEIN
    // Schwenkbogen. Nur die Öffnung/Laibung bleibt (die Wandlücke kommt aus der
    // ausgesparten Poché; Sturz-/Anschlaglinien werden weiter unten gezeichnet).
    // Entspricht `oeff_tuer_typ == "wandoeffnung"` im Rhino-Plugin.
    const isWandoeffnung = (o.doorType ?? "normal") === "wandoeffnung";
    if (!isWandoeffnung) {
      // Türblätter (1 oder 2 Flügel, je DoorType.leafCount). Zweiflüglig ⇒ zwei
      // halbbreite Blätter an gegenüberliegenden Pfosten (symmetrische Doppeltür).
      const leafCount = Math.max(1, Math.round(getDoorType(project, o)?.leafCount ?? 1));
      for (const leaf of doorLeaves(wall, o, leafCount)) {
        out.push({
          kind: "line",
          a: leaf.hinge,
          b: leaf.openEnd,
          cls: "door-leaf",
          weightMm: SYMBOL_HAIRLINE_MM,
          greyed,
          openingId: o.id,
        });
        // mittel + fein: Schwenkbogen von geschlossen → offen je Blatt.
        if (detail !== "grob") {
          out.push({
            kind: "arc",
            center: leaf.hinge,
            from: leaf.closedEnd,
            to: leaf.openEnd,
            r: leaf.radius,
            cls: "door-swing",
            weightMm: SYMBOL_HAIRLINE_MM,
            greyed,
            openingId: o.id,
          });
        }
      }
    }
    // fein: Anschlag-Striche an beiden Pfosten (quer zur Wand).
    if (detail === "fein") {
      const reveal = 0.06;
      for (const jamb of [sym.jambStart, sym.jambEnd]) {
        out.push({
          kind: "line",
          a: add(jamb, scale(sym.normal, reveal)),
          b: add(jamb, scale(sym.normal, -reveal)),
          cls: "door-frame",
          weightMm: SYMBOL_HAIRLINE_MM,
          greyed,
          openingId: o.id,
        });
      }
    }
    // Rahmenband (Zarge/Blockrahmen) + Oberlicht-Andeutung — nur wenn die
    // Öffnung einen Türtyp referenziert (siehe `resolveOpeningFrameSpec`).
    const doorFrameSpec = resolveOpeningFrameSpec(project, o);
    if (doorFrameSpec) addOpeningFrameBand(out, project, wall, o, doorFrameSpec, greyed);
    // Sturzlinien (SIA, gestrichelt) — Überkopf-Projektion des Sturzes quer über
    // die Öffnung an der Wand-Innen-/Aussenkante. Entspricht `_make_tuer_sturz_curves`
    // im Rhino-Plugin. Default „beide" wenn nicht explizit gesetzt.
    const lintelMode = o.lintelLines ?? "beide";
    if (lintelMode !== "keine") {
      const jambs = openingJambs(wall, o);
      if (jambs) {
        const { n } = wallAxisFrame(wall);
        const total = wallTypeThickness(getWallType(project, wall));
        const refOff = wallReferenceOffset(wall, total);
        const halfD = total / 2;
        // "aussen" = negative Seite (erste Wandtyp-Schicht), s. Kommentar in
        // addOpeningFrameBand — Bug bis 2026-07-12: stand hier vertauscht.
        const outerOff = refOff - halfD;
        const innerOff = refOff + halfD;
        // Strichmuster: gestrichelt (Überkopf-Projektion, SIA-Konvention).
        const dash: number[] = [0.18, 0.09];
        const strokeColor = o.color ?? POCHE_STROKE;
        /** Linie quer über die Öffnung am gegebenen Perp-Offset. */
        const lintelLine = (perpOff: number) => ({
          a: add(jambs.jambStart, scale(n, perpOff)),
          b: add(jambs.jambEnd,   scale(n, perpOff)),
        });
        if (lintelMode === "aussen" || lintelMode === "beide") {
          const seg = lintelLine(outerOff);
          out.push({
            kind: "line" as const,
            a: seg.a,
            b: seg.b,
            cls: "door-lintel",
            weightMm: SYMBOL_HAIRLINE_MM,
            dash,
            color: strokeColor,
            greyed,
            openingId: o.id,
          });
        }
        if (lintelMode === "innen" || lintelMode === "beide") {
          const seg = lintelLine(innerOff);
          out.push({
            kind: "line" as const,
            a: seg.a,
            b: seg.b,
            cls: "door-lintel",
            weightMm: SYMBOL_HAIRLINE_MM,
            dash,
            color: strokeColor,
            greyed,
            openingId: o.id,
          });
        }
      }
    }
    return;
  }

  // Fenster: Rahmen (mittel/fein) + Glaslinie(n) je Detailgrad + Fenstertyp.
  const wt = getWindowType(project, o);
  // Flügeltabelle NUR übergeben, wenn ein Fenstertyp auflösbar ist — fehlt er
  // (kein `typeId`/unbekannt), bleibt `windowSymbol` beim reinen
  // `o.wingCount`-Alt-Verhalten (siehe dortiger Kommentar, Regressionssicherheit).
  const spec = wt
    ? {
        sashes: sashesOfWindowType(wt),
        frameWidth: wt.frameWidth ?? 0.06,
        frameDepth: wt.frameDepth,
        insetFromFace: wt.insetFromFace,
        insetFace: wt.insetFace,
      }
    : undefined;
  // Glaslinienzahl NUR für den Alt-Pfad (kein `spec`) relevant — der typisierte
  // Pfad entscheidet die Anzahl selbst nach SIA-Detailgrad (s. windowSymbol).
  const glassCount = detail === "fein" ? 2 : 1;
  const sym = windowSymbol(project, wall, o, glassCount, spec, detail);
  if (!sym) return;
  // Unsichtbares Pick-Polygon über der Öffnungslücke — macht das Fenster über
  // die ganze Fläche selektierbar, auch bei „grob" (nur eine Glaslinie, sonst
  // schwer zu treffen). Siehe Tür-Zweig oben.
  const wgap = openingGapQuad(project, wall, o);
  if (wgap) {
    out.push({
      kind: "polygon",
      pts: wgap,
      fill: "none",
      stroke: "none",
      strokeWidthMm: 0,
      hatch: NO_HATCH,
      greyed,
      openingId: o.id,
    });
  }
  // ── SIA-Fensterdarstellung, nach Detailgrad gestaffelt ────────────────────
  // grob (1:100): weisse Öffnung + EINE dünne Glaslinie, sonst nichts.
  // mittel (1:50): Blendrahmen-Rechteck + Pfosten-Trennlinien + Stulp-Mittel-
  //   quadrat je Flügel-Junction + Glaslinie(n).
  // fein (1:20): zusätzlich Flügelrahmen, Stulp als ZWEI Rechtecke, Fensterbank
  //   (aussen) und Anschlag-/Laibungskerben — deutlich reicher als mittel.
  const strokeColor = o.color ?? POCHE_STROKE;
  const { n: wn } = wallAxisFrame(wall);

  if (detail === "grob") {
    // SIA 1:100 — nur eine dünne Glaslinie mittig über die weisse Öffnung.
    // Zählt zur "Fenster"-Kategorie (sashLine) — dieselbe Glaslinie, die bei
    // mittel/fein früher sichtbar war (jetzt dort entfernt, s. Fenster-Session).
    const g = sym.glassLines[Math.floor(sym.glassLines.length / 2)] ?? sym.glassLines[0];
    if (g) {
      out.push({
        kind: "line",
        a: g[0],
        b: g[1],
        cls: "window-glass",
        weightMm: o.sashLine?.weight ?? SYMBOL_HAIRLINE_MM,
        color: o.sashLine?.color ?? strokeColor,
        greyed,
        openingId: o.id,
      });
    }
  } else {
    // Linien-Kategorien einzeln übersteuerbar (Nutzer-Wunsch): Rahmen-Schnitt
    // (Laibungs-/Stulp-Blöcke, geschnittenes Profil), Rahmen-Aufsicht (die
    // durchlaufende Kontur DAZWISCHEN, projiziert statt geschnitten), Fenster
    // (Flügelrahmen/Sprossen), Sims (Auf-/Untersicht-Andeutung, s. u.).
    // `undefined` ⇒ bisheriges Verhalten (strokeColor/SYMBOL_HAIRLINE_MM);
    // `frameViewLine` fällt zusätzlich auf `frameLine` zurück (eine Farbe für
    // Schnitt+Aufsicht, bis der Nutzer sie explizit trennt).
    const frameColor = o.frameLine?.color ?? strokeColor;
    const frameWeight = o.frameLine?.weight ?? lwMm;
    const frameHairline = o.frameLine?.weight ?? SYMBOL_HAIRLINE_MM;
    const frameViewColor = o.frameViewLine?.color ?? frameColor;
    const frameViewWeight = o.frameViewLine?.weight ?? frameWeight;
    const sashColor = o.sashLine?.color ?? strokeColor;
    const sashWeight = o.sashLine?.weight ?? SYMBOL_HAIRLINE_MM;

    // Blendrahmen-Rechteck in Aufsicht (mittel + fein) — die durchlaufende
    // Kontur zwischen den geschnittenen Laibungs-/Stulp-Blöcken.
    out.push({
      kind: "polygon",
      pts: sym.frame,
      fill: "none",
      stroke: frameViewColor,
      strokeWidthMm: frameViewWeight,
      hatch: NO_HATCH,
      greyed,
      openingId: o.id,
    });
    // Pfosten-/Flügel-Trennlinien (Alt-Pfad ohne Typ — zählt als "Fenster").
    for (const [a, b] of sym.mullionLines) {
      out.push({ kind: "line", a, b, cls: "window-mullion", weightMm: sashWeight, color: sashColor, greyed, openingId: o.id });
    }
    // fein: Flügelrahmen (Flügelkontur) je öffenbarem Flügel — Schachtelung
    // Blendrahmen → Flügelrahmen → Glas (Feindetail, hebt fein klar von mittel ab).
    if (detail === "fein") {
      for (const pts of sym.sashFrames) {
        for (let i = 0; i < pts.length; i++) {
          out.push({ kind: "line", a: pts[i], b: pts[(i + 1) % pts.length], cls: "window-sash", weightMm: sashWeight, color: sashColor, greyed, openingId: o.id });
        }
      }
    }
    // Laibungs-Blöcke an den Öffnungsenden (Blendrahmen-Querschnitt) — Teil des
    // Blendrahmens, zählt zu "Rahmen".
    for (const mark of sym.jambMarks) {
      for (let i = 0; i < mark.length; i++) {
        out.push({ kind: "line", a: mark[i], b: mark[(i + 1) % mark.length], cls: "window-stulp", weightMm: frameHairline, color: frameColor, greyed, openingId: o.id });
      }
    }
    // Stulp-Mittelquadrat je Flügel-Junction (SIA-Signatur): mittel = EIN Quadrat,
    // fein = ZWEI anliegende Rechtecke (die beiden Stulp-Stäbe der Flügel) —
    // bereits tiefenkorrekt (inset-/insetFace-bewusst) in windowSymbol berechnet.
    // Sitzt zwischen den Flügeln, zählt zu "Fenster" (separat vom Blendrahmen
    // steuerbar — Nutzer-Feedback).
    for (const mark of sym.meetingMarks) {
      for (let i = 0; i < mark.length; i++) {
        out.push({ kind: "line", a: mark[i], b: mark[(i + 1) % mark.length], cls: "window-stulp", weightMm: sashWeight, color: sashColor, greyed, openingId: o.id });
      }
    }
    // Glaslinien (Anzahl je Detailgrad/Verglasung, s. glassCount).
    for (const [a, b] of sym.glassLines) {
      out.push({ kind: "line", a, b, cls: "window-glass", weightMm: SYMBOL_HAIRLINE_MM, greyed, openingId: o.id });
    }
    // Oberlicht-Andeutung (transom, gestrichelt) — mittel/fein.
    const windowFrameSpec = resolveOpeningFrameSpec(project, o);
    if (windowFrameSpec) addOpeningFrameBand(out, project, wall, o, windowFrameSpec, greyed);
    // fein: Fensterbank (aussen) + Anschlag-/Laibungskerben.
    if (detail === "fein") {
      const jb = openingJambs(wall, o);
      if (jb) {
        const { jambStart, jambEnd } = jb;
        // Tatsächliche Rahmen-Aussenkante (NICHT pauschal die volle Wandfläche —
        // ein eingezogener Rahmen, s. {@link WindowType.insetFromFace}, hat seine
        // Aussenkante weiter innen). "Aussen" ist der ALGEBRAISCH KLEINERE der
        // beiden Tiefen-Werte in sym.frame (s. windowSymbol: frontRel für
        // insetFace:"aussen" ist negativ) — welcher der beiden Eckpunkt-Paare das
        // ist, hängt von insetFace ab, daher robust über Math.min bestimmt statt
        // fest über sym.frame[0].
        const outerN = Math.min(
          dot(sub(sym.frame[0], jambStart), wn),
          dot(sub(sym.frame[2], jambStart), wn),
        );
        // Fensterbank: schmales Rechteck vor der Aussenfläche, seitlich ~3 cm
        // überstehend, ~4 cm auskragend (SIA-Sims-Andeutung im Grundriss).
        // Auskragung geht IMMER weiter nach aussen (algebraisch kleiner, s. o.).
        const ov = 0.03;
        const proj = 0.04;
        const s0 = along(jambStart, jambEnd, -ov);
        const s1 = along(jambEnd, jambStart, -ov);
        const b0 = add(s0, scale(wn, outerN));
        const b1 = add(s1, scale(wn, outerN));
        const b2 = add(s1, scale(wn, outerN - proj));
        const b3 = add(s0, scale(wn, outerN - proj));
        for (const [a, b] of [[b0, b1], [b1, b2], [b2, b3], [b3, b0]] as [Vec2, Vec2][]) {
          out.push({ kind: "line", a, b, cls: "window-sill", weightMm: SYMBOL_HAIRLINE_MM, color: strokeColor, greyed, openingId: o.id });
        }
        // Anschlag-Kerben an beiden Pfosten (kurz quer zur Wand).
        const reveal = 0.06;
        for (const jamb of [jambStart, jambEnd]) {
          out.push({ kind: "line", a: add(jamb, scale(wn, reveal)), b: add(jamb, scale(wn, -reveal)), cls: "window-frame", weightMm: SYMBOL_HAIRLINE_MM, color: strokeColor, greyed, openingId: o.id });
        }
      }
    }
  }
  // Auf-/Untersicht-Andeutung ({@link WindowType.sillLine}): eine Referenzlinie
  // an der Rahmen-Aussen-/Innenkante (NICHT der Wandachse — ersetzt die frühere,
  // falsch positionierte Brüstungslinie), nur wenn der Typ es explizit wählt.
  // "auf" (Aufsicht von oben, dünn gepunktet) vs. "unter" (Untersicht von unten,
  // gestrichelt wie die übrigen Überkopf-Projektionen).
  if (detail !== "grob" && wt?.sillLine) {
    const { faces, view } = wt.sillLine;
    const dash = view === "unter" ? OVERHEAD_DASH : [0.04, 0.08];
    const sillColor = o.sillLineStyle?.color ?? strokeColor;
    const sillWeight = o.sillLineStyle?.weight ?? SYMBOL_HAIRLINE_MM;
    // Welches der beiden sym.frame-Eckpunkt-Paare physisch "aussen" ist, hängt
    // von insetFace ab (s. windowSymbol) — robust über den Tiefen-Vergleich
    // entlang wn bestimmt statt fest über den Index.
    const pair01IsOuter = dot(sym.frame[0], wn) <= dot(sym.frame[3], wn);
    const outerPair: [Vec2, Vec2] = pair01IsOuter ? [sym.frame[0], sym.frame[1]] : [sym.frame[3], sym.frame[2]];
    const innerPair: [Vec2, Vec2] = pair01IsOuter ? [sym.frame[3], sym.frame[2]] : [sym.frame[0], sym.frame[1]];
    if (faces === "aussen" || faces === "beide") {
      out.push({ kind: "line", a: outerPair[0], b: outerPair[1], cls: "window-sill", weightMm: sillWeight, dash, color: sillColor, greyed, openingId: o.id });
    }
    if (faces === "innen" || faces === "beide") {
      out.push({ kind: "line", a: innerPair[0], b: innerPair[1], cls: "window-sill", weightMm: sillWeight, dash, color: sillColor, greyed, openingId: o.id });
    }
  }
  // Rollladen-/Sonnenschutzkasten (P0-Minimalfassung, reine 2D-Kontur): ein
  // gestricheltes Rechteck ÜBER der Öffnung, ausserhalb der Wand-Aussenfläche —
  // Breite = `shading.box.width` (0/fehlt ⇒ Öffnungsbreite), die zweite
  // Rechteckseite = `shading.box.height`. Die 3D-Tiefe (`box.depth`) bleibt für
  // eine spätere 3D-Box reserviert (Fokus hier bewusst 2D, s. Aufgabenstellung).
  // Gestrichelt wie die übrigen Überkopf-Projektionen (Sturz/Oberlicht) — der
  // Kasten liegt oberhalb der Schnittebene und wird nur angedeutet.
  if (wt?.shading?.create) {
    const jambs = openingJambs(wall, o);
    if (jambs) {
      const { u, n: nrm } = wallAxisFrame(wall);
      const total = wallTypeThickness(getWallType(project, wall));
      const refOff = wallReferenceOffset(wall, total);
      // "aussen" = negative Seite (erste Wandtyp-Schicht), s. Kommentar in
      // addOpeningFrameBand — Bug bis 2026-07-12: stand hier vertauscht (der
      // Rollladenkasten landete an der Innenfläche statt aussen am Sturz).
      const outerFace = refOff - total / 2;
      const axisWidth = Math.hypot(
        jambs.jambEnd.x - jambs.jambStart.x,
        jambs.jambEnd.y - jambs.jambStart.y,
      );
      const boxWidth = wt.shading.box.width > 0 ? wt.shading.box.width : axisWidth;
      const boxHeight = Math.max(0, wt.shading.box.height);
      const center = add(jambs.jambStart, scale(u, axisWidth / 2));
      const half = boxWidth / 2;
      const c1 = add(center, scale(u, -half));
      const c2 = add(center, scale(u, half));
      const p1 = add(c1, scale(nrm, outerFace));
      const p2 = add(c2, scale(nrm, outerFace));
      const p3 = add(c2, scale(nrm, outerFace + boxHeight));
      const p4 = add(c1, scale(nrm, outerFace + boxHeight));
      const edges: [Vec2, Vec2][] = [
        [p1, p2],
        [p2, p3],
        [p3, p4],
        [p4, p1],
      ];
      for (const [a, b] of edges) {
        out.push({
          kind: "line",
          a,
          b,
          cls: "window-shading",
          weightMm: SYMBOL_HAIRLINE_MM,
          dash: OVERHEAD_DASH,
          color: o.color ?? POCHE_STROKE,
          greyed,
          openingId: o.id,
        });
      }
    }
  }
}

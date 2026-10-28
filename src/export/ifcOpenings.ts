// Geometrie der Türen und Fenster für den IFC-Export ([B5], 28.10.): statt einer Box getrennte Körper im
// selben Bauteil — Rahmen/Zarge, Türblatt bzw. Glas — plus OperationType (Tür) und PartitioningType
// (Fenster). Alles sind vertikale Extrusionen von Grundriss-Rechtecken (wie die Wände), Profile in
// Welt-XY, Höhen ab Öffnungs-Unterkante; Rust (`ifc_export.rs`) rechnet sie ins Füllungssystem.
//
// Masse kommen aus dem Modell, soweit es sie hergibt (Rahmenbreite/-tiefe, Schichteinzug, Flügelzahl und
// -tabelle, Verglasung, Blattzahl, Glasanteil, Oberlicht). Fehlendes füllen dieselben Konstanten wie das
// 3D (`src-tauri/core/src/openings3d.rs`), damit IFC und Ansicht dasselbe zeigen:
//   - Rahmenbreite 6 cm (`DEFAULT_FRAME_WIDTH`), Rahmentiefe 7 cm (`DEFAULT_FRAME_DEPTH`: reale Rahmen
//     sind 70–90 mm tief, nicht so dick wie die Wand), Türblatt 4 cm (`DOOR_LEAF_THICK`).
//   - Glaspaket: nur im IFC nötig, das 3D zeichnet Einzelscheiben. 1 Scheibe 6 mm, 2 Scheiben 24 mm
//     (4-16-4, übliches Isolierglas), 3 Scheiben 36 mm (4-12-4-12-4 ≈ 36 mm).
// Nicht abgebildet (bewusst einfach): Sprossen, Fensterbank/Rollladenkasten, Schwelle, Flügelrahmen im
// Blendrahmen, Kassettenfelder, Schiebe-Laufschiene — die Körper stehen im geschlossenen Zustand.

import type { Opening, Project, SashDef, Vec2, Wall } from "../model/types";
import { getDoorType, getWindowType, glazingPanesOf } from "../model/types";

/** Rolle eines Körpers: 0 Rahmen/Zarge, 1 Türblatt, 2 Glas (Kodierung `ifc_export.rs`). */
export type FillRole = 0 | 1 | 2;

export interface FillPart {
  role: FillRole;
  /** Profil in Welt-XY (Rechteck, gegen den Uhrzeigersinn in Achs-/Normalenrichtung). */
  pts: Vec2[];
  /** Unterkante ab Öffnungs-Unterkante (m). */
  zRel: number;
  /** Höhe des Körpers (m). */
  depth: number;
}

export interface FillGeometry {
  /** Ursprung des Füllungssystems (Welt-XY): Öffnungsmitte auf der Wandachse. */
  origin: Vec2;
  /** X-Richtung des Füllungssystems (Einheitsvektor); Y = linke Normale davon. */
  u: Vec2;
  /** IfcDoorTypeOperationEnum bzw. IfcWindowTypePartitioningEnum; null = Modell gibt nichts her. */
  kind: string | null;
  parts: FillPart[];
}

export const DEFAULT_FRAME_WIDTH = 0.06;
export const DEFAULT_FRAME_DEPTH = 0.07;
export const DOOR_LEAF_THICK = 0.04;
/** Glaspaket-Dicke je Scheibenzahl (1, 2, 3). */
export const GLASS_PACKAGE_THICKNESS = [0.006, 0.024, 0.036] as const;
/** Glasanteil des Türblatts, wenn der Typ keinen angibt (`glas` ohne `glazingRatio`). */
const DEFAULT_GLAZING_RATIO = 0.5;
/** Kleinste Teilabmessung, damit nie ein flaches Profil entsteht (Meter). */
const MIN_DIM = 0.005;

const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, y: a.y - b.y });
const norm = (v: Vec2): Vec2 => {
  const len = Math.hypot(v.x, v.y) || 1;
  return { x: v.x / len, y: v.y / len };
};
const leftOf = (u: Vec2): Vec2 => ({ x: -u.y, y: u.x });
const dotv = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/** Flügeleinteilung eines Fensters, auf die Achsbreite aufgelöst: (von, bis, Pfosten?) ab Laibungsanfang. */
interface SashSpan {
  from: number;
  to: number;
  post: boolean;
}

/**
 * Löst Flügel (`fluegel`) und Pfosten (`pfosten`) zu Intervallen auf: Pfosten und Flügel mit fester Breite
 * behalten sie, die übrigen teilen den Rest gleichmässig (gleiche Regel wie `sashSegments` im 2D). Ohne
 * Tabelle: `wingCount` gleiche Flügel.
 */
function sashSpans(sashes: readonly SashDef[] | undefined, wingCount: number, total: number): SashSpan[] {
  const list: readonly SashDef[] =
    sashes && sashes.length > 0
      ? sashes
      : Array.from({ length: Math.max(1, Math.round(wingCount)) }, (): SashDef => ({ kind: "fluegel" }));
  const postW = (s: SashDef): number => Math.max(0, s.postWidth ?? 0.06);
  const fixedW = (s: SashDef): number | null => (s.kind === "pfosten" ? postW(s) : s.autoWidth === false ? Math.max(0, s.width ?? 0) : null);
  let fixed = 0;
  let auto = 0;
  for (const s of list) {
    const w = fixedW(s);
    if (w === null) auto++;
    else fixed += w;
  }
  const autoW = auto > 0 ? Math.max(0, total - fixed) / auto : 0;
  const out: SashSpan[] = [];
  let at = 0;
  for (const s of list) {
    const w = fixedW(s) ?? autoW;
    out.push({ from: at, to: at + w, post: s.kind === "pfosten" });
    at += w;
  }
  return out;
}

/**
 * Körper und Ausführung der Füllung einer Öffnung.
 *
 * `c` = Achs-Intervall (`from`/`to`, Abstand ab `wall.start`) und absolute Höhen der Öffnung, `host` =
 * Querausdehnung der ganzen Wand (`nLo`/`nHi` entlang der linken Normalen ab `wall.start`; `nLo` ist die
 * Aussenseite, wie im 2D/3D).
 */
export function fillGeometry(
  project: Project,
  wall: Wall,
  opening: Opening,
  c: { from: number; to: number; zBottom: number; zTop: number },
  host: { nLo: number; nHi: number },
): FillGeometry {
  const u = norm(sub(wall.end, wall.start));
  const n = leftOf(u);
  const isDoor = opening.kind === "door";
  const W = c.to - c.from;
  const H = c.zTop - c.zBottom;
  const at = (a: number, b: number): Vec2 => ({
    x: wall.start.x + u.x * a + n.x * b,
    y: wall.start.y + u.y * a + n.y * b,
  });
  /** Rechteck [a0,a1] entlang der Achse × [b0,b1] quer dazu (Welt-XY). */
  const rect = (a0: number, a1: number, b0: number, b1: number): Vec2[] => [at(a0, b0), at(a1, b0), at(a1, b1), at(a0, b1)];
  const center = c.from + W / 2;
  const origin = at(center, 0);
  const parts: FillPart[] = [];
  const add = (role: FillRole, a0: number, a1: number, b0: number, b1: number, z0: number, z1: number): void => {
    if (a1 - a0 < 1e-6 || b1 - b0 < 1e-6 || z1 - z0 < 1e-6) return;
    parts.push({ role, pts: rect(a0, a1, b0, b1), zRel: z0, depth: z1 - z0 });
  };

  const dt = isDoor ? getDoorType(project, opening) : undefined;
  const wt = isDoor ? undefined : getWindowType(project, opening);
  const t = dt ?? wt;

  // Querlage des Rahmens: Tiefe (Typ oder 7 cm), Schichteinzug von der gewählten Wandfläche, auf die
  // Wanddicke geklemmt — dieselbe Rechnung wie `windowSymbol` (2D) und `resolveFrameNormalRange` (3D).
  const total = host.nHi - host.nLo;
  const frameDepth = Math.min(total, t?.frameDepth && t.frameDepth > 1e-9 ? t.frameDepth : DEFAULT_FRAME_DEPTH);
  const inset = Math.max(0, t?.insetFromFace ?? 0);
  const outside = (t?.insetFace ?? "aussen") === "aussen";
  const front = outside ? host.nLo + inset : host.nHi - inset;
  const back = outside ? front + frameDepth : front - frameDepth;
  let b0 = Math.max(host.nLo, Math.min(host.nHi, Math.min(front, back)));
  let b1 = Math.max(host.nLo, Math.min(host.nHi, Math.max(front, back)));
  if (b1 - b0 < MIN_DIM) {
    b0 = host.nLo;
    b1 = host.nHi;
  }
  const bMid = (b0 + b1) / 2;

  // Sichtbare Rahmenbreite: höchstens ein Viertel der kleineren Öffnungsabmessung, sonst bliebe nichts offen.
  const fw = Math.max(MIN_DIM, Math.min(t?.frameWidth && t.frameWidth > 1e-9 ? t.frameWidth : DEFAULT_FRAME_WIDTH, Math.min(W, H) / 4));
  const aIn0 = c.from + fw;
  const aIn1 = c.to - fw;

  if (!isDoor) {
    // ── Fenster: Blendrahmen (Pfosten links/rechts, Sturz, Sohlbank), Mittelpfosten, Glas je Flügel ──
    const wing = opening.wingCount ?? wt?.wingCount ?? 1;
    add(0, c.from, aIn0, b0, b1, 0, H);
    add(0, aIn1, c.to, b0, b1, 0, H);
    add(0, aIn0, aIn1, b0, b1, H - fw, H);
    add(0, aIn0, aIn1, b0, b1, 0, fw);
    const panes = wt ? glazingPanesOf(wt) : 2;
    const gt = Math.min(GLASS_PACKAGE_THICKNESS[panes - 1], b1 - b0);
    const g0 = bMid - gt / 2;
    const g1 = bMid + gt / 2;
    const spans = sashSpans(wt?.sashes, wing, aIn1 - aIn0);
    let glassCount = 0;
    spans.forEach((s, i) => {
      const x0 = aIn0 + s.from;
      const x1 = aIn0 + s.to;
      if (s.post) {
        add(0, x0, x1, b0, b1, fw, H - fw);
        return;
      }
      // Zwischen zwei Flügeln ohne Pfosten steht ein Mittelpfosten (Breite = Rahmenbreite) auf der Grenze.
      const prev = spans[i - 1];
      const next = spans[i + 1];
      const gx0 = i === 0 || prev.post ? x0 : x0 + fw / 2;
      const gx1 = i === spans.length - 1 || next.post ? x1 : x1 - fw / 2;
      if (next && !next.post) add(0, x1 - fw / 2, x1 + fw / 2, b0, b1, fw, H - fw);
      add(2, gx0, gx1, g0, g1, fw, H - fw);
      glassCount++;
    });
    // Teilung nach IFC: nur die senkrechten Standardfälle sind benannt (sonst NOTDEFINED, das Modell
    // kennt Sprossen und Seitenverhältnisse, die IFC nicht als Enum führt).
    const kind = glassCount === 1 ? "SINGLE_PANEL" : glassCount === 2 ? "DOUBLE_PANEL_VERTICAL" : glassCount === 3 ? "TRIPLE_PANEL_VERTICAL" : "NOTDEFINED";
    return { origin, u, kind, parts };
  }

  // ── Tür ──
  const kind = dt?.kind ?? (opening.doorType === "wandoeffnung" ? "wandoeffnung" : "dreh");
  const leafCount = dt?.leafCount ?? 1;
  // Aufschlagrichtung wie `doorSymbol`: linke Achsnormale, `openingDir: "out"` spiegelt sie.
  const swingSign = (opening.swing ?? "left") === "left" ? 1 : -1;
  const dirSign = (opening.openingDir ?? "in") === "in" ? 1 : -1;
  const swingDir: Vec2 = { x: n.x * swingSign * dirSign, y: n.y * swingSign * dirSign };
  // Füllungssystem der Tür: Y = Aufschlagrichtung (IFC: die Tür schlägt nach +Y auf), X = Y × Z.
  const doorU: Vec2 = { x: swingDir.y, y: -swingDir.x };
  if (kind === "wandoeffnung") return { origin, u: doorU, kind: null, parts: [] };

  // Zarge: Pfosten links/rechts über die ganze Höhe und Sturz (keine Schwelle).
  add(0, c.from, aIn0, b0, b1, 0, H);
  add(0, aIn1, c.to, b0, b1, 0, H);
  add(0, aIn0, aIn1, b0, b1, H - fw, H);

  // Oberlicht: fester Glasstreifen über einem Kämpfer (Riegel in Rahmenbreite) innerhalb der Öffnungshöhe.
  const th = dt?.transomHeight ?? 0;
  const hasTransom = th > MIN_DIM && th < H - fw - 0.5;
  const leafTop = hasTransom ? H - fw - th - fw : H - fw;
  if (hasTransom) {
    add(0, aIn0, aIn1, b0, b1, leafTop, leafTop + fw);
    const gt = Math.min(GLASS_PACKAGE_THICKNESS[1], b1 - b0);
    add(2, aIn0, aIn1, bMid - gt / 2, bMid + gt / 2, leafTop + fw, H - fw);
  }

  // Türblatt/-blätter im lichten Mass der Zarge, mittig in der Rahmentiefe.
  const lt = Math.min(DOOR_LEAF_THICK, b1 - b0);
  const l0 = bMid - lt / 2;
  const l1 = bMid + lt / 2;
  const leafSpans: [number, number][] =
    leafCount >= 2
      ? [
          [aIn0, (aIn0 + aIn1) / 2],
          [(aIn0 + aIn1) / 2, aIn1],
        ]
      : [[aIn0, aIn1]];
  const glazed = dt?.leafStyle === "glas";
  const ratio = Math.min(0.9, Math.max(0.05, dt?.glazingRatio ?? DEFAULT_GLAZING_RATIO));
  for (const [x0, x1] of leafSpans) {
    if (!glazed) {
      add(1, x0, x1, l0, l1, 0, leafTop);
      continue;
    }
    // Glastür: Glasfläche = `glazingRatio` des Blatts (gleichmässig verkleinert um die Blattmitte), das
    // Blatt als umlaufender Rahmen darum; das Glas füllt die Blattdicke zu 60 % (4–24 mm, mittig).
    const s = Math.sqrt(ratio);
    const cx = (x0 + x1) / 2;
    const cz = leafTop / 2;
    const gw = (x1 - x0) * s;
    const gh = leafTop * s;
    const [px0, px1, pz0, pz1] = [cx - gw / 2, cx + gw / 2, cz - gh / 2, cz + gh / 2];
    add(1, x0, x1, l0, l1, 0, pz0);
    add(1, x0, x1, l0, l1, pz1, leafTop);
    add(1, x0, px0, l0, l1, pz0, pz1);
    add(1, px1, x1, l0, l1, pz0, pz1);
    const gt = Math.min(GLASS_PACKAGE_THICKNESS[1], lt * 0.6);
    add(2, px0, px1, bMid - gt / 2, bMid + gt / 2, pz0, pz1);
  }

  // OperationType: Blattzahl und Scharnierseite. IFC blickt von der Aufschlagseite (+Y des Füllungssystems)
  // auf die Tür; "links" = Scharnier auf der +X-Seite des Systems (X = Y × Z, von +Y aus gesehen links).
  const hingeAtStart = (opening.hinge ?? "start") === "start";
  const hingeAxis = hingeAtStart ? c.from : c.to;
  const hingeLocalX = dotv(sub(at(hingeAxis, 0), origin), doorU);
  const left = hingeLocalX > 0;
  let op: string;
  if (kind === "schiebe") op = leafCount >= 2 ? "DOUBLE_DOOR_SLIDING" : left ? "SLIDING_TO_LEFT" : "SLIDING_TO_RIGHT";
  else op = leafCount >= 2 ? "DOUBLE_DOOR_SINGLE_SWING" : left ? "SINGLE_SWING_LEFT" : "SINGLE_SWING_RIGHT";
  return { origin, u: doorU, kind: op, parts };
}

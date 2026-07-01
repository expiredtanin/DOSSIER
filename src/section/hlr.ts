// Hidden-Line-Removal (HLR) über OCCT-WASM — Welle-C-Spike.
//
// Ziel: aus einfachen Volumenkörpern (Wände, Decke) eine 2D-Vektor-Projektion
// (Schnitt/Ansicht) mit ENTFERNTEN verdeckten Kanten erzeugen — die Grundlage,
// aus der später die bestehende SVG-Plan-Pipeline Schnitte/Ansichten zeichnet.
//
// Kernbefund des Spikes (siehe Report): der opencascade.js-Vollbuild 1.1.1
// exportiert die klassischen HLR-Klassen (`HLRBRep_Algo`/`HLRBRep_HLRToShape`,
// `HLRBRep_PolyAlgo`/`HLRBRep_PolyHLRToShape`) NICHT als konstruierbare Klassen,
// sondern nur deren `Handle_…`-Wrapper. Konstruierbar ist aber der High-Level-
// Wrapper `HLRAppli_ReflectLines`, der intern GENAU den exakten HLR-Algorithmus
// (`HLRBRep_Algo`) fährt und sichtbare/verdeckte Kanten getrennt liefert —
// aufgeteilt nach Kanten-Typ (Sharp/OutLine/…). Das ist der hier genutzte Pfad.
//
// Identifier englisch, Kommentare deutsch (CONVENTIONS.md). Einheiten: METER.

import {
  loadOcct,
  type GpPnt,
  type OpenCascadeInstance,
  type TopoDS_Shape,
} from "./occt";

/** 2D-Punkt in der Projektionsebene (Meter). */
export interface Pt2 {
  x: number;
  y: number;
}

/** Achsparalleler Quader: Ursprung (min-Ecke) + Größe (Meter). */
export interface BoxSpec {
  origin: [number, number, number];
  size: [number, number, number];
}

/**
 * Orthographische Blickrichtung. `dir` = Blickrichtung (worauf die Kamera
 * schaut), `up` = Hoch-Achse der Projektionsebene. Voreinstellungen decken die
 * Ansichtstypen der Roadmap ab (Grundriss = Top, Schnitt/Ansicht = Front/…).
 */
export interface ViewDir {
  dir: [number, number, number];
  up: [number, number, number];
}

/** Häufige Projektionen (rechtshändig, Z = oben). */
export const VIEWS = {
  /** Grundriss: von oben (−Z), Hoch-Achse = +Y. */
  top: { dir: [0, 0, -1], up: [0, 1, 0] } as ViewDir,
  /** Ansicht/Schnitt von vorne (−Y), Hoch-Achse = +Z. */
  front: { dir: [0, -1, 0], up: [0, 0, 1] } as ViewDir,
  /** Ansicht/Schnitt von der Seite (−X), Hoch-Achse = +Z. */
  side: { dir: [-1, 0, 0], up: [0, 0, 1] } as ViewDir,
} as const;

/** Eine projizierte Polylinie (2D) mit Sichtbarkeits-Flag. */
export interface HlrPolyline {
  pts: Pt2[];
  /** `true` = sichtbare Kante, `false` = verdeckte Kante. */
  visible: boolean;
  /** Kanten-Herkunft (für spätere Stil-/Linien-Zuordnung). */
  kind: "sharp" | "outline";
}

/** Ergebnis eines HLR-Laufs. */
export interface HlrResult {
  visible: HlrPolyline[];
  hidden: HlrPolyline[];
  /** Reine Rechenzeit des HLR (ohne WASM-Init), Millisekunden. */
  hlrMs: number;
}

export interface HlrOptions {
  /** Verdeckte Kanten mitberechnen (Default: true). */
  includeHidden?: boolean;
  /** Silhouetten-/OutLine-Kanten mitnehmen (Default: true). */
  includeOutline?: boolean;
}

// ── Geometrie-Aufbau ─────────────────────────────────────────────────────────

function makeBox(oc: OpenCascadeInstance, spec: BoxSpec): TopoDS_Shape {
  const [ox, oy, oz] = spec.origin;
  const [sx, sy, sz] = spec.size;
  const p0 = new oc.gp_Pnt_3(ox, oy, oz);
  const p1 = new oc.gp_Pnt_3(ox + sx, oy + sy, oz + sz);
  return new oc.BRepPrimAPI_MakeBox_3(p0, p1).Shape();
}

/** Mehrere Boxen zu EINEM Solid verschmelzen (BRepAlgoAPI_Fuse, sequenziell). */
function fuseBoxes(oc: OpenCascadeInstance, specs: BoxSpec[]): TopoDS_Shape {
  if (specs.length === 0) throw new Error("hlr: keine Box-Spezifikation");
  let acc = makeBox(oc, specs[0]);
  for (let i = 1; i < specs.length; i++) {
    const next = makeBox(oc, specs[i]);
    const op = new oc.BRepAlgoAPI_Fuse_3(acc, next);
    op.Build?.();
    acc = op.Shape();
  }
  return acc;
}

// ── Kanten-Extraktion ────────────────────────────────────────────────────────

/**
 * Eine (bereits 2D-projizierte) OCCT-Kante als Polylinie ausgeben. Die HLR-
 * Kanten sind gerade Segmente (Box-Fusion), daher genügen Start-/Endpunkt der
 * Kurve; für spätere gekrümmte Geometrie hier zusätzlich tessellieren.
 */
function edgeToPolyline(
  oc: OpenCascadeInstance,
  edgeShape: TopoDS_Shape,
): Pt2[] {
  const edge = oc.TopoDS.Edge_1(edgeShape);
  const adaptor = new oc.BRepAdaptor_Curve_2(edge);
  const u0 = adaptor.FirstParameter();
  const u1 = adaptor.LastParameter();
  const a: GpPnt = adaptor.Value(u0);
  const b: GpPnt = adaptor.Value(u1);
  // 2D-Projektion: X = horizontal, Y = vertikal (Z≈0 in der Projektionsebene).
  return [
    { x: a.X(), y: a.Y() },
    { x: b.X(), y: b.Y() },
  ];
}

function collectEdges(
  oc: OpenCascadeInstance,
  compound: TopoDS_Shape,
  visible: boolean,
  kind: "sharp" | "outline",
): HlrPolyline[] {
  const out: HlrPolyline[] = [];
  const exp = new oc.TopExp_Explorer_2(
    compound,
    oc.TopAbs_ShapeEnum.TopAbs_EDGE,
    oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
  );
  for (; exp.More(); exp.Next()) {
    const pts = edgeToPolyline(oc, exp.Current());
    if (pts.length >= 2) out.push({ pts, visible, kind });
  }
  return out;
}

// ── Öffentliche API ──────────────────────────────────────────────────────────

/**
 * HLR direkt auf einem bereits aufgebauten OCCT-Shape ausführen. Liefert
 * sichtbare (+ optional verdeckte) 2D-Polylinien in der Projektionsebene.
 */
export function hlrShape(
  oc: OpenCascadeInstance,
  shape: TopoDS_Shape,
  view: ViewDir,
  opts: HlrOptions = {},
): HlrResult {
  const includeHidden = opts.includeHidden ?? true;
  const includeOutline = opts.includeOutline ?? true;

  const t0 = performance.now();
  const rl = new oc.HLRAppli_ReflectLines(shape);
  const [dx, dy, dz] = view.dir;
  const [ux, uy, uz] = view.up;
  // SetAxes(projDir, projPoint(at), upDir). Blickpunkt = Ursprung genügt für
  // eine orthographische Projektion (Lage in der Ebene ist translationsfrei).
  rl.SetAxes(dx, dy, dz, 0, 0, 0, ux, uy, uz);
  rl.Perform();

  const T = oc.HLRBRep_TypeOfResultingEdge;
  const visible: HlrPolyline[] = [];
  const hidden: HlrPolyline[] = [];

  // in3d=false → 2D-projizierte Kanten.
  visible.push(
    ...collectEdges(
      oc,
      rl.GetCompoundOf3dEdges(T.HLRBRep_Sharp, true, false),
      true,
      "sharp",
    ),
  );
  if (includeOutline) {
    visible.push(
      ...collectEdges(
        oc,
        rl.GetCompoundOf3dEdges(T.HLRBRep_OutLine, true, false),
        true,
        "outline",
      ),
    );
  }
  if (includeHidden) {
    hidden.push(
      ...collectEdges(
        oc,
        rl.GetCompoundOf3dEdges(T.HLRBRep_Sharp, false, false),
        false,
        "sharp",
      ),
    );
    if (includeOutline) {
      hidden.push(
        ...collectEdges(
          oc,
          rl.GetCompoundOf3dEdges(T.HLRBRep_OutLine, false, false),
          false,
          "outline",
        ),
      );
    }
  }

  const hlrMs = performance.now() - t0;
  return { visible, hidden, hlrMs };
}

/**
 * Komfort-Einstieg: aus Box-Spezifikationen (Wände/Decke) einen Solid fusen und
 * HLR für die gegebene Blickrichtung laufen lassen. Lädt OCCT lazy.
 */
export async function hlrFromBoxes(
  boxes: BoxSpec[],
  view: ViewDir,
  opts: HlrOptions = {},
): Promise<HlrResult> {
  const oc = await loadOcct();
  const shape = fuseBoxes(oc, boxes);
  return hlrShape(oc, shape, view, opts);
}

// ── SVG-Ausgabe (Diagnose/Proof) ─────────────────────────────────────────────

/**
 * Minimaler SVG-Dump zur visuellen Kontrolle: sichtbare Kanten durchgezogen,
 * verdeckte gestrichelt. Kein Bestandteil der Plan-Pipeline — nur Proof/Debug.
 */
export function hlrToSvg(result: HlrResult, padding = 0.5): string {
  const all = [...result.visible, ...result.hidden];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const pl of all)
    for (const p of pl.pts) {
      xs.push(p.x);
      ys.push(p.y);
    }
  const minX = Math.min(...xs) - padding;
  const maxX = Math.max(...xs) + padding;
  const minY = Math.min(...ys) - padding;
  const maxY = Math.max(...ys) + padding;
  const w = maxX - minX;
  const h = maxY - minY;

  // SVG-Y zeigt nach unten → Projektions-Y spiegeln.
  const line = (pl: HlrPolyline): string => {
    const d = pl.pts
      .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x} ${maxY - (p.y - minY)}`)
      .join(" ");
    const stroke = pl.visible ? "#111" : "#999";
    const dash = pl.visible ? "" : ' stroke-dasharray="0.1 0.1"';
    const sw = pl.kind === "outline" ? 0.04 : 0.02;
    return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}"${dash}/>`;
  };

  const paths = all.map(line).join("\n  ");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${w} ${h}" width="800">
  <rect x="${minX}" y="${minY}" width="${w}" height="${h}" fill="#fff"/>
  ${paths}
</svg>`;
}

// Lazy-Loader + schmale Typ-Fassade für opencascade.js (OCCT-WASM).
//
// Welle-C-Spike (Hidden-Line-Removal). Das Paket `opencascade.js` (Vollbuild
// 1.1.1) liefert KEINE TypeScript-Typen und exportiert ~20 000 embind-Symbole.
// Wir tippen hier NUR die Klassen/Methoden, die `hlr.ts` tatsächlich benutzt —
// verifiziert gegen die reale Laufzeit-API (embind versioniert überladene
// Konstruktoren als `_1`, `_2`, …).
//
// Laden erfolgt bewusst über einen dynamischen Import (siehe `loadOcct`), damit
// die 66-MB-WASM NICHT ins Haupt-Bundle wandert und nur bei tatsächlichem
// Bedarf (Schnitt-/Ansichts-Generierung) geholt wird.
//
// Identifier englisch, Kommentare deutsch (CONVENTIONS.md).

// ── Schmale Typ-Fassade (nur das Benutzte) ───────────────────────────────────

export interface GpPnt {
  X(): number;
  Y(): number;
  Z(): number;
}

export interface TopoDS_Shape {
  ShapeType(): unknown;
  IsNull(): boolean;
}

interface TopoDS_Edge extends TopoDS_Shape {}

interface Ctor1<T, A> {
  new (a: A): T;
}
interface Ctor3<T, A, B, C> {
  new (a: A, b: B, c: C): T;
}

interface ShapeEnum {
  TopAbs_EDGE: unknown;
  TopAbs_FACE: unknown;
  TopAbs_SHAPE: unknown;
  TopAbs_SOLID: unknown;
}

interface ResultingEdgeEnum {
  HLRBRep_Sharp: unknown;
  HLRBRep_OutLine: unknown;
  HLRBRep_IsoLine: unknown;
  HLRBRep_Rg1Line: unknown;
  HLRBRep_RgNLine: unknown;
}

interface TopExpExplorer {
  More(): boolean;
  Next(): void;
  Current(): TopoDS_Shape;
}

interface BRepAdaptorCurve {
  FirstParameter(): number;
  LastParameter(): number;
  Value(u: number): GpPnt;
}

interface MakeBox {
  Shape(): TopoDS_Shape;
}

interface BooleanOp {
  Shape(): TopoDS_Shape;
  Build?(): void;
}

interface ReflectLines {
  SetAxes(
    nx: number,
    ny: number,
    nz: number,
    xAt: number,
    yAt: number,
    zAt: number,
    xUp: number,
    yUp: number,
    zUp: number,
  ): void;
  Perform(): void;
  /**
   * Kanten-Compound holen. `visible`=true → sichtbar, false → verdeckt.
   * `in3d`=true → 3D-Kanten, false → 2D-projizierte Kanten (Z≈0 in der
   * Projektionsebene: X = horizontal, Y = vertikal).
   */
  GetCompoundOf3dEdges(
    type: unknown,
    visible: boolean,
    in3d: boolean,
  ): TopoDS_Shape;
}

/** Nur die von `hlr.ts` genutzten OCCT-Symbole. */
export interface OpenCascadeInstance {
  gp_Pnt_3: Ctor3<GpPnt, number, number, number>;

  BRepPrimAPI_MakeBox_1: Ctor3<MakeBox, number, number, number>;
  BRepPrimAPI_MakeBox_3: Ctor1<MakeBox, GpPnt> & {
    new (origin: GpPnt, corner: GpPnt): MakeBox;
  };

  BRepAlgoAPI_Fuse_3: {
    new (a: TopoDS_Shape, b: TopoDS_Shape): BooleanOp;
  };

  HLRAppli_ReflectLines: Ctor1<ReflectLines, TopoDS_Shape>;

  TopExp_Explorer_2: {
    new (s: TopoDS_Shape, toFind: unknown, toAvoid: unknown): TopExpExplorer;
  };

  BRepAdaptor_Curve_2: Ctor1<BRepAdaptorCurve, TopoDS_Edge>;

  TopoDS: { Edge_1(s: TopoDS_Shape): TopoDS_Edge };

  TopAbs_ShapeEnum: ShapeEnum;
  HLRBRep_TypeOfResultingEdge: ResultingEdgeEnum;
}

// ── Lazy-Loader ──────────────────────────────────────────────────────────────

type OcctFactory = (opts?: {
  locateFile?: (filename: string, scriptDir: string) => string;
  wasmBinary?: ArrayBuffer | Uint8Array;
}) => Promise<unknown>;

let occtPromise: Promise<OpenCascadeInstance> | null = null;

/** Optionale Metriken des letzten Ladevorgangs (für den Feasibility-Report). */
export interface LoadMetrics {
  wasmBytes: number;
  fetchMs: number;
  initMs: number;
}
let lastMetrics: LoadMetrics | null = null;
export const getLoadMetrics = (): LoadMetrics | null => lastMetrics;

/**
 * Lädt + initialisiert OCCT-WASM (lazy, einmalig). Glue + `.wasm`-URL werden —
 * wie bei LibreDWG — über virtuelle Vite-Module aufgelöst, damit die WASM in Dev
 * UND Build mit korrektem MIME-Type geladen wird. Der dynamische Import hält die
 * 66-MB-WASM aus dem Haupt-Bundle heraus.
 */
export function loadOcct(): Promise<OpenCascadeInstance> {
  if (!occtPromise) {
    occtPromise = (async () => {
      const [glueMod, wasmUrlMod] = await Promise.all([
        import("virtual:occt-glue"),
        import("virtual:occt-wasm-url"),
      ]);
      const createModule = glueMod.default as OcctFactory;
      const wasmUrl = wasmUrlMod.default;

      // WASM einmal explizit holen → Größe messen + als `wasmBinary` reichen
      // (spart Emscripten den zweiten Fetch, macht die Größe messbar).
      const tFetch = performance.now();
      const resp = await fetch(wasmUrl);
      const wasmBinary = await resp.arrayBuffer();
      const fetchMs = performance.now() - tFetch;

      const tInit = performance.now();
      const instance = (await createModule({
        locateFile: () => wasmUrl,
        wasmBinary,
      })) as OpenCascadeInstance;
      const initMs = performance.now() - tInit;

      lastMetrics = { wasmBytes: wasmBinary.byteLength, fetchMs, initMs };
      return instance;
    })();
  }
  return occtPromise;
}

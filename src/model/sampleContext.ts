// Synthetische Kontext-Importe für Leistungsmessungen ([257]): deterministisch (feste Zufallsfolge, keine Zeit,
// kein Netz), keine echten Daten. Erzeugt die Rohdateien, wie ein Wettbewerb sie lädt:
//  - Kataster-DXF einer Umgebung (Gebäudeumrisse, Parzellen, Strassen, Beschriftungen),
//  - Gebäudenetze (swissBUILDINGS3D-artig, als OBJ-Text, Hunderte Gebäude, ~100k Dreiecke),
//  - Höhenlinien-DXF (3D-Polylinien auf einem Höhenlinien-Layer).
// Genutzt von `dossier-cli bench --context` und `src/cli/contextBench.test.ts`; kein Menüpunkt in der App.

export interface ContextOptions {
  /** Kantenlänge des Quartiers in Metern (Standard 400 → 1:500-Situation). */
  extent?: number;
  /** Gebäude im Kataster (Standard 900 Umrisse). */
  footprints?: number;
  /** Gebäude im Netz (Standard 300). */
  buildings?: number;
  /** Ziel-Dreiecke insgesamt im Netz (Standard 100 000). */
  triangles?: number;
  /** Höhenlinien: Anzahl Linien (Standard 80) mit je `contourPoints` Punkten (Standard 60) → ~5000 Punkte. */
  contours?: number;
  contourPoints?: number;
  /** Verschiebung aller Koordinaten (Standard 0; LV95-artig z. B. 2600000/1200000). */
  originX?: number;
  originY?: number;
}

/** Kleine deterministische Zufallsfolge (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const f = (n: number): string => (Math.round(n * 1000) / 1000).toString();

/** Höhe des synthetischen Geländes: ein Hügel (Gauss) über 400 m ü. M., Mitte im Ursprung. */
export function contextTerrainZ(x: number, y: number): number {
  return 400 + 12 * Math.exp(-(x * x + y * y) / (200 * 200));
}

function dxfDoc(entities: string[]): string {
  return ["0", "SECTION", "2", "ENTITIES", ...entities, "0", "ENDSEC", "0", "EOF"].join("\n");
}

function lwpoly(layer: string, pts: Array<[number, number]>, closed: boolean): string[] {
  return ["0", "LWPOLYLINE", "8", layer, "90", String(pts.length), "70", closed ? "1" : "0", ...pts.flatMap(([x, y]) => ["10", f(x), "20", f(y)])];
}

/** Kataster-DXF: Gebäudeumrisse (geschlossene Polylinien, teils L-förmig), Parzellen, Strassenlinien, Hausnummern. */
export function buildContextCadastreDxf(o: ContextOptions = {}): string {
  const ext = o.extent ?? 400;
  const n = o.footprints ?? 900;
  const ox = o.originX ?? 0;
  const oy = o.originY ?? 0;
  const rand = rng(11);
  const ent: string[] = [];
  const cols = Math.ceil(Math.sqrt(n));
  const cell = ext / cols;
  for (let i = 0; i < n; i++) {
    const cx = ox - ext / 2 + (i % cols) * cell;
    const cy = oy - ext / 2 + Math.floor(i / cols) * cell;
    // Parzelle (Rechteck der Zelle, leicht verzogen)
    const j = () => (rand() - 0.5) * cell * 0.08;
    const parcel: Array<[number, number]> = [[cx + j(), cy + j()], [cx + cell + j(), cy + j()], [cx + cell + j(), cy + cell + j()], [cx + j(), cy + cell + j()]];
    ent.push(...lwpoly("Parzellen", parcel, true));
    // Gebäude (Rechteck oder L)
    const w = cell * (0.35 + rand() * 0.3);
    const d = cell * (0.3 + rand() * 0.3);
    const bx = cx + cell * 0.15 + rand() * cell * 0.1;
    const by = cy + cell * 0.15 + rand() * cell * 0.1;
    const ring: Array<[number, number]> = rand() < 0.35
      ? [[bx, by], [bx + w, by], [bx + w, by + d * 0.5], [bx + w * 0.5, by + d * 0.5], [bx + w * 0.5, by + d], [bx, by + d]]
      : [[bx, by], [bx + w, by], [bx + w, by + d], [bx, by + d]];
    ent.push(...lwpoly("Gebaeude", ring, true));
    if (i % 3 === 0) ent.push("0", "TEXT", "8", "Hausnummern", "10", f(bx + w / 2), "20", f(by + d / 2), "40", "1.5", "1", String(1 + (i % 97)));
  }
  // Strassen: Gitterlinien als offene Polylinien aus Segmenten (wie digitalisierte Achsen) und einzelne LINEs
  for (let k = 0; k <= cols; k += 2) {
    const pts: Array<[number, number]> = [];
    for (let s = 0; s <= 40; s++) pts.push([ox - ext / 2 + k * cell + Math.sin(s / 5) * 1.5, oy - ext / 2 + (s / 40) * ext]);
    ent.push(...lwpoly("Strassen", pts, false));
    for (let s = 0; s < 20; s++) {
      const y = oy - ext / 2 + (s / 20) * ext;
      ent.push("0", "LINE", "8", "Strassenrand", "10", f(ox - ext / 2 + k * cell + 3), "20", f(y), "11", f(ox - ext / 2 + k * cell + 3), "21", f(y + ext / 20));
    }
  }
  return dxfDoc(ent);
}

/**
 * Höhenlinien-DXF: je Höhe ein geschlossener Ring (LWPOLYLINE mit Erhebung, Gruppe 38) auf dem Layer „Hoehenlinien“,
 * Ringe um den Hügel von {@link contextTerrainZ} (Radius je Höhe, leicht gewellt, nie kreuzend).
 */
export function buildContextContoursDxf(o: ContextOptions = {}): string {
  const nl = o.contours ?? 80;
  const np = o.contourPoints ?? 60;
  const ox = o.originX ?? 0;
  const oy = o.originY ?? 0;
  const ent: string[] = [];
  for (let k = 0; k < nl; k++) {
    const z = 400 + 0.15 * (k + 1);
    const r0 = 200 * Math.sqrt(Math.log(12 / (z - 400)));
    const pts: Array<[number, number]> = [];
    for (let s = 0; s < np; s++) {
      const th = (s / np) * 2 * Math.PI;
      const r = r0 * (1 + 0.04 * Math.sin(3 * th + 1));
      pts.push([ox + r * Math.cos(th), oy + r * Math.sin(th)]);
    }
    ent.push("0", "LWPOLYLINE", "8", "Hoehenlinien", "90", String(np), "70", "1", "38", f(z), ...pts.flatMap(([x, y]) => ["10", f(x), "20", f(y)]));
  }
  return dxfDoc(ent);
}

/**
 * Gebäudenetze als OBJ-Text: je Gebäude ein `o`-Objekt (Quader mit Satteldach), die Wände sind in Streifen unterteilt,
 * bis `triangles` insgesamt erreicht sind (swissBUILDINGS3D hat feine Fassaden). Z-oben (Höhenkoten wie Gelände).
 */
export function buildContextBuildingsObj(o: ContextOptions = {}): string {
  const ext = o.extent ?? 400;
  const nb = o.buildings ?? 300;
  const target = o.triangles ?? 100_000;
  const ox = o.originX ?? 0;
  const oy = o.originY ?? 0;
  const rand = rng(23);
  const perBuilding = Math.max(12, Math.floor(target / nb));
  // Streifen je Wand: 4 Wände × 2 Dreiecke × n + Dach (4) + Boden (2) ≈ 8n + 6
  const strips = Math.max(1, Math.round((perBuilding - 6) / 8));
  const cols = Math.ceil(Math.sqrt(nb));
  const cell = ext / cols;
  const lines: string[] = [];
  let base = 1; // OBJ-Indizes ab 1
  for (let b = 0; b < nb; b++) {
    const w = cell * (0.3 + rand() * 0.3);
    const d = cell * (0.3 + rand() * 0.3);
    const x0 = ox - ext / 2 + (b % cols) * cell + cell * 0.2;
    const y0 = oy - ext / 2 + Math.floor(b / cols) * cell + cell * 0.2;
    const z0 = contextTerrainZ(x0 - ox, y0 - oy) - 1;
    const h = 6 + Math.floor(rand() * 4) * 3;
    const ridge = 2 + rand() * 2;
    lines.push(`o Gebaeude_${b + 1}`);
    const verts: Array<[number, number, number]> = [];
    const tris: Array<[number, number, number]> = [];
    const v = (x: number, y: number, z: number): number => {
      verts.push([x, y, z]);
      return base + verts.length - 1;
    };
    // vier Wände als Gitter strips × 1 (Streifen entlang der Wand)
    const corners: Array<[number, number]> = [[x0, y0], [x0 + w, y0], [x0 + w, y0 + d], [x0, y0 + d]];
    for (let c = 0; c < 4; c++) {
      const [ax, ay] = corners[c];
      const [bx2, by2] = corners[(c + 1) % 4];
      let prevB = 0;
      let prevT = 0;
      for (let s = 0; s <= strips; s++) {
        const t = s / strips;
        const x = ax + (bx2 - ax) * t;
        const y = ay + (by2 - ay) * t;
        const vb = v(x, y, z0);
        const vt = v(x, y, z0 + h);
        if (s > 0) {
          tris.push([prevB, vb, vt]);
          tris.push([prevB, vt, prevT]);
        }
        prevB = vb;
        prevT = vt;
      }
    }
    // Satteldach: First über die lange Seite, 4 Dreiecke
    const r1 = v(x0, y0 + d / 2, z0 + h + ridge);
    const r2 = v(x0 + w, y0 + d / 2, z0 + h + ridge);
    const e0 = v(x0, y0, z0 + h);
    const e1 = v(x0 + w, y0, z0 + h);
    const e2 = v(x0 + w, y0 + d, z0 + h);
    const e3 = v(x0, y0 + d, z0 + h);
    tris.push([e0, e1, r2], [e0, r2, r1], [e3, r1, r2], [e3, r2, e2]);
    // Boden
    const g0 = v(x0, y0, z0);
    const g1 = v(x0 + w, y0, z0);
    const g2 = v(x0 + w, y0 + d, z0);
    const g3 = v(x0, y0 + d, z0);
    tris.push([g0, g2, g1], [g0, g3, g2]);
    for (const [x, y, z] of verts) lines.push(`v ${f(x)} ${f(y)} ${f(z)}`);
    for (const [a, c, e] of tris) lines.push(`f ${a} ${c} ${e}`);
    base += verts.length;
  }
  return lines.join("\n") + "\n";
}

// Auswahl/Picken im Grundriss über den Kern ([K3d], `src-tauri/core/src/plan_pick.rs`): ein
// räumlicher Index je Plan (2D-Zeichenlinien, Polygone, Symbol-Linien, Kreise/Bögen, Besitzer),
// gebaut direkt aus den Plan-Puffern (`planParts.ts`). TS fragt nur ab; Ergebnisse sind Indizes in
// `plan.primitives`. Ersetzt `segmentIndex.ts`, `ownerIndex.ts` und die Schleifen über alle
// Primitive bei jeder Mausbewegung (Treffer, Raum/Dach/Treppe/Öffnung …).
//
// Lebensdauer: der Index liegt im Kern, bis {@link PlanPickIndex.release} ihn freigibt (PlanView
// gibt den alten frei, sobald ein neuer Plan einen neuen braucht).

import type { Vec2 } from "../../model/types";
import type { Plan, Primitive } from "../generatePlan";
import { heldSegs, planParts } from "../planParts";
import { planPrimAt } from "../planLazy";
import { core } from "../../engine/coreWasm";
import type { ModelRect } from "./geometry";

/** Pick-Felder eines Primitivs (Besitzer-Ids). */
export const OWNER_FIELDS = [
  "wallId",
  "drawingId",
  "ceilingId",
  "openingId",
  "stairId",
  "roomId",
  "roofId",
  "contextObjectId",
  "sectionLineId",
  "extrudedSolidId",
  "columnId",
] as const;
export type OwnerField = (typeof OWNER_FIELDS)[number];

/** Pick-Art im Plan-Puffer (s. `plan_buf.rs`). */
const KIND: Record<OwnerField, number> = {
  wallId: 1,
  drawingId: 2,
  ceilingId: 3,
  openingId: 4,
  stairId: 5,
  roomId: 6,
  extrudedSolidId: 7,
  contextObjectId: 8,
  columnId: 9,
  roofId: 10,
  sectionLineId: 11,
};

/** Bit-Maske der Felder (0 = keine Einschränkung). */
const mask = (fields: readonly OwnerField[]): number => fields.reduce((m, f) => m | (1 << KIND[f]), 0);

/** Abbildung Modell → Client-Pixel (`toScreen` + `vbToClient` der PlanView). */
export interface ClientMap {
  /** `rect.left + offX` */
  left: number;
  /** `rect.top + offY` */
  top: number;
  viewX: number;
  viewY: number;
  scale: number;
}

/** Typ-Kennung im Plan-Puffer → `kind` (s. `plan_buf.rs`). */
const TAG_KIND: Record<number, Primitive["kind"]> = {
  1: "polygon",
  2: "line",
  3: "arc",
  4: "drawingCircle",
  5: "drawingArc",
  6: "text",
  7: "drawingText",
  8: "drawingTextPath",
  9: "drawingImage",
};

/** Ids aus einer Kern-Antwort (jede mit `\0` davor). */
const splitIds = (s: string): string[] => (s ? s.split("\0").slice(1) : []);

export class PlanPickIndex {
  private id = 0;

  constructor(readonly plan: Plan) {}

  /** Primitiv `i` des Plans (bei einem lazy Plan nur dieser Eintrag gelesen). */
  prim(i: number): Primitive | undefined {
    return planPrimAt(this.plan, i);
  }

  /** Kern-Index (lazy beim ersten Abfragen gebaut). Texte/Bilder mit JSON (Rahmen-Treffer). */
  private ix(): number {
    if (this.id) return this.id;
    const c = core();
    const parts = planParts(this.plan, true);
    this.id = c.pick_index_build(heldSegs(parts, false));
    if (!this.id) this.id = c.pick_index_build(heldSegs(parts, true));
    return this.id;
  }

  /** Kern-Index freigeben (danach baut eine Abfrage ihn neu). */
  release(): void {
    if (this.id) core().pick_index_release(this.id);
    this.id = 0;
  }

  /**
   * Nächstes Segment einer 2D-Zeichnung (`line` mit `drawingId`) mit Abstand < `maxDist` (Meter):
   * Index und Abstand, oder null.
   */
  nearestSegment(m: Vec2, maxDist: number): { i: number; dist: number } | null {
    const f = core().pick_nearest_segment(this.ix(), m.x, m.y, maxDist);
    return f.length === 2 ? { i: f[0], dist: f[1] } : null;
  }

  /** Alle solchen Segmente mit Abstand < `maxDist`, nächste zuerst. */
  segmentsNear(m: Vec2, maxDist: number): Array<{ i: number; dist: number }> {
    const f = core().pick_segments_near(this.ix(), m.x, m.y, maxDist);
    const out: Array<{ i: number; dist: number }> = [];
    for (let k = 0; k + 1 < f.length; k += 2) out.push({ i: f[k], dist: f[k + 1] });
    return out;
  }

  /**
   * Polygone, die `m` enthalten, oberstes (zuletzt gezeichnetes) zuerst; mit `fields` nur solche
   * mit einer nicht-leeren Id eines dieser Felder.
   */
  polygonsAt(m: Vec2, ...fields: OwnerField[]): number[] {
    return Array.from(core().pick_polygons_at(this.ix(), m.x, m.y, mask(fields)));
  }

  /** Oberstes Polygon unter `m` (s. {@link polygonsAt}) oder null. */
  topPolygon(m: Vec2, ...fields: OwnerField[]): number | null {
    const l = this.polygonsAt(m, ...fields);
    return l.length ? l[0] : null;
  }

  /** Unterstes (zuerst gezeichnetes) Polygon unter `m` oder null. */
  bottomPolygon(m: Vec2, ...fields: OwnerField[]): number | null {
    const l = this.polygonsAt(m, ...fields);
    return l.length ? l[l.length - 1] : null;
  }

  /**
   * Nächste Symbol-Linie mit einer Id aus `lineFields` (bzw. Bogen über die Sehne `from → to` mit
   * `arcFields`) zum Client-Punkt, Abstand in Pixeln < `maxPx`; erster bei Gleichstand.
   */
  nearestSymbolPx(lineFields: OwnerField[], arcFields: OwnerField[], map: ClientMap, client: { x: number; y: number }, maxPx: number): number | null {
    const i = core().pick_nearest_symbol_px(this.ix(), mask(lineFields), mask(arcFields), map.left, map.top, map.viewX, map.viewY, map.scale, client.x, client.y, maxPx);
    return i >= 0 ? i : null;
  }

  /**
   * Kreise/Bögen der 2D-Zeichnung (`drawingCircle`/`drawingArc` mit `drawingId`), deren Ring
   * näher als `tolPx` Pixel liegt (gefüllte Kreise auch innen; Bögen nur in ihrer Spanne mit
   * `tolPx`-Saum) — in Plan-Reihenfolge, Abstand in Pixeln.
   */
  ringsNear(m: Vec2, pxPerM: number, tolPx: number): Array<{ i: number; dpx: number }> {
    const f = core().pick_rings_near(this.ix(), m.x, m.y, pxPerM, tolPx);
    const out: Array<{ i: number; dpx: number }> = [];
    for (let k = 0; k + 1 < f.length; k += 2) out.push({ i: f[k], dpx: f[k + 1] });
    return out;
  }

  /** Primitive, deren `field` in `ids` liegt — in Plan-Reihenfolge. */
  ownedBy(field: OwnerField, ids: Iterable<string>): Primitive[] {
    const list = [...ids];
    if (list.length === 0) return [];
    const hits = core().pick_owned_by(this.ix(), KIND[field], list.map((s) => "\u0000" + s).join(""));
    return Array.from(hits, (i) => planPrimAt(this.plan, i)!);
  }

  /** Erster Einzeltext (`drawingText` mit `drawingId`), dessen Rahmen `m` enthält, oder null. */
  drawingTextAt(m: Vec2): number | null {
    const i = core().pick_drawing_text(this.ix(), m.x, m.y);
    return i >= 0 ? i : null;
  }

  /** Oberstes Bild (`drawingImage` mit `drawingId`) unter `m` oder null. */
  drawingImageAt(m: Vec2): number | null {
    const i = core().pick_drawing_image(this.ix(), m.x, m.y);
    return i >= 0 ? i : null;
  }

  /** Art des ersten formgebenden Primitivs einer Zeichnung (Linie, Polygon, Text, …) oder null. */
  drawingKind(drawingId: string): Primitive["kind"] | null {
    return TAG_KIND[core().pick_drawing_kind(this.ix(), drawingId)] ?? null;
  }

  /**
   * Rahmen-Auswahl über Polygone mit Id im Feld `field` (CAD-Konvention): `crossing` = ein Band
   * berührt das Rechteck, sonst liegen alle Bänder ganz darin. Ids in Auftreten-Reihenfolge.
   */
  marquee(field: "wallId" | "ceilingId" | "roomId" | "stairId" | "columnId" | "roofId", rect: ModelRect, crossing: boolean): string[] {
    const r = Float64Array.of(rect.minX, rect.minY, rect.maxX, rect.maxY);
    return splitIds(core().pick_marquee_polygons(this.ix(), KIND[field], r, crossing));
  }

  /**
   * Rahmen-Auswahl über 2D-Zeichnungen (alle Punkte je Zeichnung: Linien, Polygone, abgetastete
   * Kreise/Bögen, Text-/Bild-Rahmen); `skipIds` prüft der Aufrufer selbst (kompakte Unterlage).
   */
  marqueeDrawings(rect: ModelRect, crossing: boolean, skipIds?: Iterable<string>): string[] {
    const r = Float64Array.of(rect.minX, rect.minY, rect.maxX, rect.maxY);
    const skip = skipIds ? [...skipIds].map((s) => "\0" + s).join("") : "";
    return splitIds(core().pick_marquee_drawings(this.ix(), r, crossing, skip));
  }
}

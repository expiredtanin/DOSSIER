// Site-Slice: Gelände- und Umgebungs-Elemente `project.context` (Netzkörper, Höhenlinien, Gelände, Luftbild,
// Baugrube). [181] Normale Elemente mit Klasse — keine eigene „Kontext-Schicht" mit Import-Liste mehr.
//
// Entwurfsentscheidung: `context` ist Teil von `project` (ein einziger
// Wahrheits-Baum, konsistent mit projectSlice). Diese Slice MUTIERT daher
// `project.context` über die vorhandene `applyChange`-Aktion (Ops, Cross-Slice),
// genau wie projectSlice. So bleiben Persistenz/Undo einheitlich am Project hängen.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { generateTerrainFromContours, resmoothGridTerrain, type TerrainOptions } from "../model/terrain";
import type { ContextObject, Drawing2D, Project, Vec2 } from "../model/types";
import { isGeoBuildingMesh, type ImportedLine } from "../io/geoContext";
import { documentFor } from "../core/document";
import { transformOps } from "../tools/transform";
import { addItems, fieldOps, patchItem, removeItems } from "../core/opsBuild";
import type { CoreOp } from "../core/ops";
import { ensureContextCategories } from "../model/contextCategories";
import type { StoreApi } from "./store";

/** Felder/Actions, die diese Slice in den RootState beisteuert. */
export interface SiteSlice {
  /** Fügt ein Kontext-Objekt (Mesh/Konturen/Gelände) hinzu (immutabel). */
  addContextObject: (obj: ContextObject) => void;
  /** Fügt mehrere Kontext-Objekte in einem Schritt hinzu (z. B. DXF-Import). */
  /**
   * Übernimmt Importe als normale Elemente: Kontext-Objekte in `project.context`, Linien (`lines`, z. B. die
   * Umrisse des Standort-Imports) als einzelne 2D-Zeichnungen auf der aktiven Ebene; ein Undo-Schritt.
   */
  addContextObjects: (objs: ContextObject[], lines?: ImportedLine[]) => void;
  /**
   * [227] Setzt Kontextgebäude (importierte Netze) aufs Gelände: jedes Gebäude des Netzes auf den tiefsten Geländepunkt
   * unter seinem Grundriss (Kern `context_ground.rs`). true = mindestens ein Netz wurde versetzt.
   */
  groundContextObjects: (ids: string[]) => boolean;
  /** Entfernt ein Kontext-Objekt per ID (No-op bei unbekannter ID). */
  removeContextObject: (id: string) => void;
  /** Entfernt mehrere Kontext-Objekte in EINEM Schritt (z. B. eine ganze
   *  Ebene/Gruppe importierter Gebäude) — ein einziger Undo-Eintrag. */
  removeContextObjects: (ids: string[]) => void;
  /**
   * Erzeugt aus einem ContourSet (per ID) ein Gelände-TIN und fügt es als
   * weiteres Kontext-Objekt hinzu. Liefert die ID des neuen TerrainMesh, oder
   * null, wenn der ContourSet nicht existiert / kein Mesh entsteht.
   */
  generateTerrain: (contourSetId: string, opts?: TerrainOptions) => string | null;
  /** [193] Alle Höhen eines Elements um `dz` Meter versetzen (Netz-z, Höhenlinien-z, Baugruben-Sohle; Kern `cmd_context.rs`). */
  offsetContextHeight: (id: string, dz: number) => void;
  /** [193] Höhe der Höhenlinie `index` eines Höhenlinien-Satzes setzen (Kern `cmd_context.rs`); `coalesceKey` für Tippen. */
  setContourHeight: (id: string, index: number, z: number, coalesceKey?: string) => void;
  /** [193] Höhe eines Netzpunkts (Vertex-Nummer ab 0) setzen. */
  setMeshPointHeight: (id: string, index: number, z: number, coalesceKey?: string) => void;
  /** [193] Netzpunkt löschen; sein Loch wird neu vernetzt (Kern `cmd_context.rs`); false = nichts geändert. */
  deleteMeshPoint: (id: string, index: number) => boolean;
  /** [193] Aktiver Netzpunkt (Klick auf den Griff): die Objekt-Info zeigt seine Nummer und Höhe. */
  activeMeshPoint: { id: string; index: number } | null;
  setActiveMeshPoint: (p: { id: string; index: number } | null) => void;
  /** [193] Offene Höhen-Eingabe für einen Netzpunkt (Rechtsklick auf den Griff, „Höhe setzen …"). */
  meshHeightPrompt: { id: string; index: number } | null;
  setMeshHeightPrompt: (p: { id: string; index: number } | null) => void;
  /** [193] Netz auf ein Polygon (Modell-Meter) zuschneiden; false = nichts geändert. */
  cropMesh: (id: string, poly: Vec2[]) => boolean;
  /** [193] Kontext-Elemente um `delta` verschieben (Maus-Ziehen im Plan; Kern `cmd_transform.rs`), ein Undo-Schritt. */
  moveContextBy: (ids: string[], delta: Vec2) => void;
  /** [T6]/[68] Ändert Felder eines Kontext-Objekts (Gelände, Baugrube) in einem Schritt; `coalesceKey` für Tippen. */
  patchContextObject: (id: string, patch: Record<string, unknown>, coalesceKey?: string) => void;
  /**
   * [137] Gelände `terrainId` aus seinen Höhenlinien (`sourceId`, sonst dem ersten Höhenlinien-Satz) mit
   * Glättungsstufe `smooth` (0 = roh) neu erzeugen — gleiche Id und Einstellungen, ein Undo-Schritt.
   * `false`, wenn es keine Quelle gibt oder kein Netz entsteht.
   */
  regenerateTerrain: (terrainId: string, smooth: number) => boolean;
  /**
   * [137] Raster-Gelände (swissALTI3D, ohne Höhenlinien-Quelle) um `passes` Durchgänge nachglätten:
   * gleiche Id, nur z geändert, `smooth` zählt die Durchgänge; ein Undo-Schritt. false = kein Raster.
   */
  resmoothTerrain: (terrainId: string, passes: number) => boolean;
  /** Leert die gesamte Kontext-Schicht. */
  clearContext: () => void;
}

/**
 * Cross-Slice-Abhängigkeit: diese Slice liest `project` und schreibt es über
 * `applyChange` (beide aus projectSlice). Der Store komponiert SiteSlice mit
 * dieser Sicht, sodass `get()`/Actions typsicher auf das Projekt zugreifen.
 */
type SiteSliceDeps = {
  project: Project;
  activeLevelId: string;
  applyChange: (ops: readonly CoreOp[] | ((p: Project) => readonly CoreOp[]), coalesceKey?: string) => void;
  groupChanges: (fn: () => void, key?: string) => void;
};

export function createSiteSlice(
  api: StoreApi<SiteSlice & SiteSliceDeps>,
): SiteSlice {
  const { get } = api;


  // Wie `setContext`, aber fürs HINZUFÜGEN: ergänzt zusätzlich jede fehlende
  // Grafik-Kategorie der neu ankommenden Objekte in `project.layers` (s.
  // `ensureContextCategories`), damit sie sofort im Ebenen-Panel erscheinen
  // und über dessen Sichtbarkeit/Grau/Sperren steuerbar sind — genau wie
  // Wand/Decke/Dach, statt wie bisher immer unconditional gezeichnet zu werden.
  const addToContext = (added: ContextObject[], lines: ImportedLine[] = []): void => {
    if (added.length === 0 && lines.length === 0) return;
    const levelId = get().activeLevelId;
    const drawings: Drawing2D[] = lines.map((l) => ({ ...l, levelId }));
    const codes = [...added, ...drawings]
      .map((o) => o.categoryCode)
      .filter((c): c is string => !!c);
    // [227] Importierte Gebäude (Kataster/swisstopo/OSM) stehen auf dem Gelände, nicht auf z = 0 — im selben Undo-Schritt.
    const buildings = added.filter(isGeoBuildingMesh).map((o) => o.id);
    get().groupChanges(() => {
      get().applyChange((p) => [
        ...addItems("context", added),
        ...addItems("drawings2d", drawings),
        ...fieldOps(p, "layers", ensureContextCategories(p.layers, codes)),
      ]);
      if (buildings.length) get().groundContextObjects(buildings);
    });
  };

  return {
    addContextObject: (obj) => addToContext([obj]),

    addContextObjects: (objs, lines) => addToContext(objs, lines),

    groundContextObjects: (ids) => {
      const ops = documentFor(get().project).cmdOps({ cmd: "contextToTerrain", ids });
      if (ops.length === 0) return false;
      get().applyChange(ops);
      return true;
    },

    removeContextObject: (id) => get().applyChange((p) => removeItems(p, "context", [id])),

    removeContextObjects: (ids) => {
      if (ids.length === 0) return;
      get().applyChange((p) => removeItems(p, "context", ids));
    },

    offsetContextHeight: (id, dz) => {
      const ops = documentFor(get().project).cmdOps({ cmd: "contextOffset", id, dz });
      if (ops.length) get().applyChange(ops);
    },

    setContourHeight: (id, index, z, coalesceKey) => {
      const ops = documentFor(get().project).cmdOps({ cmd: "contourZ", id, index, z });
      if (ops.length) get().applyChange(ops, coalesceKey);
    },

    setMeshPointHeight: (id, index, z, coalesceKey) => {
      const ops = documentFor(get().project).cmdOps({ cmd: "meshPointZ", id, index, z });
      if (ops.length) get().applyChange(ops, coalesceKey);
    },

    deleteMeshPoint: (id, index) => {
      const ops = documentFor(get().project).cmdOps({ cmd: "meshPointDelete", id, index });
      if (ops.length) {
        get().applyChange(ops);
        api.set({ activeMeshPoint: null, meshHeightPrompt: null }); // Nummern verschieben sich
      }
      return ops.length > 0;
    },

    activeMeshPoint: null,
    setActiveMeshPoint: (p) => {
      const cur = get().activeMeshPoint;
      if (cur?.id === p?.id && cur?.index === p?.index) return;
      api.set({ activeMeshPoint: p });
    },
    meshHeightPrompt: null,
    setMeshHeightPrompt: (p) => api.set({ meshHeightPrompt: p }),

    cropMesh: (id, poly) => {
      const ops = documentFor(get().project).cmdOps({ cmd: "meshCrop", id, poly: poly.flatMap((q) => [q.x, q.y]) });
      if (ops.length) get().applyChange(ops);
      return ops.length > 0;
    },

    moveContextBy: (ids, delta) => {
      if (ids.length === 0 || (delta.x === 0 && delta.y === 0)) return;
      const ops = transformOps(get().project, { wallIds: [], drawingId: null, contextIds: ids }, "move", [{ x: 0, y: 0 }, delta], "move", 1);
      if (ops.length) get().applyChange(ops);
    },

    patchContextObject: (id, patch, coalesceKey) =>
      get().applyChange((p) => patchItem(p, "context", id, (o) => ({ ...o, ...patch }) as ContextObject), coalesceKey),

    generateTerrain: (contourSetId, opts) => {
      const ctx = get().project.context ?? [];
      const set = ctx.find(
        (o) => o.id === contourSetId && o.type === "contourSet",
      );
      if (!set || set.type !== "contourSet") return null;
      const terrain = generateTerrainFromContours(set.contours, opts);
      if (terrain.indices.length === 0) return null; // kein sinnvolles TIN
      addToContext([{ ...terrain, sourceId: set.id }]);
      return terrain.id;
    },

    regenerateTerrain: (terrainId, smooth) => {
      const ctx = get().project.context ?? [];
      const terrain = ctx.find((o) => o.id === terrainId && o.type === "terrainMesh");
      if (!terrain || terrain.type !== "terrainMesh") return false;
      const sets = ctx.filter((o) => o.type === "contourSet");
      const set = sets.find((o) => o.id === terrain.sourceId) ?? sets[0];
      if (!set || set.type !== "contourSet") return false;
      const fresh = generateTerrainFromContours(set.contours, { smooth });
      if (fresh.indices.length === 0) return false;
      get().applyChange((p) =>
        patchItem(p, "context", terrainId, (o) => ({ ...o, positions: fresh.positions, indices: fresh.indices, smooth, sourceId: set.id }) as ContextObject),
      );
      return true;
    },

    resmoothTerrain: (terrainId, passes) => {
      const terrain = (get().project.context ?? []).find((o) => o.id === terrainId && o.type === "terrainMesh");
      if (!terrain || terrain.type !== "terrainMesh" || !(passes > 0)) return false;
      const positions = resmoothGridTerrain(terrain.positions, passes);
      if (!positions) return false;
      const smooth = (terrain.smooth ?? 0) + passes;
      get().applyChange((p) => patchItem(p, "context", terrainId, (o) => ({ ...o, positions, smooth }) as ContextObject));
      return true;
    },

    clearContext: () => get().applyChange((p) => fieldOps(p, "context", [])),
  };
}

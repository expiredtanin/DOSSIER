// Site-/Kontext-Slice: verwaltet die Kontext-Schicht `project.context`
// (importierte Meshes, Konturen-Sätze, abgeleitetes Gelände-TIN). Diese
// Geometrie ist „dumm"/nicht-semantisch — sie liegt bewusst NEBEN dem BIM-Modell.
//
// Entwurfsentscheidung: `context` ist Teil von `project` (ein einziger
// Wahrheits-Baum, konsistent mit projectSlice). Diese Slice MUTIERT daher
// `project.context` über die vorhandene `applyChange`-Aktion (Ops, Cross-Slice),
// genau wie projectSlice. So bleiben Persistenz/Undo einheitlich am Project hängen.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { generateTerrainFromContours, type TerrainOptions } from "../model/terrain";
import type { ContextObject, Project } from "../model/types";
import { addItems, fieldOps, patchItem, removeItems } from "../core/opsBuild";
import type { CoreOp } from "../core/ops";
import { ensureContextCategories } from "../model/contextCategories";
import type { StoreApi } from "./store";

/** Felder/Actions, die diese Slice in den RootState beisteuert. */
export interface SiteSlice {
  /** Fügt ein Kontext-Objekt (Mesh/Konturen/Gelände) hinzu (immutabel). */
  addContextObject: (obj: ContextObject) => void;
  /** Fügt mehrere Kontext-Objekte in einem Schritt hinzu (z. B. DXF-Import). */
  addContextObjects: (objs: ContextObject[]) => void;
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
  /** [T6]/[68] Ändert Felder eines Kontext-Objekts (Gelände, Baugrube) in einem Schritt; `coalesceKey` für Tippen. */
  patchContextObject: (id: string, patch: Record<string, unknown>, coalesceKey?: string) => void;
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
  applyChange: (ops: readonly CoreOp[] | ((p: Project) => readonly CoreOp[]), coalesceKey?: string) => void;
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
  const addToContext = (added: ContextObject[]): void => {
    if (added.length === 0) return;
    const codes = added
      .map((o) => o.categoryCode)
      .filter((c): c is string => !!c);
    get().applyChange((p) => [
      ...addItems("context", added),
      ...fieldOps(p, "layers", ensureContextCategories(p.layers, codes)),
    ]);
  };

  return {
    addContextObject: (obj) => addToContext([obj]),

    addContextObjects: (objs) => addToContext(objs),

    removeContextObject: (id) => get().applyChange((p) => removeItems(p, "context", [id])),

    removeContextObjects: (ids) => {
      if (ids.length === 0) return;
      get().applyChange((p) => removeItems(p, "context", ids));
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
      addToContext([terrain]);
      return terrain.id;
    },

    clearContext: () => get().applyChange((p) => fieldOps(p, "context", [])),
  };
}

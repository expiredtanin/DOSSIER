// Site-/Kontext-Slice: verwaltet die Kontext-Schicht `project.context`
// (importierte Meshes, Konturen-Sätze, abgeleitetes Gelände-TIN). Diese
// Geometrie ist „dumm"/nicht-semantisch — sie liegt bewusst NEBEN dem BIM-Modell.
//
// Entwurfsentscheidung: `context` ist Teil von `project` (ein einziger
// Wahrheits-Baum, konsistent mit projectSlice). Diese Slice MUTIERT daher
// `project.context` IMMUTABEL über die vorhandene `setProject`-Aktion
// (Cross-Slice), genau wie projectSlice ein neues Project-Objekt liefert. So
// bleiben Persistenz/Undo später einheitlich am Project hängen.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { generateTerrainFromContours } from "../model/terrain";
import type { ContextObject, Project } from "../model/types";
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
  generateTerrain: (contourSetId: string) => string | null;
  /** Leert die gesamte Kontext-Schicht. */
  clearContext: () => void;
}

/**
 * Cross-Slice-Abhängigkeit: diese Slice liest `project` und schreibt es über
 * `setProject` (beide aus projectSlice). Der Store komponiert SiteSlice mit
 * dieser Sicht, sodass `get()`/Actions typsicher auf das Projekt zugreifen.
 */
type SiteSliceDeps = {
  project: Project;
  setProject: (next: Project | ((p: Project) => Project)) => void;
};

export function createSiteSlice(
  api: StoreApi<SiteSlice & SiteSliceDeps>,
): SiteSlice {
  const { get } = api;

  // Immutabler Kontext-Updater: ersetzt `project.context` über die vorhandene
  // setProject-Aktion (konsistent mit projectSlice-Stil).
  const setContext = (
    update: (ctx: ContextObject[]) => ContextObject[],
  ): void => {
    get().setProject((p) => ({ ...p, context: update(p.context ?? []) }));
  };

  return {
    addContextObject: (obj) => setContext((ctx) => [...ctx, obj]),

    addContextObjects: (objs) =>
      setContext((ctx) => (objs.length ? [...ctx, ...objs] : ctx)),

    removeContextObject: (id) =>
      setContext((ctx) => ctx.filter((o) => o.id !== id)),

    removeContextObjects: (ids) => {
      if (ids.length === 0) return;
      const drop = new Set(ids);
      setContext((ctx) => ctx.filter((o) => !drop.has(o.id)));
    },

    generateTerrain: (contourSetId) => {
      const ctx = get().project.context ?? [];
      const set = ctx.find(
        (o) => o.id === contourSetId && o.type === "contourSet",
      );
      if (!set || set.type !== "contourSet") return null;
      const terrain = generateTerrainFromContours(set.contours);
      if (terrain.indices.length === 0) return null; // kein sinnvolles TIN
      setContext((c) => [...c, terrain]);
      return terrain.id;
    },

    clearContext: () => setContext(() => []),
  };
}

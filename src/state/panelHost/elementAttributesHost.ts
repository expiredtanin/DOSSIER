// Panel-Host, Teil Bauteil-Attribute der Objekt-Info ([121], aus `usePanelHostBase` herausgelöst):
// Wand, Decke, Öffnung, Dach, Schnitt-/Ansichtslinie, Treppe, Raum, Extrusion und Stütze. Jeder
// Handler wirkt nur bei passender Auswahl (`selection.kind`) und schreibt über die Projekt-Aktionen
// bzw. `applyChange`.

import { patchItems, removeRoofHole, setRoofEdge } from "../../core";
import type { EntityOf } from "../../core";
import { getState } from "../appStore";
import type { FlatHostOpts, HostPart } from "./types";

/** Auswahl-Arten mit Mehrfach-Setzen (Schlüssel in `Selection`). */
type MultiCollection = "walls" | "ceilings" | "roofs" | "openings" | "stairs" | "rooms" | "columns" | "solids";

/** Projekt-Liste zur Auswahl-Art (Körper heissen im Modell `extrudedSolids`). */
const PROJECT_LIST = {
  walls: "walls",
  ceilings: "ceilings",
  roofs: "roofs",
  openings: "openings",
  stairs: "stairs",
  rooms: "rooms",
  columns: "columns",
  solids: "extrudedSolids",
} as const;

/**
 * [195b] Ziele einer Änderung: bei Mehrfachauswahl gleicher Art alle gewählten Elemente (in einem Undo-Schritt
 * zu setzen), sonst nur das Objekt der Objekt-Info. Öffnungen: nur die GLEICHER Art (Fenster/Tür) wie `id` —
 * Typ, Flügel, Anschlag u. a. gelten nur dort.
 */
function targetIds(collection: MultiCollection, id: string): string[] {
  const ids = getState().selection[collection];
  if (!(ids.length > 1 && ids.includes(id))) return [id];
  if (collection !== "openings") return [...ids];
  const openings = getState().project.openings ?? [];
  const kind = openings.find((o) => o.id === id)?.kind;
  return ids.filter((x) => openings.find((o) => o.id === x)?.kind === kind);
}

/**
 * Dach-Felder, die je Dach eigen sind und bei Mehrfachauswahl nur das erste Dach treffen: Umriss samt Höfen/Bögen,
 * Kantenneigungen (Indizes) und Gauben. Alle anderen Felder (Typ, Neigung, Dicke, Traufhöhe, Überstände, Attika …)
 * gelten für alle gewählten Dächer.
 */
const ROOF_OWN_KEYS: ReadonlySet<string> = new Set(["outline", "holes", "outlineBulge", "holesBulge", "edgePitchDeg", "dormers"]);

export function buildElementAttributesHost(c: FlatHostOpts) {
  const { applyChange, onOpenStampEditor, onToggleSection3dCut, openResources, patchLevel, project, section3dCutId, sectionLine, selection, patchDoorType, patchWindowType, saveOpeningStyle, setCeilingThickness, setWallThickness, slideOpening, updateCeiling, updateOpening, updateRoof, updateRoom, updateStair, updateWall } = c;
  /** Wie {@link patchAll}, aber mit Änderungsfunktion je Element (z. B. Stützen-Profil). */
  function mapAll<K extends MultiCollection>(collection: K, id: string, fn: (e: EntityOf<(typeof PROJECT_LIST)[K]>) => EntityOf<(typeof PROJECT_LIST)[K]>, coalesceKey?: string): void {
    const ids = targetIds(collection, id);
    applyChange((p) => patchItems(p, PROJECT_LIST[collection], ids, fn), coalesceKey);
  }
  /** Patch auf alle Ziele (s. {@link targetIds}); ein Element: wie bisher über die Einzel-Aktion. */
  function patchAll<K extends MultiCollection>(collection: K, id: string, patch: Record<string, unknown>, coalesceKey?: string): void {
    const ids = targetIds(collection, id);
    if (ids.length > 1) mapAll(collection, id, (e) => ({ ...(e as object), ...patch }) as typeof e, coalesceKey);
    else if (collection === "walls") updateWall(id, patch, coalesceKey);
    else if (collection === "ceilings") updateCeiling(id, patch);
    else if (collection === "roofs") updateRoof(id, patch, coalesceKey);
    else if (collection === "openings") updateOpening(id, patch);
    else if (collection === "stairs") updateStair(id, patch);
    else if (collection === "rooms") updateRoom(id, patch);
    else mapAll(collection, id, (e) => ({ ...(e as object), ...patch }) as typeof e, coalesceKey);
  }
  return {
    // ── Wand-Attribute (nur bei selektierter Wand) ─────────────────────────
    onSetWallReferenceLine: (ref) => {
      if (selection?.kind === "wall")
        // Benannte Linie gewählt ⇒ freien Fugen-Versatz löschen (er übersteuert sonst).
        patchAll("walls", selection.id, { referenceLine: ref, referenceOffset: undefined });
    },
    onSetWallReferenceOffset: (offset) => {
      if (selection?.kind === "wall") patchAll("walls", selection.id, { referenceOffset: offset ?? undefined });
    },
    onSetSurfacePatternPlacement: (patch) => {
      if (selection?.kind === "wall") patchAll("walls", selection.id, patch, "surface-pattern");
      else if (selection?.kind === "roof") patchAll("roofs", selection.id, patch, "surface-pattern");
    },
    onSetWallSliceTermination: (termination) => {
      if (selection?.kind === "wall")
        // "both" ist der Default ⇒ als undefined speichern (Alt-Projekt-Parität).
        patchAll("walls", selection.id, { sliceTermination: termination === "both" ? undefined : termination });
    },
    onSetWallRoofAttach: (attach) => {
      if (selection?.kind === "wall")
        // "auto" ist der Default ⇒ als undefined speichern.
        patchAll("walls", selection.id, { roofAttach: attach === "auto" ? undefined : attach === "on" });
    },
    onSetBuildingFlags: (flags) => {
      const patch: { isExternal?: boolean; loadBearing?: boolean } = {};
      if (flags.isExternal !== undefined) patch.isExternal = flags.isExternal || undefined;
      if (flags.loadBearing !== undefined) patch.loadBearing = flags.loadBearing || undefined;
      if (selection?.kind === "wall") patchAll("walls", selection.id, patch);
      else if (selection?.kind === "ceiling") patchAll("ceilings", selection.id, patch);
    },
    onSetCeilingEdgeAtOutline: (edgeAtOutline) => {
      if (selection?.kind === "ceiling") patchAll("ceilings", selection.id, { edgeAtOutline: edgeAtOutline || undefined });
    },
    onSetWallType: (wallTypeId) => {
      // [195b] Mehrfachauswahl: alle gewählten Wände bekommen den Typ (ein Undo-Schritt).
      if (selection?.kind === "wall") patchAll("walls", selection.id, { wallTypeId });
    },
    onSetWallThickness: (thickness) => {
      if (selection?.kind !== "wall") return;
      const ids = targetIds("walls", selection.id);
      if (ids.length === 1) setWallThickness(selection.id, thickness);
      else getState().groupChanges(() => ids.forEach((id) => setWallThickness(id, thickness)));
    },
    onSetWallBottom: (anchor) => {
      if (selection?.kind === "wall") patchAll("walls", selection.id, { bottom: anchor ?? undefined });
    },
    onSetWallTop: (anchor) => {
      if (selection?.kind === "wall") patchAll("walls", selection.id, { top: anchor ?? undefined });
    },
    // ── Decken-Attribute (nur bei selektierter Decke) ──────────────────────
    onSetCeilingType: (ceilingTypeId) => {
      if (selection?.kind === "ceiling") patchAll("ceilings", selection.id, { ceilingTypeId, thickness: undefined });
    },
    onSetCeilingThickness: (thickness) => {
      if (selection?.kind !== "ceiling") return;
      const ids = targetIds("ceilings", selection.id);
      if (ids.length === 1) setCeilingThickness(selection.id, thickness);
      else getState().groupChanges(() => ids.forEach((id) => setCeilingThickness(id, thickness)));
    },
    onRemoveCeilingOpening: (index) => {
      if (selection?.kind !== "ceiling") return;
      const c = (project.ceilings ?? []).find((x) => x.id === selection.id);
      if (!c?.openings || index < 0 || index >= c.openings.length) return;
      updateCeiling(selection.id, {
        openings: c.openings.filter((_, i) => i !== index),
      });
    },
    onSetCeilingTop: (anchor) => {
      if (selection?.kind === "ceiling") patchAll("ceilings", selection.id, { top: anchor ?? undefined });
    },
    onSetCeilingBottom: (anchor) => {
      if (selection?.kind === "ceiling") patchAll("ceilings", selection.id, { bottom: anchor ?? undefined });
    },
    // ── Öffnungs-Attribute (nur bei selektierter Öffnung) ──────────────────
    onSetOpeningKind: (kind) => {
      if (selection?.kind === "opening")
        updateOpening(
          selection.id,
          kind === "door"
            ? { kind, sillHeight: 0, hinge: "start", swing: "left", openingDir: "in", swingAngle: 90 }
            : { kind },
        );
    },
    onSetOpeningWidth: (width) => {
      if (selection?.kind === "opening" && width > 0) patchAll("openings", selection.id, { width });
    },
    onSetOpeningHeight: (height) => {
      if (selection?.kind === "opening" && height > 0) patchAll("openings", selection.id, { height });
    },
    onSetOpeningSill: (sillHeight) => {
      if (selection?.kind === "opening" && sillHeight >= 0) patchAll("openings", selection.id, { sillHeight });
    },
    onSetOpeningPosition: (position) => {
      if (selection?.kind !== "opening" || !Number.isFinite(position)) return;
      // [144] Dach-/Deckenöffnung: Feld frei; Wandöffnung: der Kern klemmt auf [0, Wandlänge − Breite]
      // (Bogenwand: Bogenlänge) und hält 5 cm vor der Nachbaröffnung an (mit Hinweis).
      if (selection.opening?.wallLength == null) updateOpening(selection.id, { position: Math.max(0, position) });
      else slideOpening(selection.id, { position });
    },
    onSetOpeningSwingAngle: (swingAngle) => {
      if (selection?.kind === "opening" && swingAngle > 0)
        patchAll("openings", selection.id, { swingAngle });
    },
    onSetOpeningHinge: (hinge) => {
      if (selection?.kind === "opening") patchAll("openings", selection.id, { hinge });
    },
    onSetOpeningSwing: (swing) => {
      if (selection?.kind === "opening") patchAll("openings", selection.id, { swing });
    },
    onSetOpeningDir: (openingDir) => {
      if (selection?.kind === "opening") patchAll("openings", selection.id, { openingDir });
    },
    onSetOpeningWingCount: (wingCount) => {
      if (selection?.kind === "opening")
        patchAll("openings", selection.id, { wingCount: Math.max(1, Math.min(4, Math.round(wingCount))) });
    },
    onSetOpeningDoorType: (doorType) => {
      if (selection?.kind === "opening") patchAll("openings", selection.id, { doorType });
    },
    onSetOpeningLintelLines: (lintelLines) => {
      if (selection?.kind === "opening") patchAll("openings", selection.id, { lintelLines });
    },
    onSetOpeningDisplay: (patch) => {
      if (selection?.kind === "opening") patchAll("openings", selection.id, patch);
    },
    // Lage eines Dach-/Deckenfensters ist elementspezifisch (Punkt/Winkel in der Wirtsfläche) ⇒ bewusst nur das erste Element.
    onSetOpeningHost: (patch) => {
      if (selection?.kind === "opening") updateOpening(selection.id, patch);
    },
    onSetOpeningDetailLevel: (detailLevel) => {
      if (selection?.kind === "opening") patchAll("openings", selection.id, { detailLevel });
    },
    onSetOpeningFrameLine: (v) => {
      if (selection?.kind === "opening") patchAll("openings", selection.id, { frameLine: v });
    },
    onSetOpeningFrameViewLine: (v) => {
      if (selection?.kind === "opening") patchAll("openings", selection.id, { frameViewLine: v });
    },
    onSetOpeningSashLine: (v) => {
      if (selection?.kind === "opening") patchAll("openings", selection.id, { sashLine: v });
    },
    onSetOpeningSillLineStyle: (v) => {
      if (selection?.kind === "opening") patchAll("openings", selection.id, { sillLineStyle: v });
    },
    // Typ-Zuweisung (Bibliothek): Tür-/Fenstertyp per typeId; leerer String löst
    // die Zuweisung wieder (Inline-Verhalten).
    onSetOpeningType: (typeId) => {
      if (selection?.kind === "opening") patchAll("openings", selection.id, { typeId: typeId || undefined });
    },
    // Öffnungs-Editor (Fenster-/Türeditor): Instanz-Felder gelten für alle gewählten Öffnungen gleicher Art; die Position
    // ist je Öffnung verschieden (Kern klemmt an der Wand) ⇒ nur das erste Element.
    onPatchOpening: (patch) => {
      if (selection?.kind !== "opening") return;
      if ("position" in patch) updateOpening(selection.id, patch);
      else patchAll("openings", selection.id, patch);
    },
    onEditOpeningType: (kind) => {
      openResources(kind === "door" ? "doorStyles" : "windowStyles");
    },
    onPatchWindowType: patchWindowType,
    onPatchDoorType: patchDoorType,
    onSaveOpeningStyle: saveOpeningStyle,
    // ── Dach-Attribute (nur bei selektiertem Dach) ─────────────────────────
    onSetRoofPatch: (patch, coalesceKey) => {
      if (selection?.kind !== "roof") return;
      const multi = !Object.keys(patch).some((k) => ROOF_OWN_KEYS.has(k));
      if (multi) patchAll("roofs", selection.id, patch, coalesceKey);
      else updateRoof(selection.id, patch, coalesceKey);
    },
    // Kanten (Index in den Umriss), Höfe und Gauben gehören zu GENAU EINEM Dach (Indizes/Ids sind dachspezifisch,
    // andere Dächer haben andere Umrisse): bewusst nur das erste Element; die Abschnitte erscheinen deshalb bei
    // Mehrfachauswahl nicht (`RoofSections`, `useMulti`).
    onSetRoofEdge: (index, spec) => {
      if (selection?.kind !== "roof") return;
      const r = (project.roofs ?? []).find((x) => x.id === selection.id);
      if (!r) return;
      // Zahl tippen: gleicher Schlüssel je Kante ⇒ ein Undo-Schritt; Giebel-Schalter einzeln.
      updateRoof(selection.id, setRoofEdge(r, index, spec), spec.kind === "pitch" ? `roof-edge-${selection.id}-${index}` : undefined);
    },
    onRemoveRoofHole: (k) => {
      if (selection?.kind !== "roof") return;
      const r = (project.roofs ?? []).find((x) => x.id === selection.id);
      if (r) updateRoof(selection.id, removeRoofHole(r, k));
    },
    // ── Schnitt-/Ansichtslinie (nur bei selektierter Linie) ────────────────
    sectionLine,
    onSetSectionLinePatch: (patch) => {
      if (sectionLine) patchLevel(sectionLine.id, patch);
    },
    onDeleteSectionLine: () => {
      if (sectionLine) patchLevel(sectionLine.id, { linePoints: undefined });
    },
    // 3D-Live-Schnitt an die gewählte Schnittlinie binden (Toggle im Objekt-Info).
    section3dCutActive: section3dCutId != null && section3dCutId === sectionLine?.id,
    onToggleSection3dCut,
    // ── Treppen-Attribute (nur bei selektierter Treppe) ────────────────────
    onSetStairShape: (shape) => {
      if (selection?.kind === "stair") patchAll("stairs", selection.id, { shape });
    },
    onSetStairWidth: (width) => {
      if (selection?.kind === "stair" && width > 0)
        patchAll("stairs", selection.id, { width });
    },
    onSetStairSteps: (stepCount) => {
      if (selection?.kind === "stair" && stepCount >= 2)
        patchAll("stairs", selection.id, { stepCount: Math.round(stepCount) });
    },
    onSetStairRise: (totalRise) => {
      if (selection?.kind === "stair" && totalRise > 0)
        patchAll("stairs", selection.id, { totalRise });
    },
    onSetStairBaseOffset: (baseOffset) => {
      if (selection?.kind === "stair" && Number.isFinite(baseOffset)) patchAll("stairs", selection.id, { baseOffset });
    },
    onSetStairUp: (up) => {
      if (selection?.kind === "stair") patchAll("stairs", selection.id, { up });
    },
    onSetStairArrowStyle: (arrowStyle) => {
      if (selection?.kind === "stair") patchAll("stairs", selection.id, { arrowStyle });
    },
    onSetStairColumn: (radius) => {
      if (selection?.kind === "stair")
        patchAll("stairs", selection.id, { centerColumn: radius > 0 ? radius : undefined });
    },
    onSetStairReferenz: (referenz) => {
      if (selection?.kind === "stair") patchAll("stairs", selection.id, { referenz });
    },
    onSetStairPatch: (patch) => {
      if (selection?.kind === "stair") patchAll("stairs", selection.id, patch);
    },
    // Typ-Zuweisung (Bibliothek): Treppentyp per typeId; leerer String löst die
    // Zuweisung (Inline-Verhalten). Treibt u. a. die 3D-Tragart (massiv/offen).
    onSetStairType: (typeId) => {
      if (selection?.kind === "stair")
        patchAll("stairs", selection.id, { typeId: typeId || undefined });
    },
    // ── Raum-Attribute (nur bei selektiertem Raum) ─────────────────────────
    onSetRoomName: (name) => {
      // Raumnamen sind je Raum verschieden ⇒ bewusst nur das erste Element (das Feld ist bei Mehrfachauswahl gesperrt).
      if (selection?.kind === "room") updateRoom(selection.id, { name });
    },
    onSetRoomSia: (category) => {
      if (selection?.kind === "room") patchAll("rooms", selection.id, { siaCategory: category });
    },
    onEditRoomStamp: (roomId) => onOpenStampEditor(roomId),
    // ── Extrusions-Attribute (truck-Integration; nur bei selektiertem Körper) ──
    onSetExtrudedSolidHeight: (height) => {
      if (selection?.kind !== "extrudedSolid" || !(height > 0)) return;
      patchAll("solids", selection.id, { height });
    },
    onSetExtrudedSolidTaper: (taper) => {
      if (selection?.kind !== "extrudedSolid") return;
      const clamped = Math.min(1, Math.max(0, taper));
      patchAll("solids", selection.id, { taper: clamped });
    },
    onSetExtrudedSolidCornerRadius: (radius) => {
      if (selection?.kind !== "extrudedSolid") return;
      const r = Math.max(0, radius);
      patchAll("solids", selection.id, { cornerRadius: r > 0 ? r : undefined });
    },
    onSetExtrudedSolidChamfer: (chamfer) => {
      if (selection?.kind !== "extrudedSolid") return;
      const c = Math.max(0, chamfer);
      patchAll("solids", selection.id, { chamfer: c > 0 ? c : undefined });
    },
    onSetExtrudedSolidSubtract: (subtract) => {
      if (selection?.kind !== "extrudedSolid") return;
      patchAll("solids", selection.id, { operation: subtract ? ("subtract" as const) : undefined });
    },
    onSetExtrudedSolidBaseOffset: (offset) => {
      if (selection?.kind !== "extrudedSolid" || !Number.isFinite(offset)) return;
      patchAll("solids", selection.id, { baseOffset: Math.abs(offset) > 1e-9 ? offset : undefined });
    },
    onSetExtrudedSolidComponent: (componentId) => {
      if (selection?.kind !== "extrudedSolid") return;
      patchAll("solids", selection.id, { componentId: componentId || undefined });
    },
    // ── Stützen-Attribute (Tragwerk; nur bei selektierter Stütze) ──────────
    onSetColumnProfileKind: (kind) => {
      if (selection?.kind !== "column") return;
      mapAll("columns", selection.id, (c) => {
        if (kind === c.profile.kind) return c;
        // Profil-Typ wechseln: sinnvolles Mass aus dem bisherigen ableiten.
        if (kind === "round") {
          const r =
            c.profile.kind === "rect"
              ? Math.max(c.profile.width, c.profile.depth) / 2
              : c.profile.radius;
          return { ...c, profile: { kind: "round" as const, radius: r } };
        }
        const side = c.profile.kind === "round" ? c.profile.radius * 2 : 0.3;
        return { ...c, profile: { kind: "rect" as const, width: side, depth: side } };
      });
    },
    onSetColumnWidth: (width) => {
      if (selection?.kind !== "column" || !(width > 0)) return;
      mapAll("columns", selection.id, (c) =>
        c.profile.kind === "rect" ? { ...c, profile: { ...c.profile, width } } : c,
      );
    },
    onSetColumnDepth: (depth) => {
      if (selection?.kind !== "column" || !(depth > 0)) return;
      mapAll("columns", selection.id, (c) =>
        c.profile.kind === "rect" ? { ...c, profile: { ...c.profile, depth } } : c,
      );
    },
    onSetColumnRadius: (radius) => {
      if (selection?.kind !== "column" || !(radius > 0)) return;
      mapAll("columns", selection.id, (c) =>
        c.profile.kind === "round" ? { ...c, profile: { ...c.profile, radius } } : c,
      );
    },
    onSetColumnHeight: (height) => {
      if (selection?.kind !== "column" || !(height > 0)) return;
      patchAll("columns", selection.id, { height });
    },
    onSetColumnRotation: (deg) => {
      if (selection?.kind !== "column" || !Number.isFinite(deg)) return;
      patchAll("columns", selection.id, { rotation: (deg * Math.PI) / 180 });
    },
  } satisfies HostPart;
}

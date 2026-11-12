// Panel-Host, Teil Bauteil-Attribute der Objekt-Info ([121], aus `usePanelHostBase` herausgelöst):
// Wand, Decke, Öffnung, Dach, Schnitt-/Ansichtslinie, Treppe, Raum, Extrusion und Stütze. Jeder
// Handler wirkt nur bei passender Auswahl (`selection.kind`) und schreibt über die Projekt-Aktionen
// bzw. `applyChange`.

import { patchItem, patchItems, removeRoofHole, setRoofEdge } from "../../core";
import { getState } from "../appStore";
import type { FlatHostOpts, HostPart } from "./types";

export function buildElementAttributesHost(c: FlatHostOpts) {
  const { applyChange, onOpenStampEditor, onToggleSection3dCut, openResources, patchLevel, project, section3dCutId, sectionLine, selection, setCeilingThickness, setOpeningEditorId, setWallThickness, slideOpening, updateCeiling, updateOpening, updateRoof, updateRoom, updateStair, updateWall } = c;
  return {
    // ── Wand-Attribute (nur bei selektierter Wand) ─────────────────────────
    onSetWallReferenceLine: (ref) => {
      if (selection?.kind === "wall")
        // Benannte Linie gewählt ⇒ freien Fugen-Versatz löschen (er übersteuert sonst).
        updateWall(selection.id, { referenceLine: ref, referenceOffset: undefined });
    },
    onSetWallReferenceOffset: (offset) => {
      if (selection?.kind === "wall")
        updateWall(selection.id, { referenceOffset: offset ?? undefined });
    },
    onSetSurfacePatternPlacement: (patch) => {
      if (selection?.kind === "wall") updateWall(selection.id, patch, "surface-pattern");
      else if (selection?.kind === "roof") updateRoof(selection.id, patch, "surface-pattern");
    },
    onSetWallSliceTermination: (termination) => {
      if (selection?.kind === "wall")
        // "both" ist der Default ⇒ als undefined speichern (Alt-Projekt-Parität).
        updateWall(selection.id, {
          sliceTermination: termination === "both" ? undefined : termination,
        });
    },
    onSetWallRoofAttach: (attach) => {
      if (selection?.kind === "wall")
        // "auto" ist der Default ⇒ als undefined speichern.
        updateWall(selection.id, { roofAttach: attach === "auto" ? undefined : attach === "on" });
    },
    onSetBuildingFlags: (flags) => {
      const patch: { isExternal?: boolean; loadBearing?: boolean } = {};
      if (flags.isExternal !== undefined) patch.isExternal = flags.isExternal || undefined;
      if (flags.loadBearing !== undefined) patch.loadBearing = flags.loadBearing || undefined;
      if (selection?.kind === "wall") updateWall(selection.id, patch);
      else if (selection?.kind === "ceiling") updateCeiling(selection.id, patch);
    },
    onSetCeilingEdgeAtOutline: (edgeAtOutline) => {
      if (selection?.kind === "ceiling") updateCeiling(selection.id, { edgeAtOutline: edgeAtOutline || undefined });
    },
    onSetWallType: (wallTypeId) => {
      if (selection?.kind !== "wall") return;
      // [195b] Mehrfachauswahl: alle gewählten Wände bekommen den Typ (ein Undo-Schritt).
      const ids = getState().selection.walls;
      if (ids.length > 1) applyChange((p) => patchItems(p, "walls", ids, (w) => ({ ...w, wallTypeId })));
      else updateWall(selection.id, { wallTypeId });
    },
    onSetWallThickness: (thickness) => {
      if (selection?.kind === "wall")
        setWallThickness(selection.id, thickness);
    },
    onSetWallBottom: (anchor) => {
      if (selection?.kind === "wall")
        updateWall(selection.id, { bottom: anchor ?? undefined });
    },
    onSetWallTop: (anchor) => {
      if (selection?.kind === "wall")
        updateWall(selection.id, { top: anchor ?? undefined });
    },
    // ── Decken-Attribute (nur bei selektierter Decke) ──────────────────────
    onSetCeilingType: (ceilingTypeId) => {
      if (selection?.kind === "ceiling")
        updateCeiling(selection.id, { ceilingTypeId, thickness: undefined });
    },
    onSetCeilingThickness: (thickness) => {
      if (selection?.kind === "ceiling")
        setCeilingThickness(selection.id, thickness);
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
      if (selection?.kind === "ceiling")
        updateCeiling(selection.id, { top: anchor ?? undefined });
    },
    onSetCeilingBottom: (anchor) => {
      if (selection?.kind === "ceiling")
        updateCeiling(selection.id, { bottom: anchor ?? undefined });
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
      if (selection?.kind === "opening" && width > 0)
        updateOpening(selection.id, { width });
    },
    onSetOpeningHeight: (height) => {
      if (selection?.kind === "opening" && height > 0)
        updateOpening(selection.id, { height });
    },
    onSetOpeningSill: (sillHeight) => {
      if (selection?.kind === "opening" && sillHeight >= 0)
        updateOpening(selection.id, { sillHeight });
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
        updateOpening(selection.id, { swingAngle });
    },
    onSetOpeningHinge: (hinge) => {
      if (selection?.kind === "opening") updateOpening(selection.id, { hinge });
    },
    onSetOpeningSwing: (swing) => {
      if (selection?.kind === "opening") updateOpening(selection.id, { swing });
    },
    onSetOpeningDir: (openingDir) => {
      if (selection?.kind === "opening") updateOpening(selection.id, { openingDir });
    },
    onSetOpeningWingCount: (wingCount) => {
      if (selection?.kind === "opening")
        updateOpening(selection.id, { wingCount: Math.max(1, Math.min(4, Math.round(wingCount))) });
    },
    onSetOpeningDoorType: (doorType) => {
      if (selection?.kind === "opening") updateOpening(selection.id, { doorType });
    },
    onSetOpeningLintelLines: (lintelLines) => {
      if (selection?.kind === "opening") updateOpening(selection.id, { lintelLines });
    },
    onSetOpeningDisplay: (patch) => {
      if (selection?.kind === "opening") updateOpening(selection.id, patch);
    },
    onSetOpeningHost: (patch) => {
      if (selection?.kind === "opening") updateOpening(selection.id, patch);
    },
    onSetOpeningDetailLevel: (detailLevel) => {
      if (selection?.kind === "opening") updateOpening(selection.id, { detailLevel });
    },
    onSetOpeningFrameLine: (v) => {
      if (selection?.kind === "opening") updateOpening(selection.id, { frameLine: v });
    },
    onSetOpeningFrameViewLine: (v) => {
      if (selection?.kind === "opening") updateOpening(selection.id, { frameViewLine: v });
    },
    onSetOpeningSashLine: (v) => {
      if (selection?.kind === "opening") updateOpening(selection.id, { sashLine: v });
    },
    onSetOpeningSillLineStyle: (v) => {
      if (selection?.kind === "opening") updateOpening(selection.id, { sillLineStyle: v });
    },
    // Typ-Zuweisung (Bibliothek): Tür-/Fenstertyp per typeId; leerer String löst
    // die Zuweisung wieder (Inline-Verhalten).
    onSetOpeningType: (typeId) => {
      if (selection?.kind === "opening")
        updateOpening(selection.id, { typeId: typeId || undefined });
    },
    onEditOpeningType: (kind) => {
      openResources(kind === "door" ? "doorStyles" : "windowStyles");
    },
    onOpenOpeningEditor: (id) => setOpeningEditorId(id),
    // ── Dach-Attribute (nur bei selektiertem Dach) ─────────────────────────
    onSetRoofPatch: (patch, coalesceKey) => {
      if (selection?.kind === "roof") updateRoof(selection.id, patch, coalesceKey);
    },
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
      if (selection?.kind === "stair") updateStair(selection.id, { shape });
    },
    onSetStairWidth: (width) => {
      if (selection?.kind === "stair" && width > 0)
        updateStair(selection.id, { width });
    },
    onSetStairSteps: (stepCount) => {
      if (selection?.kind === "stair" && stepCount >= 2)
        updateStair(selection.id, { stepCount: Math.round(stepCount) });
    },
    onSetStairRise: (totalRise) => {
      if (selection?.kind === "stair" && totalRise > 0)
        updateStair(selection.id, { totalRise });
    },
    onSetStairBaseOffset: (baseOffset) => {
      if (selection?.kind === "stair" && Number.isFinite(baseOffset)) updateStair(selection.id, { baseOffset });
    },
    onSetStairUp: (up) => {
      if (selection?.kind === "stair") updateStair(selection.id, { up });
    },
    onSetStairArrowStyle: (arrowStyle) => {
      if (selection?.kind === "stair") updateStair(selection.id, { arrowStyle });
    },
    onSetStairColumn: (radius) => {
      if (selection?.kind === "stair")
        updateStair(selection.id, { centerColumn: radius > 0 ? radius : undefined });
    },
    onSetStairReferenz: (referenz) => {
      if (selection?.kind === "stair") updateStair(selection.id, { referenz });
    },
    onSetStairPatch: (patch) => {
      if (selection?.kind === "stair") updateStair(selection.id, patch);
    },
    // Typ-Zuweisung (Bibliothek): Treppentyp per typeId; leerer String löst die
    // Zuweisung (Inline-Verhalten). Treibt u. a. die 3D-Tragart (massiv/offen).
    onSetStairType: (typeId) => {
      if (selection?.kind === "stair")
        updateStair(selection.id, { typeId: typeId || undefined });
    },
    // ── Raum-Attribute (nur bei selektiertem Raum) ─────────────────────────
    onSetRoomName: (name) => {
      if (selection?.kind === "room") updateRoom(selection.id, { name });
    },
    onSetRoomSia: (category) => {
      if (selection?.kind === "room") updateRoom(selection.id, { siaCategory: category });
    },
    onEditRoomStamp: (roomId) => onOpenStampEditor(roomId),
    // ── Extrusions-Attribute (truck-Integration; nur bei selektiertem Körper) ──
    onSetExtrudedSolidHeight: (height) => {
      if (selection?.kind !== "extrudedSolid" || !(height > 0)) return;
      const id = selection.id;
      applyChange((p) => patchItem(p, "extrudedSolids", id, { height }));
    },
    onSetExtrudedSolidTaper: (taper) => {
      if (selection?.kind !== "extrudedSolid") return;
      const clamped = Math.min(1, Math.max(0, taper));
      const id = selection.id;
      applyChange((p) => patchItem(p, "extrudedSolids", id, { taper: clamped }));
    },
    onSetExtrudedSolidCornerRadius: (radius) => {
      if (selection?.kind !== "extrudedSolid") return;
      const r = Math.max(0, radius);
      const id = selection.id;
      applyChange((p) => patchItem(p, "extrudedSolids", id, { cornerRadius: r > 0 ? r : undefined }));
    },
    onSetExtrudedSolidChamfer: (chamfer) => {
      if (selection?.kind !== "extrudedSolid") return;
      const c = Math.max(0, chamfer);
      const id = selection.id;
      applyChange((p) => patchItem(p, "extrudedSolids", id, { chamfer: c > 0 ? c : undefined }));
    },
    onSetExtrudedSolidSubtract: (subtract) => {
      if (selection?.kind !== "extrudedSolid") return;
      const id = selection.id;
      applyChange((p) => patchItem(p, "extrudedSolids", id, { operation: subtract ? ("subtract" as const) : undefined }));
    },
    onSetExtrudedSolidBaseOffset: (offset) => {
      if (selection?.kind !== "extrudedSolid" || !Number.isFinite(offset)) return;
      const id = selection.id;
      applyChange((p) => patchItem(p, "extrudedSolids", id, { baseOffset: Math.abs(offset) > 1e-9 ? offset : undefined }));
    },
    onSetExtrudedSolidComponent: (componentId) => {
      if (selection?.kind !== "extrudedSolid") return;
      const id = selection.id;
      applyChange((p) => patchItem(p, "extrudedSolids", id, { componentId: componentId || undefined }));
    },
    // ── Stützen-Attribute (Tragwerk; nur bei selektierter Stütze) ──────────
    onSetColumnProfileKind: (kind) => {
      if (selection?.kind !== "column") return;
      const id = selection.id;
      applyChange((p) =>
        patchItem(p, "columns", id, (c) => {
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
        }),
      );
    },
    onSetColumnWidth: (width) => {
      if (selection?.kind !== "column" || !(width > 0)) return;
      const id = selection.id;
      applyChange((p) =>
        patchItem(p, "columns", id, (c) =>
          c.profile.kind === "rect" ? { ...c, profile: { ...c.profile, width } } : c,
        ),
      );
    },
    onSetColumnDepth: (depth) => {
      if (selection?.kind !== "column" || !(depth > 0)) return;
      const id = selection.id;
      applyChange((p) =>
        patchItem(p, "columns", id, (c) =>
          c.profile.kind === "rect" ? { ...c, profile: { ...c.profile, depth } } : c,
        ),
      );
    },
    onSetColumnRadius: (radius) => {
      if (selection?.kind !== "column" || !(radius > 0)) return;
      const id = selection.id;
      applyChange((p) =>
        patchItem(p, "columns", id, (c) =>
          c.profile.kind === "round" ? { ...c, profile: { ...c.profile, radius } } : c,
        ),
      );
    },
    onSetColumnHeight: (height) => {
      if (selection?.kind !== "column" || !(height > 0)) return;
      const id = selection.id;
      applyChange((p) => patchItem(p, "columns", id, { height }));
    },
    onSetColumnRotation: (deg) => {
      if (selection?.kind !== "column" || !Number.isFinite(deg)) return;
      const id = selection.id;
      const rotation = (deg * Math.PI) / 180;
      applyChange((p) => patchItem(p, "columns", id, { rotation }));
    },
  } satisfies HostPart;
}

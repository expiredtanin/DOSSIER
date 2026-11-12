// Test-Naht für die UI-Suite (`e2e/`), nur mit `?dossierTest` in der URL geladen (main.tsx): Dinge, die
// sich über die Oberfläche nicht auslösen lassen. Hier: ein absichtlicher Kern-Panic ([118],
// `__debug_panic` in `src-tauri/core/src/web/document.rs`), um den Wiederanlauf in echtem Chromium zu prüfen.

import { core, coreEpoch, coreReady } from "../engine/coreWasm";
import { getState } from "./appStore";
import { runSelectionAction, type SelectionActionId } from "./selectionActions";
import { storeDocument } from "./historySlice";
import { ceilingThickness } from "../model/types";
import { computeSection, generatePlan, generateVisibleLevelsPlan, materializeGreyed, materializeUnderlay, verticalExtents, generateSectionPlan, pickGeometry, projectToModel3d } from "../core";
import { collectVisibleCodes } from "../model/layers";
import { getViewStateBridge } from "./viewTabs";
import { getView3dFilter, toFilter3d } from "./view3dFilter";
import { BUILTIN_PANEL_IDS } from "../panels/builtinPanels";
import { hiddenFloorIds, itemDisplay } from "../panels/displayMode";

declare global {
  interface Window {
    __dossierTest?: {
      /** Panic im Kern mitten im Zugriff auf das Store-Dokument; Ergebnis: Name des geworfenen Fehlers. */
      corePanic: () => string;
      /** Erfüllt, wenn der Kern wieder läuft. */
      coreReady: () => Promise<void>;
      coreEpoch: () => number;
      /** Zahl der Elemente je Liste des Projekts (Wände, Öffnungen, Zeichnungsebenen) und das Projekt im Kern als JSON-Länge. */
      counts: () => { walls: number; openings: number; drawingLevels: number; coreJson: number };
      /** Endpunkte aller 2D-Linien des Projekts ([123] Transformations-Test). */
      lines: () => { a: { x: number; y: number }; b: { x: number; y: number } }[];
      /** [137] Polylinien-Punkte der 2D-Elemente mit Id-Präfix (Präsentations-Massstabsbalken). */
      polylines: (prefix: string) => { id: string; pts: { x: number; y: number }[] }[];
      /** [137] Gewählte 2D-Elemente und Gruppen. */
      selected: () => { drawings: string[]; groups: string[]; all: string };
      /** [144] Öffnungen (id, Wirtswand, Lage ab Wandanfang). */
      openings: () => { id: string; hostWallId: string; position: number }[];
      /** [187] Höhen von Decken (UK/OK/Dicke), Wänden (UK/OK) und Fenstern (Brüstung/Höhe) aus dem Kern, in Metern (absolutes Z). */
      heights: () => {
        ceilings: { id: string; zBottom: number; zTop: number; thickness: number }[];
        walls: { id: string; zBottom: number; zTop: number }[];
        openings: { id: string; sillHeight: number; height: number }[];
        /** [187] Teil 2: Traufe (absolutes Z), Neigung, Attika-Höhe; Steighöhe der Treppen; Sohle der Baugruben. */
        roofs: { id: string; eave: number; pitchDeg: number; parapetHeight: number }[];
        stairs: { id: string; totalRise: number; baseOffset: number }[];
        /** [187] Höhe je Höhenlinie der Höhenlinien-Sätze. */
        contours: { id: string; zs: number[] }[];
        excavations: { id: string; bottom: number }[];
      };
      /** [144] Auswahl setzen (wie ein Klick), z. B. `{ openings: ["D1"] }`. */
      select: (patch: Record<string, string[]>) => void;
      /** [144] Punkte einer Bemassung (Kette) — folgt sie der Öffnung? */
      dimPts: (id: string) => { x: number; y: number }[];
      /** [144] Texte der Hinweise (Benachrichtigungen). */
      notices: () => string[];
      /** [173] Linien einer Klasse (z. B. "door-lintel") im Grundriss der aktiven Ebene (alle Kategorien, 1:50, Detailgrad der Anzeige). */
      planLines: (cls: string) => number;
      /** [173] Modelldarstellung der aktiven Ebene (Feld `modelViewOptionId`). */
      modelView: () => string | undefined;
      /** [173] Schnitt der aktiven Ebene (1:50, Detailgrad der Anzeige): Zahl der Wand-Schnittflächen und ihre Fläche (m²). */
      sectionWalls: () => Promise<{ n: number; area: number }>;
      /** [193] Gelände-/Umgebungs-Elemente (Art, Id, bei der Baugrube die erste Umrissecke, bei Höhenlinien der erste Punkt). */
      context: () => { id: string; type: string; first?: { x: number; y: number } }[];
      /** [193] Gefüllte Flächen (Füllfarbe gesetzt) im Grundriss der aktiven Ebene (alle Kategorien, 1:100); bei 0 ist nichts Gefülltes mehr zu sehen. */
      planFills: () => number;
      /** [193] Höhe (z) des ersten Gelände-Netz-Punkts. */
      terrainZ: () => number;
      /** [185] Darstellungszustand der Plan-Ansicht: aktive Ebene, Bildmitte (Modell-m), Zoom (px/m), Massstab. */
      viewCamera: () => { levelId: string; center: { x: number; y: number } | null; pxPerMeter: number | null; scale: number };
      /** [192] Sichtbare Ebenen-Codes und Zahl der Plan-Primitive (gesamt / mit Wand-Bezug) der aktiven Ebene. */
      layerView: () => { wallId: string; visible: string[]; prims: number; wallPrims: number };
      /** [195] Strichstärke-Override der Wände (id → mm), nur gesetzte. */
      wallWeights: () => Record<string, number>;
      /** [190] Auswahl-Aktion wie das native Menü (Bearbeiten > Verbinden usw.), ohne Tastendruck: `runSelectionAction`. */
      selectionAction: (id: SelectionActionId) => void;
      /** [190] Wände (id, Start, Ende) des Projekts. */
      walls: () => { id: string; start: { x: number; y: number }; end: { x: number; y: number } }[];
      /** [185] 3D-Element-Filter (Store) und die Wand-ids des 3D-Modells bzw. der Pick-Geometrie mit ihm. */
      view3d: () => { only: string[] | null; hidden: string[]; walls: string[]; pickWalls: string[]; floors: string[]; pickOpenings: { id: string; host: string }[] };
      /** [203] Grundriss der aktiven Ebene wie in der Ansicht (Geschoss-Überlagerung nach Zeichnungsebenen-Modus): Raumstempel je Geschoss (gesamt/gedimmt) und Zahl der Achs-Beschriftungen `axis`. */
      planStamps: (axis: string) => { floors: Record<string, { n: number; greyed: number }>; axis: number };
    };
  }
}

export function installTestHooks(): void {
  window.__dossierTest = {
    corePanic: () => {
      try {
        core().__debug_panic(storeDocument(getState().project).id);
      } catch (e) {
        return e instanceof Error ? e.name : String(e);
      }
      return "";
    },
    coreReady,
    coreEpoch,
    counts: () => {
      const p = getState().project;
      return { walls: p.walls.length, openings: p.openings?.length ?? 0, drawingLevels: p.drawingLevels.length, coreJson: storeDocument(p).json().length };
    },
    lines: () =>
      getState().project.drawings2d.flatMap((d) => (d.geom.shape === "line" ? [{ a: d.geom.a, b: d.geom.b }] : [])),
    polylines: (prefix) =>
      getState().project.drawings2d.flatMap((d) => (d.id.startsWith(prefix) && d.geom.shape === "polyline" ? [{ id: d.id, pts: d.geom.pts }] : [])),
    openings: () => (getState().project.openings ?? []).map((o) => ({ id: o.id, hostWallId: o.hostWallId, position: o.position })),
    heights: () => {
      const p = getState().project;
      const ceilings = p.ceilings ?? [];
      const ext = verticalExtents(p, p.walls, ceilings);
      return {
        ceilings: ceilings.map((c, i) => ({ id: c.id, zBottom: ext.ceilings[i].zBottom, zTop: ext.ceilings[i].zTop, thickness: ceilingThickness(p, c) })),
        walls: p.walls.map((w, i) => ({ id: w.id, zBottom: ext.walls[i].zBottom, zTop: ext.walls[i].zTop })),
        openings: (p.openings ?? []).map((o) => ({ id: o.id, sillHeight: o.sillHeight, height: o.height })),
        roofs: (p.roofs ?? []).map((r) => {
          const f = p.drawingLevels.find((l) => l.id === r.floorId);
          return { id: r.id, eave: r.baseElevation ?? (f ? (f.baseElevation ?? 0) + (f.floorHeight ?? 0) : 0), pitchDeg: r.pitchDeg, parapetHeight: r.parapetHeight ?? 0 };
        }),
        stairs: (p.stairs ?? []).map((st) => ({ id: st.id, totalRise: st.totalRise ?? NaN, baseOffset: st.baseOffset ?? 0 })),
        contours: (p.context ?? []).flatMap((c) => (c.type === "contourSet" ? [{ id: c.id, zs: c.contours.map((k) => k.z) }] : [])),
        excavations: (p.context ?? []).flatMap((c) => (c.type === "excavation" ? [{ id: c.id, bottom: c.bottom }] : [])),
      };
    },
    wallWeights: () => Object.fromEntries(getState().project.walls.flatMap((w) => (w.strokeWeight === undefined ? [] : [[w.id, w.strokeWeight]]))),
    selectionAction: (id) => runSelectionAction(id),
    walls: () => getState().project.walls.map((w) => ({ id: w.id, start: { ...w.start }, end: { ...w.end } })),
    select: (patch) => getState().setSelection(patch),
    dimPts: (id) => {
      const g = getState().project.drawings2d.find((d) => d.id === id)?.geom;
      return g?.shape === "dimension" ? g.pts.map((p) => ({ x: p.x, y: p.y })) : [];
    },
    notices: () => getState().notifications.map((n) => n.message),
    planLines: (cls) => {
      const s = getState();
      const codes = new Set<string>();
      const walk = (cs: { code: string; children?: unknown[] }[]): void => {
        for (const c of cs) {
          codes.add(c.code);
          walk((c.children ?? []) as { code: string; children?: unknown[] }[]);
        }
      };
      walk(s.project.layers);
      return generatePlan(s.project, s.activeLevelId, codes, undefined, s.detail, false, false, true, 50).primitives.filter((q) => q.kind === "line" && q.cls === cls).length;
    },
    context: () =>
      (getState().project.context ?? []).map((c) => ({ id: c.id, type: c.type, first: c.type === "excavation" ? c.outline[0] : c.type === "contourSet" ? c.contours[0]?.pts[0] : undefined })),
    planFills: () => {
      const s = getState();
      const codes = new Set<string>();
      const walk = (cs: { code: string; children?: unknown[] }[]): void => {
        for (const c of cs) {
          codes.add(c.code);
          walk((c.children ?? []) as { code: string; children?: unknown[] }[]);
        }
      };
      walk(s.project.layers);
      return generatePlan(s.project, s.activeLevelId, codes, undefined, s.detail, false, false, true, 100).primitives.filter((q) => q.kind === "polygon" && q.fill && q.fill !== "none").length;
    },
    terrainZ: () => {
      const t = (getState().project.context ?? []).find((c) => c.type === "terrainMesh");
      return t && t.type === "terrainMesh" ? t.positions[2] : NaN;
    },
    modelView: () => getState().project.drawingLevels.find((l) => l.id === getState().activeLevelId)?.modelViewOptionId,
    sectionWalls: async () => {
      const s = getState();
      const level = s.project.drawingLevels.find((l) => l.id === s.activeLevelId);
      const out = level ? await computeSection(s.project, level) : null;
      if (!out) return { n: 0, area: 0 };
      const polys = generateSectionPlan(out, false, { scaleDenominator: 50, detail: s.detail }).primitives.filter((q) => q.kind === "polygon" && !!q.wallId);
      const area = (pts: { x: number; y: number }[]) => Math.abs(pts.reduce((a, p, i) => a + p.x * pts[(i + 1) % pts.length].y - pts[(i + 1) % pts.length].x * p.y, 0)) / 2;
      return { n: polys.length, area: polys.reduce((a, q) => a + (q.kind === "polygon" ? area(q.pts) : 0), 0) };
    },
    viewCamera: () => {
      const st = getViewStateBridge()?.live();
      return {
        levelId: getState().activeLevelId,
        center: st?.cameraCenter ?? null,
        pxPerMeter: st?.cameraPxPerMeter ?? null,
        scale: getState().scaleDenominator,
      };
    },
    view3d: () => {
      const f = getView3dFilter();
      const s = getState();
      const p = s.project;
      const mode = s.displayModes[BUILTIN_PANEL_IDS.drawingLevels] ?? "all";
      const hide = toFilter3d(f, [], hiddenFloorIds(p.drawingLevels, (id) => itemDisplay(mode, id === s.activeLevelId, p.drawingLevels.find((l) => l.id === id)?.visible ?? false)));
      const uniq = (ids: string[]) => [...new Set(ids)].sort();
      return {
        only: f.only,
        hidden: f.hidden,
        walls: uniq(projectToModel3d(p, { hide }).walls.map((w) => w.wallId)),
        pickWalls: uniq(pickGeometry(p, 0, hide).walls.map((w) => w.wallId)),
        pickOpenings: (() => {
          const g = pickGeometry(p, 0, hide);
          const ids = uniq([...g.openings.map((o) => o.openingId), ...g.openingMeshes.map((o) => o.openingId)]);
          return ids.map((id) => ({ id, host: p.openings?.find((o) => o.id === id)?.hostWallId || p.openings?.find((o) => o.id === id)?.hostRoofId || p.openings?.find((o) => o.id === id)?.hostCeilingId || "" }));
        })(),
        floors: uniq(projectToModel3d(p, { hide }).walls.map((w) => p.walls.find((x) => x.id === w.wallId)?.floorId ?? "")),
      };
    },
    planStamps: (axis) => {
      const s = getState();
      const p = s.project;
      const mode = s.displayModes[BUILTIN_PANEL_IDS.drawingLevels] ?? "all";
      const display = (id: string) => itemDisplay(mode, id === s.activeLevelId, p.drawingLevels.find((l) => l.id === id)?.visible ?? false);
      const plan = materializeGreyed(materializeUnderlay(generateVisibleLevelsPlan(p, s.activeLevelId, collectVisibleCodes(p.layers), undefined, s.detail, false, false, display, s.scaleDenominator)), true);
      const floorOf = new Map((p.rooms ?? []).map((r) => [r.id, r.floorId]));
      const floors: Record<string, { n: number; greyed: number }> = {};
      let n = 0;
      for (const q of plan.primitives) {
        if (q.kind === "text" && q.roomId) {
          const f = (floors[floorOf.get(q.roomId) ?? "?"] ??= { n: 0, greyed: 0 });
          f.n++;
          if (q.greyed) f.greyed++;
        } else if (q.kind === "drawingText" && q.text === axis && q.drawingId && p.drawings2d.some((d) => d.id === q.drawingId && d.geom.shape === "grid")) n++;
      }
      return { floors, axis: n };
    },
    layerView: () => {
      const s = getState();
      const vis: string[] = [];
      const walk = (cs: { code: string; visible: boolean; children?: unknown[] }[]): void => {
        for (const c of cs) {
          if (c.visible) vis.push(c.code);
          walk((c.children ?? []) as { code: string; visible: boolean; children?: unknown[] }[]);
        }
      };
      walk(s.project.layers);
      const prims = generatePlan(s.project, s.activeLevelId, new Set(vis), undefined, s.detail, false, false, true, 50).primitives;
      return { wallId: s.project.walls.find((w) => w.floorId === s.activeLevelId)?.id ?? s.project.walls[0]?.id ?? "", visible: vis.sort(), prims: prims.length, wallPrims: prims.filter((q) => !!(q as { wallId?: string }).wallId).length };
    },
    selected: () => ({ drawings: [...getState().selection.drawings], groups: [...getState().selection.groups], all: JSON.stringify(getState().selection) }),
  };
}

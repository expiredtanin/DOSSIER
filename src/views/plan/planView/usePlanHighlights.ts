// Hervorhebungen der Plan-Ansicht ([165] aus `PlanView.tsx`): Konturen der gewählten Bauteile und 2D-Elemente,
// Textrahmen, Pfade für die native Fläche und die Vorschau des überfahrenen Listeneintrags. Aufgerufen
// einmal von `PlanView`.

import type { Primitive, OwnerField, PickKind } from "../../../core";
import { useMemo, useEffect } from "react";
import { planPrimAt } from "../../../core";
import { textFrameCorners } from "../../../text/textFrame";
import { TREE_PICK } from "./constants";
import { PlanPickIndex } from "../../../core";
import type { Plan } from "../../../core";
import type { UnderlayGroup } from "../../../core";
import type { ViewBox__plan_planView_geometry as ViewBox } from "../../../core";
import type { Vec2 } from "../../../model/types";
import type { PickCandidate } from "./types";

/** Werte aus `PlanView`, die dieser Hook liest (unverändert, ohne Kopie). */
export interface UsePlanHighlightsArgs {
  getPick: () => PlanPickIndex;
  selectedWallIds: string[];
  selected: number | null;
  plan: Plan;
  selectedDrawingIds: string[];
  getUnderlayIds: () => Map<string, UnderlayGroup> | null;
  editTextId: string | null | undefined;
  useGpuRenderer: boolean;
  wantNative: boolean;
  nativeHook: { render: (viewBox: ViewBox, paperScaleN?: number, _textScale?: number, onSent?: () => void) => void; updateGeometry: (plan: Plan, pxPerMeter?: number) => void; ready: boolean; gpuTexts: boolean; setExcludedText: (id: string | null) => void; setHighlight: (prims: readonly Primitive[], color: string) => void; setDashScale: (n: number) => void; };
  toLocal: (p: Vec2) => Vec2;
  overlayHeavyRef: React.MutableRefObject<boolean>;
  selectedCeilingIds: string[];
  selectedOpeningIds: string[];
  selectedStairIds: string[];
  selectedRoomIds: string[];
  selectedRoofIds: string[];
  selectedContextObjectIds: string[];
  selectedSite: string[];
  selectedTreeIds: string[];
  selectedSectionLineIds: string[];
  selectedExtrudedSolidIds: string[];
  selectedColumnIds: string[];
  hoverPick: PickCandidate | null;
}

export function usePlanHighlights(inp: UsePlanHighlightsArgs) {
  const {
    getPick,
    selectedWallIds,
    selected,
    plan,
    selectedDrawingIds,
    getUnderlayIds,
    editTextId,
    useGpuRenderer,
    wantNative,
    nativeHook,
    toLocal,
    overlayHeavyRef,
    selectedCeilingIds,
    selectedOpeningIds,
    selectedStairIds,
    selectedRoomIds,
    selectedRoofIds,
    selectedContextObjectIds,
    selectedSite,
    selectedTreeIds,
    selectedSectionLineIds,
    selectedExtrudedSolidIds,
    selectedColumnIds,
    hoverPick,
  } = inp;

  // Hervorhebungs-Konturen der Auswahl. Vorrang hat die wand-bezogene Auswahl
  // (selectedWallIds, von App kontrolliert): dann werden ALLE Bänder JEDER
  // gewählten Wand umrandet. Ohne Wand-Auswahl greift die lokale Klick-
  // Hervorhebung (ein einzelnes Polygon per hitIndex), z. B. für Polygone ohne
  // Wandbezug.
  // Besitzer über den Auswahl-Index im Kern (s. planView/planPick.ts) — statt je Elementart ein
  // `plan.primitives.filter`.
  const primsOwnedBy = <K extends Primitive>(
    field: OwnerField,
    ids: ReadonlyArray<string> | undefined,
    keep: (p: Primitive) => p is K,
  ): K[] => {
    if (!ids || ids.length === 0) return [];
    return getPick().ownedBy(field, ids).filter(keep);
  };

  const highlightPolys = useMemo(() => {
    if (selectedWallIds && selectedWallIds.length) {
      return primsOwnedBy("wallId", selectedWallIds, (p): p is Extract<Primitive, { kind: "polygon" }> => p.kind === "polygon");
    }
    if (selected !== null) {
      const p = planPrimAt(plan, selected);
      if (p && p.kind === "polygon") return [p];
    }
    return [];
  }, [plan, selectedWallIds, selected]);

  // Hervorhebung der selektierten 2D-Zeichenelemente (Mehrfach/Marquee): alle
  // Linien-/Polygon-Primitive, deren drawingId in der Auswahl liegt, werden mit
  // Akzentkontur überzeichnet (sichtbares Feedback auch ohne Griffe).
  const highlightDrawPrims = useMemo(() => {
    const ids =
      selectedDrawingIds && selectedDrawingIds.length
        ? new Set(selectedDrawingIds)
        : null;
    if (!ids) return [];
    const fromPrims = primsOwnedBy("drawingId", selectedDrawingIds, (p): p is Extract<Primitive, { kind: "line" | "polygon" }> => p.kind === "line" || p.kind === "polygon");
    // Linien kompakt gehaltener Zeichnungen entstehen nur für die gewählten (wenige).
    const underIds = getUnderlayIds();
    if (!underIds || !selectedDrawingIds) return fromPrims;
    // Pro Gruppe EIN Durchlauf über deren Zeichnungen (statt `find` je gewählter ID:
    // bei tausenden gewählten Katasterobjekten sonst quadratisch).
    const extra: Array<Extract<Primitive, { kind: "line" | "polygon" }>> = [];
    const groups = new Set<NonNullable<ReturnType<typeof underIds.get>>>();
    for (const id of selectedDrawingIds) {
      const g = underIds.get(id);
      if (g) groups.add(g);
    }
    for (const g of groups) {
      const chosen = g.drawings.filter((d) => ids.has(d.id));
      if (chosen.length) for (const pr of g.build(chosen)) if (pr.kind === "line") extra.push(pr);
    }
    return extra.length ? [...fromPrims, ...extra] : fromPrims;
  }, [plan, selectedDrawingIds]);

  // Hervorhebung ausgewählter TEXT-Objekte (Auswahl-Rahmen, Nutzer-Wunsch):
  // `drawingText` hat keine `pts`/`a`/`b` wie Linie/Polygon, daher eigener
  // Zweig statt `highlightDrawPrims` — der Rahmen wird geschätzt, s.
  // `text/textFrame.ts` `textFrameCorners`. Während des Inline-Editors (`editTextId`) NICHT
  // zusätzlich zeichnen — der Editor-Rahmen selbst übernimmt dort die Anzeige.
  const highlightTextFrames = useMemo(() => {
    const ids =
      selectedDrawingIds && selectedDrawingIds.length ? new Set(selectedDrawingIds) : null;
    if (!ids) return [];
    return primsOwnedBy("drawingId", selectedDrawingIds, (p): p is Extract<Primitive, { kind: "drawingText" }> => p.kind === "drawingText" && p.drawingId !== editTextId);
  }, [plan, selectedDrawingIds, editTextId]);

  // Auswahl-Hervorhebung als EIN <path> je Art statt eines DOM-Elements je Objekt:
  // bei tausenden gewählten Katasterobjekten war der DOM-Aufbau (nicht die Auswahl)
  // der Engpass. Aussehen identisch (beide Klassen: fill none, Kontur).
  // Native Fläche aktiv → sie zeichnet die Auswahl-Hervorhebung selbst (GPU).
  const nativeHighlight = useGpuRenderer && wantNative;
  const setNativeHighlight = nativeHook.setHighlight;
  useEffect(() => {
    if (!nativeHighlight) return;
    const accent =
      typeof document !== "undefined"
        ? getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2f6fed"
        : "#2f6fed";
    setNativeHighlight(highlightDrawPrims, accent);
  }, [nativeHighlight, highlightDrawPrims, setNativeHighlight]);
  useEffect(() => {
    // Beim Verlassen des nativen Modus die native Hervorhebung leeren.
    if (!nativeHighlight) return;
    return () => setNativeHighlight([], "#000");
  }, [nativeHighlight, setNativeHighlight]);
  const highlightDrawPath = useMemo(() => {
    if (nativeHighlight) return "";
    const parts: string[] = [];
    for (const p of highlightDrawPrims) {
      if (p.kind === "line") {
        const a = toLocal(p.a), b = toLocal(p.b);
        parts.push(`M${a.x} ${a.y}L${b.x} ${b.y}`);
      } else if (p.pts.length > 1) {
        const q = p.pts.map(toLocal);
        parts.push(`M${q.map((s) => `${s.x} ${s.y}`).join("L")}Z`);
      }
    }
    return parts.join("");
  }, [highlightDrawPrims, nativeHighlight, toLocal]);
  overlayHeavyRef.current = highlightDrawPath.length > 300_000;
  const highlightTextPath = useMemo(() => {
    const parts: string[] = [];
    for (const p of highlightTextFrames) {
      const q = textFrameCorners(p).map(toLocal);
      parts.push(`M${q.map((s) => `${s.x} ${s.y}`).join("L")}Z`);
    }
    return parts.join("");
  }, [highlightTextFrames, toLocal]);

  // Hervorhebung der selektierten Decken: alle Polygone JEDER gewählten Decke
  // (Fläche + Umriss) mit Akzentkontur überzeichnen — analog zur Wand-Auswahl.
  const highlightCeilingPolys = useMemo(() => {
    const ids =
      selectedCeilingIds && selectedCeilingIds.length
        ? new Set(selectedCeilingIds)
        : null;
    if (!ids) return [];
    return primsOwnedBy("ceilingId", selectedCeilingIds, (p): p is Extract<Primitive, { kind: "polygon" }> => p.kind === "polygon");
  }, [plan, selectedCeilingIds]);

  // Hervorhebung der selektierten Öffnungen: alle Symbol-Primitive (Linien/Bögen/
  // Rahmen) mit der gewählten openingId mit Akzentkontur überzeichnen.
  const highlightOpeningPrims = useMemo(() => {
    const ids =
      selectedOpeningIds && selectedOpeningIds.length
        ? new Set(selectedOpeningIds)
        : null;
    if (!ids) return [];
    return primsOwnedBy("openingId", selectedOpeningIds, (p): p is Extract<Primitive, { kind: "line" | "arc" | "polygon" }> => p.kind === "line" || p.kind === "arc" || p.kind === "polygon");
  }, [plan, selectedOpeningIds]);

  // Hervorhebung der selektierten Treppen: alle Tritt-/Symbol-Primitive (Polygone
  // + Linien) mit der gewählten stairId mit Akzentkontur überzeichnen.
  const highlightStairPrims = useMemo(() => {
    const ids =
      selectedStairIds && selectedStairIds.length ? new Set(selectedStairIds) : null;
    if (!ids) return [];
    return primsOwnedBy("stairId", selectedStairIds, (p): p is Extract<Primitive, { kind: "line" | "polygon" }> => p.kind === "line" || p.kind === "polygon");
  }, [plan, selectedStairIds]);

  // Hervorhebung der selektierten Räume: die Fläche JEDES gewählten Raums (Polygon
  // mit roomId) mit Akzentkontur überzeichnen — analog zur Decken-Auswahl.
  const highlightRoomPolys = useMemo(() => {
    const ids =
      selectedRoomIds && selectedRoomIds.length ? new Set(selectedRoomIds) : null;
    if (!ids) return [];
    return primsOwnedBy("roomId", selectedRoomIds, (p): p is Extract<Primitive, { kind: "polygon" }> => p.kind === "polygon");
  }, [plan, selectedRoomIds]);

  // Hervorhebung der selektierten Dächer: das (unsichtbare) Traufe-Pick-Polygon
  // mit roofId als Akzentkontur überzeichnen — analog zur Raum-/Decken-Auswahl.
  const highlightRoofPolys = useMemo(() => {
    const ids =
      selectedRoofIds && selectedRoofIds.length ? new Set(selectedRoofIds) : null;
    if (!ids) return [];
    return primsOwnedBy("roofId", selectedRoofIds, (p): p is Extract<Primitive, { kind: "polygon" }> => p.kind === "polygon");
  }, [plan, selectedRoofIds]);

  // Hervorhebung der selektierten Kontext-Objekte (Gebäude/Terrain): das
  // (unsichtbare) Bbox-Pick-Band mit contextObjectId als Akzentkontur
  // überzeichnen — analog zur Dach-/Raum-Auswahl.
  // [137] Gewählte Lage-Darstellung (Schatten/Baurecht): ihre Flächen bzw. Bänder (`@…`-Ids) ebenso.
  const highlightContextObjectPolys = useMemo(() => {
    const ids = [
      ...(selectedContextObjectIds ?? []),
      ...(selectedSite ?? []).map((s) => "@" + s),
      ...(selectedTreeIds ?? []).map((s) => TREE_PICK + s),
    ];
    if (!ids.length) return [];
    return primsOwnedBy("contextObjectId", ids, (p): p is Extract<Primitive, { kind: "polygon" }> => p.kind === "polygon");
  }, [plan, selectedContextObjectIds, selectedSite, selectedTreeIds]);

  // Hervorhebung der selektierten Schnitt-/Ansichtslinie: das (unsichtbare)
  // Pick-Band (Polygon mit sectionLineId) mit Akzentkontur überzeichnen.
  const highlightSectionLinePolys = useMemo(() => {
    const ids =
      selectedSectionLineIds && selectedSectionLineIds.length
        ? new Set(selectedSectionLineIds)
        : null;
    if (!ids) return [];
    return primsOwnedBy("sectionLineId", selectedSectionLineIds, (p): p is Extract<Primitive, { kind: "polygon" }> => p.kind === "polygon");
  }, [plan, selectedSectionLineIds]);

  // Hervorhebung der selektierten extrudierten Körper (truck-Integration): der
  // Footprint-Umriss (Polygon mit extrudedSolidId) mit Akzentkontur überzeichnen
  // — analog zur Raum-Auswahl.
  const highlightExtrudedSolidPolys = useMemo(() => {
    const ids =
      selectedExtrudedSolidIds && selectedExtrudedSolidIds.length
        ? new Set(selectedExtrudedSolidIds)
        : null;
    if (!ids) return [];
    return primsOwnedBy("extrudedSolidId", selectedExtrudedSolidIds, (p): p is Extract<Primitive, { kind: "polygon" }> => p.kind === "polygon");
  }, [plan, selectedExtrudedSolidIds]);

  // Hervorhebung der selektierten Stützen (Tragwerk): der Querschnitt-Umriss
  // (Polygon mit columnId) mit Akzentkontur überzeichnen — analog Extrusion/Raum.
  const highlightColumnPolys = useMemo(() => {
    const ids =
      selectedColumnIds && selectedColumnIds.length ? new Set(selectedColumnIds) : null;
    if (!ids) return [];
    return primsOwnedBy("columnId", selectedColumnIds, (p): p is Extract<Primitive, { kind: "polygon" }> => p.kind === "polygon");
  }, [plan, selectedColumnIds]);

  // Primitive des per Listen-Hover vorgemerkten Objekts (Vorschau-Hervorhebung).
  const hoverPrims = useMemo((): Primitive[] => {
    if (!hoverPick) return [];
    if (hoverPick.kind === "site") return primsOwnedBy("contextObjectId", ["@" + hoverPick.id], (_p): _p is Primitive => true);
    if (hoverPick.kind === "tree") return primsOwnedBy("contextObjectId", [TREE_PICK + hoverPick.id], (_p): _p is Primitive => true);
    const field: Record<Exclude<PickKind, "site" | "tree">, OwnerField> = {
      wall: "wallId", drawing: "drawingId", ceiling: "ceilingId", opening: "openingId",
      stair: "stairId", room: "roomId", roof: "roofId", context: "contextObjectId",
      section: "sectionLineId", solid: "extrudedSolidId", column: "columnId",
    };
    const out: Primitive[] = primsOwnedBy(field[hoverPick.kind], [hoverPick.id], (_p): _p is Primitive => true);
    if (hoverPick.kind === "drawing") {
      // Linien kompakt gehaltener Zeichnungen entstehen nur für dieses eine Objekt.
      const g = getUnderlayIds()?.get(hoverPick.id);
      const d = g?.drawings.find((x) => x.id === hoverPick.id);
      if (g && d) for (const pr of g.build([d])) out.push(pr);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hoverPick, plan]);

  return {
    highlightPolys,
    highlightDrawPrims,
    highlightDrawPath,
    highlightTextPath,
    highlightCeilingPolys,
    highlightOpeningPrims,
    highlightStairPrims,
    highlightRoomPolys,
    highlightRoofPolys,
    highlightContextObjectPolys,
    highlightSectionLinePolys,
    highlightExtrudedSolidPolys,
    highlightColumnPolys,
    hoverPrims,
  };
}

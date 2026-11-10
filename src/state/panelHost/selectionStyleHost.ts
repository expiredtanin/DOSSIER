// Panel-Host, Teil Darstellung der Auswahl ([121], aus `usePanelHostBase` herausgelöst): Farbe,
// Stift-Kopplung, Strichstärke, Füllung/Schraffur, Deckkraft, Vorder-/Hintergrund samt Quellen
// (Nach Ebene/Bauteil), Massketten-/Detail-/Raster-Attribute sowie Grösse, Lage, Ebene und Drehung
// der gewählten Elemente und die Geometrie-Felder freier 2D-Elemente (Linie, Kreis, Bogen, Text).

import { applyFillMode } from "../fillMode";
import { cmdMutation, opsMutation, patchItem } from "../../core";
import { resolvePenColor } from "../../model/penSets";
import type { TransformSelection } from "../../tools/transform";
import type { FlatHostOpts, HostPart } from "./types";


/**
 * Baut eine TransformSelection für GENAU EIN Element (Object-Info: Verschieben/
 * Drehen per Zahlenfeld, siehe onMoveSelectionBy/onRotateSelectionAround unten).
 * Deckt nur die vom Transform-Kern (tools/transform.ts) unterstützten Arten ab
 * — Decke/Öffnung/Treppe/Raum kennt er nicht, dort liefert die Funktion `null`
 * (Aufrufer macht dann No-op, wie bei onResizeSelection).
 */
function singleTransformSel(kind: string, id: string): TransformSelection | null {
  if (kind === "wall") return { wallIds: [id], drawingId: null };
  if (kind === "drawing2d") return { wallIds: [], drawingId: id };
  if (kind === "extrudedSolid") return { wallIds: [], drawingId: null, extrudedSolidId: id };
  if (kind === "column") return { wallIds: [], drawingId: null, columnId: id };
  if (kind === "ceiling") return { wallIds: [], drawingId: null, ceilingIds: [id] };
  // Dach: Move geht (Umriss verschiebt sich), Rotate no-opt bewusst (s.
  // TransformSelection.roofIds) — der Host-Aufruf degradiert dafür von
  // selbst über `gatherItems`, kein Sonderfall hier nötig.
  if (kind === "roof") return { wallIds: [], drawingId: null, roofIds: [id] };
  if (kind === "stair") return { wallIds: [], drawingId: null, stairIds: [id] };
  if (kind === "room") return { wallIds: [], drawingId: null, roomIds: [id] };
  // [144] Öffnung: X/Y im Objekt-Info verschiebt sie entlang (bzw. in eine andere) Wand.
  if (kind === "opening") return { wallIds: [], drawingId: null, openingIds: [id] };
  return null;
}

export function buildSelectionStyleHost(c: FlatHostOpts) {
  const { addColorToCustomPalette, applyChange, commitTransformOn, project, resizeElement, selection, setElementBackground, setElementColor, setElementFill, setElementFillColor, setElementForeground, setElementWeight, setProject, updateCeiling, updateDrawing2D, updateOpening, updateRoof, updateRoom, updateStair, updateWall } = c;
  return {
    onSetSelectionColor: (color) => {
      if (!selection) return;
      if (selection.kind === "wall" || selection.kind === "drawing2d")
        setElementColor(selection.kind, selection.id, color);
      else if (selection.kind === "ceiling")
        updateCeiling(selection.id, { color });
      else if (selection.kind === "opening")
        updateOpening(selection.id, { color });
      else if (selection.kind === "stair")
        updateStair(selection.id, { color });
      else if (selection.kind === "room")
        updateRoom(selection.id, { color });
    },
    // Stift-Kopplung der Farbe oben (s. `Selection.colorPenId`-Doku) —
    // dieselben Selektionsarten wie `onSetSelectionColor`. `penId` gesetzt ⇒ Farbe sofort aus dem aktiven
    // Stiftsatz backen; `undefined` ⇒ nur die Kopplung lösen, letzter
    // gebackener Wert bleibt als freie Farbe stehen.
    onSetSelectionColorPen: (penId) => {
      if (!selection) return;
      const color = penId ? resolvePenColor(project, penId) : undefined;
      const patch = color !== undefined ? { colorPenId: penId, color } : { colorPenId: penId };
      if (selection.kind === "wall") updateWall(selection.id, patch);
      else if (selection.kind === "drawing2d") updateDrawing2D(selection.id, patch);
      else if (selection.kind === "ceiling") updateCeiling(selection.id, patch);
      else if (selection.kind === "opening") updateOpening(selection.id, patch);
      else if (selection.kind === "stair") updateStair(selection.id, patch);
      else if (selection.kind === "room") updateRoom(selection.id, patch);
    },
    onSetSelectionWeight: (weightMm) => {
      // Strichstärke-Override: Wand/Decke (`strokeWeight`) oder Drawing2D (`weightMm`).
      if (selection?.kind === "wall") updateWall(selection.id, { strokeWeight: weightMm });
      else if (selection?.kind === "ceiling")
        updateCeiling(selection.id, { strokeWeight: weightMm });
      else if (selection?.kind === "drawing2d")
        setElementWeight(selection.id, weightMm);
    },
    onSetSelectionFill: (hatchId) => {
      // Schraffur-Override: Wand, Decke oder Drawing2D (geschlossene Formen).
      // `null` löscht das Feld (→ „Nach System"/Quelle).
      if (selection?.kind === "wall")
        updateWall(selection.id, { hatchId: hatchId ?? undefined });
      else if (selection?.kind === "ceiling")
        updateCeiling(selection.id, { hatchId: hatchId ?? undefined });
      else if (selection?.kind === "drawing2d")
        setElementFill(selection.id, hatchId);
    },
    onSetSelectionLineStyle: (lineStyleId) => {
      // Nur Drawing2D trägt einen Linienstil (Wand/Decke/etc. nicht).
      if (selection?.kind === "drawing2d")
        updateDrawing2D(selection.id, { lineStyleId });
    },
    onSetSelectionFillColor: (color) => {
      // Vollton-Füllfarbe nur bei Drawing2D (geschlossene Formen).
      if (selection?.kind === "drawing2d")
        setElementFillColor(selection.id, color);
    },
    onSetSelectionFillMode: (mode) => {
      if (selection?.kind !== "drawing2d") return;
      const id = selection.id;
      setProject(opsMutation((p) => patchItem(p, "drawings2d", id, (d) => applyFillMode(d, p.hatches, mode))));
    },
    onSetSelectionFillOpacity: (opacity) => {
      if (selection?.kind === "drawing2d")
        setProject(
          opsMutation((p) =>
            patchItem(p, "drawings2d", selection.id, (d) => {
              const { fillOpacity: _old, ...rest } = d;
              return opacity >= 1 ? rest : { ...rest, fillOpacity: Math.max(0, opacity) };
            }),
          ),
        );
    },
    onSetSelectionOpacity: (opacity) => {
      // Deckkraft eines 2D-Elements. Bei BILDERN bleibt es die Deckkraft der
      // Bildgeometrie (bestehendes Verhalten, eigenes Feld); bei allen
      // übrigen Formen die neue OBJEKT-Transparenz, die auf Striche UND
      // Füllungen wirkt (`Drawing2D.opacity`). Nur EIN Bedienfeld — welches
      // Feld gesetzt wird, entscheidet die Form.
      if (selection?.kind === "drawing2d")
        setProject(
          opsMutation((p) =>
            patchItem(p, "drawings2d", selection.id, (d) =>
              d.geom.shape === "image" ? { ...d, geom: { ...d.geom, opacity } } : { ...d, opacity },
            ),
          ),
        );
      else if (selection?.kind === "contextObject")
        applyChange((p) =>
          patchItem(p, "context", selection.id, (o) => (o.type === "image" ? { ...o, opacity } : o)),
        );
    },
    onSetSelectionImageFilters: (filters) => {
      // Nur Kontext-Objekt-Bilder tragen `filters` (s. `ContextImage`) —
      // gemergt mit den bestehenden Werten (Teil-Update, ein Slider ändert
      // nur SEINEN eigenen Wert).
      if (selection?.kind !== "contextObject") return;
      applyChange((p) =>
        patchItem(p, "context", selection.id, (o) =>
          o.type === "image" ? { ...o, filters: { ...o.filters, ...filters } } : o,
        ),
      );
    },
    onSetSelectionForeground: (color) => {
      // Vordergrund-Override: Wand, Decke oder Drawing2D.
      if (
        selection?.kind === "wall" ||
        selection?.kind === "ceiling" ||
        selection?.kind === "drawing2d"
      )
        setElementForeground(selection.kind, selection.id, color);
    },
    onSetSelectionBackground: (color) => {
      // Hintergrund-Override: Wand, Decke oder Drawing2D.
      if (
        selection?.kind === "wall" ||
        selection?.kind === "ceiling" ||
        selection?.kind === "drawing2d"
      )
        setElementBackground(selection.kind, selection.id, color);
    },
    // Stift-Kopplung von Vordergrund/Hintergrund (s. `Selection.
    // foregroundPenId`/`backgroundPenId`-Doku) — dieselben Selektionsarten
    // wie `onSetSelectionForeground`/`onSetSelectionBackground` (Wand/Decke/
    // Drawing2D; Stütze trägt zwar dasselbe Feld im Modell, hat aber ebenso
    // wie bei `onSetSelectionColorPen` noch KEINEN UI-Schreibpfad — s.
    // PENDENZEN.md-Scope-Entscheid). `penId` gesetzt ⇒ sofort aus dem aktiven
    // Stiftsatz backen; `undefined` ⇒ nur die Kopplung lösen, letzter
    // gebackener Wert bleibt als freier Override stehen.
    onSetSelectionForegroundPen: (penId) => {
      if (!selection) return;
      const foreground = penId ? resolvePenColor(project, penId) : undefined;
      const patch =
        foreground !== undefined
          ? { foregroundPenId: penId, foreground }
          : { foregroundPenId: penId };
      if (selection.kind === "wall") updateWall(selection.id, patch);
      else if (selection.kind === "ceiling") updateCeiling(selection.id, patch);
      else if (selection.kind === "drawing2d") updateDrawing2D(selection.id, patch);
    },
    onAddColorToCustomPalette: (paletteId, hex) => addColorToCustomPalette(paletteId, hex),
    onSetDashScale: (drawingId, scale) =>
      setProject(opsMutation((p) => patchItem(p, "drawings2d", drawingId, { dashScale: scale }))),
    onDetachDimension: (drawingId) => setProject(cmdMutation({ cmd: "dimdetach", ids: [drawingId] })),
    onResetDimensionText: (drawingId) =>
      setProject(
        opsMutation((p) =>
          patchItem(p, "drawings2d", drawingId, (d) => {
            if (d.geom.shape !== "dimension") return d;
            const { textOffsetsMm: _drop, ...geom } = d.geom;
            return { ...d, geom };
          }),
        ),
      ),
    onSetDetailRefLabel: (drawingId, label) =>
      setProject(
        opsMutation((p) =>
          patchItem(p, "drawings2d", drawingId, (d) =>
            d.geom.shape === "detailref" ? { ...d, geom: { ...d.geom, label } } : d,
          ),
        ),
      ),
    onSetDetailRefSheetLayout: (drawingId, sheetLayoutId) =>
      setProject(
        opsMutation((p) =>
          patchItem(p, "drawings2d", drawingId, (d) => {
            if (d.geom.shape !== "detailref") return d;
            const geom = { ...d.geom };
            if (sheetLayoutId) geom.sheetLayoutId = sheetLayoutId;
            else delete geom.sheetLayoutId;
            return { ...d, geom };
          }),
        ),
      ),
    onSetDetailRefSheetLabel: (drawingId, sheetLabel) =>
      setProject(
        opsMutation((p) =>
          patchItem(p, "drawings2d", drawingId, (d) =>
            d.geom.shape === "detailref" ? { ...d, geom: { ...d.geom, sheetLabel } } : d,
          ),
        ),
      ),
    onSetHatchPlacement: (drawingId, patch) =>
      setProject(
        opsMutation((p) =>
          patchItem(p, "drawings2d", drawingId, (d) => {
          const next = { ...d };
          // `null` = zurück auf die Ressource (Feld entfernen).
          if ("angleDeg" in patch)
            patch.angleDeg === null ? delete next.hatchAngleDeg : (next.hatchAngleDeg = patch.angleDeg);
          if ("scale" in patch)
            patch.scale === null ? delete next.hatchScale : (next.hatchScale = patch.scale);
          if ("origin" in patch)
            patch.origin === null ? delete next.hatchOrigin : (next.hatchOrigin = patch.origin);
          return next;
          }),
        ),
      ),
    onSetEndMarks: (drawingId, patch) =>
      setProject(
        opsMutation((p) =>
          patchItem(p, "drawings2d", drawingId, (d) => ({ ...d, endMarks: { ...d.endMarks, ...patch } })),
        ),
      ),
    onSetGridProps: (drawingId, patch) =>
      setProject(
        opsMutation((p) =>
          patchItem(p, "drawings2d", drawingId, (d) => {
            if (d.geom.shape !== "grid") return d;
            const geom = { ...d.geom, ...patch };
            if (patch.levels === undefined && "levels" in patch) delete geom.levels;
            return { ...d, geom };
          }),
        ),
      ),
    onSetDimensionStyle: (drawingId, patch) =>
      setProject(
        opsMutation((p) =>
          patchItem(p, "drawings2d", drawingId, (d) =>
            d.geom.shape === "dimension" ? { ...d, geom: { ...d.geom, ...patch } } : d,
          ),
        ),
      ),
    onSetSelectionBackgroundPen: (penId) => {
      if (!selection) return;
      const background = penId ? resolvePenColor(project, penId) : undefined;
      const patch =
        background !== undefined
          ? { backgroundPenId: penId, background }
          : { backgroundPenId: penId };
      if (selection.kind === "wall") updateWall(selection.id, patch);
      else if (selection.kind === "ceiling") updateCeiling(selection.id, patch);
      else if (selection.kind === "drawing2d") updateDrawing2D(selection.id, patch);
    },
    // ── By-Layer/By-Object-Quellen (Vordergrund/Hintergrund/Strichstärke/
    // Schraffur): "layer" erzwingt die Ebene, "object" erbt vom Bauteil —
    // beide löschen dabei den expliziten Wert (siehe Modell-Kommentar
    // `AttributeSource`); „eigener Wert" läuft weiterhin über die
    // onSetSelection{Foreground,Background,Weight,Fill}-Setter oben.
    onSetSelectionForegroundSource: (source) => {
      if (!selection) return;
      const patch = {
        foregroundSource: source === "layer" ? ("layer" as const) : undefined,
        foreground: undefined,
      };
      if (selection.kind === "wall") updateWall(selection.id, patch);
      else if (selection.kind === "ceiling") updateCeiling(selection.id, patch);
      else if (selection.kind === "drawing2d") updateDrawing2D(selection.id, patch);
    },
    onSetSelectionBackgroundSource: (source) => {
      if (!selection) return;
      const patch = {
        backgroundSource: source === "layer" ? ("layer" as const) : undefined,
        background: undefined,
      };
      if (selection.kind === "wall") updateWall(selection.id, patch);
      else if (selection.kind === "ceiling") updateCeiling(selection.id, patch);
      else if (selection.kind === "drawing2d") updateDrawing2D(selection.id, patch);
    },
    onSetSelectionStrokeWeightSource: (source) => {
      if (!selection) return;
      const strokeWeightSource = source === "layer" ? ("layer" as const) : undefined;
      if (selection.kind === "wall")
        updateWall(selection.id, { strokeWeightSource, strokeWeight: undefined });
      else if (selection.kind === "ceiling")
        updateCeiling(selection.id, { strokeWeightSource, strokeWeight: undefined });
      else if (selection.kind === "drawing2d")
        updateDrawing2D(selection.id, { strokeWeightSource, weightMm: undefined });
    },
    onSetSelectionHatchSource: (source) => {
      if (!selection) return;
      const hatchSource = source === "layer" ? ("layer" as const) : undefined;
      if (selection.kind === "wall")
        updateWall(selection.id, { hatchSource, hatchId: undefined });
      else if (selection.kind === "ceiling")
        updateCeiling(selection.id, { hatchSource, hatchId: undefined });
      else if (selection.kind === "drawing2d")
        updateDrawing2D(selection.id, { hatchSource, hatchId: undefined });
    },
    onResizeSelection: (w, h, anchor) => {
      if (selection?.kind === "wall" || selection?.kind === "drawing2d")
        resizeElement(selection.kind, selection.id, w, h, anchor);
    },
    onMoveSelectionBy: (dx, dy) => {
      if (!selection) return;
      if (!isFinite(dx) || !isFinite(dy) || (dx === 0 && dy === 0)) return;
      const sel2 = singleTransformSel(selection.kind, selection.id);
      if (!sel2) return;
      commitTransformOn(sel2, "move", [{ x: 0, y: 0 }, { x: dx, y: dy }], "move", 1);
    },
    // Objektinfo-Kopf: Klasse (Grafik-Kategorie) + Zeichnungsebene ändern
    // (VW-Muster „Klasse"/„Ebene"). Je Elementart der passende Store-Weg.
    onSetSelectionCategory: (code) => {
      if (!selection || !code) return;
      const id = selection.id;
      switch (selection.kind) {
        case "wall": updateWall(id, { categoryCode: code }); break;
        case "ceiling": updateCeiling(id, { categoryCode: code }); break;
        case "roof": updateRoof(id, { categoryCode: code }); break;
        case "opening": updateOpening(id, { categoryCode: code }); break;
        case "stair": updateStair(id, { categoryCode: code }); break;
        case "room": updateRoom(id, { categoryCode: code }); break;
        case "drawing2d": updateDrawing2D(id, { categoryCode: code }); break;
        case "column":
          applyChange((p) => patchItem(p, "columns", id, { categoryCode: code }));
          break;
        default: break; // extrudedSolid/door: keine Kategorie am Element
      }
    },
    onSetSelectionLevel: (levelId) => {
      if (!selection || !levelId) return;
      const id = selection.id;
      switch (selection.kind) {
        case "wall": updateWall(id, { floorId: levelId }); break;
        case "ceiling": updateCeiling(id, { floorId: levelId }); break;
        case "roof": updateRoof(id, { floorId: levelId }); break;
        case "stair": updateStair(id, { floorId: levelId }); break;
        case "room": updateRoom(id, { floorId: levelId }); break;
        case "drawing2d": updateDrawing2D(id, { levelId }); break;
        case "extrudedSolid":
          applyChange((p) => patchItem(p, "extrudedSolids", id, { levelId }));
          break;
        case "column":
          applyChange((p) => patchItem(p, "columns", id, { floorId: levelId }));
          break;
        default: break; // opening: Ebene kommt aus der Wirts-Wand
      }
    },
    onRotateSelectionAround: (cx, cy, deg) => {
      if (!selection) return;
      if (!isFinite(deg) || deg === 0) return;
      const sel2 = singleTransformSel(selection.kind, selection.id);
      if (!sel2) return;
      const rad = (deg * Math.PI) / 180;
      commitTransformOn(
        sel2,
        "rotate",
        [
          { x: cx, y: cy },
          { x: cx + 1, y: cy },
          { x: cx + Math.cos(rad), y: cy + Math.sin(rad) },
        ],
        "move",
        1,
      );
    },
    onSetDrawingLineLength: (length) => {
      if (selection?.kind !== "drawing2d" || !isFinite(length) || length <= 0) return;
      const d = project.drawings2d.find((x) => x.id === selection.id);
      if (!d || d.geom.shape !== "line") return;
      const { a, b } = d.geom;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-9) return;
      const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
      updateDrawing2D(selection.id, {
        geom: { ...d.geom, b: { x: a.x + ux * length, y: a.y + uy * length } },
      });
    },
    onSetDrawingLineAngle: (deg) => {
      if (selection?.kind !== "drawing2d" || !isFinite(deg)) return;
      const d = project.drawings2d.find((x) => x.id === selection.id);
      if (!d || d.geom.shape !== "line") return;
      const { a, b } = d.geom;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 1e-9) return;
      const rad = (deg * Math.PI) / 180;
      updateDrawing2D(selection.id, {
        geom: { ...d.geom, b: { x: a.x + Math.cos(rad) * len, y: a.y + Math.sin(rad) * len } },
      });
    },
    onSetDrawingCircleRadius: (radius) => {
      if (selection?.kind !== "drawing2d" || !isFinite(radius) || radius <= 0) return;
      const d = project.drawings2d.find((x) => x.id === selection.id);
      if (!d || d.geom.shape !== "circle") return;
      updateDrawing2D(selection.id, { geom: { ...d.geom, r: radius } });
    },
    onSetDrawingTextPaperHeight: (mm) => {
      if (selection?.kind !== "drawing2d" || !isFinite(mm) || mm < 0) return;
      const d = project.drawings2d.find((x) => x.id === selection.id);
      if (!d || d.geom.shape !== "text") return;
      const { paperHeight: _old, ...rest } = d.geom;
      updateDrawing2D(selection.id, { geom: mm > 0 ? { ...rest, paperHeight: mm } : rest });
    },
    onSetDrawingArcRadius: (radius) => {
      if (selection?.kind !== "drawing2d" || !isFinite(radius) || radius <= 0) return;
      const d = project.drawings2d.find((x) => x.id === selection.id);
      if (!d || d.geom.shape !== "arc") return;
      updateDrawing2D(selection.id, { geom: { ...d.geom, r: radius } });
    },
    onSetDrawingArcStartAngle: (deg) => {
      if (selection?.kind !== "drawing2d" || !isFinite(deg)) return;
      const d = project.drawings2d.find((x) => x.id === selection.id);
      if (!d || d.geom.shape !== "arc") return;
      updateDrawing2D(selection.id, { geom: { ...d.geom, a0: (deg * Math.PI) / 180 } });
    },
    onSetDrawingArcEndAngle: (deg) => {
      if (selection?.kind !== "drawing2d" || !isFinite(deg)) return;
      const d = project.drawings2d.find((x) => x.id === selection.id);
      if (!d || d.geom.shape !== "arc") return;
      updateDrawing2D(selection.id, { geom: { ...d.geom, a1: (deg * Math.PI) / 180 } });
    },
  } satisfies HostPart;
}

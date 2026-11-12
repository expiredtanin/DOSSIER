// Maus-Schema: Auswahl + Kontextmenü aus Grundriss / 3D. Übersetzt rohe Pick-/
// Marquee-/Kontextmenü-Events aus PlanView/Viewport3D in Selektions-Mutationen
// (+ ein paar eng verwandte Doppelklick-Trigger: Raum-Stempel-Editor, Text-
// Inhalts-Editor). Reine Verschiebung aus App.tsx, keine Verhaltensänderung.
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { opsMutation, patchItem, removeItems } from "../core";
import type { Vec2 } from "../model/types";
import type { CategoryDisplayResolver, ProjectMutation } from "../core";
import type { DisplayResolver } from "../viewport/Viewport3D";
import type { PlanSelection, MarqueeSelection } from "../views/plan/PlanView";
import type { Pick3dHit } from "../viewport/Wasm3DViewport";
import type { RichTextDoc } from "../text/richText";
import { plainText } from "../text/richText";
import { hitTestWall } from "../viewport/planHitTest";
import { hiddenElementIds } from "../model/standards";
import { getState } from "./appStore";
import type { useSelectionState } from "./useSelectionState";
import { ELEMENT_KINDS, clearKinds, fromIdLists } from "./selection";
import type { Selection, SelectionKind } from "./selection";
import type { useContextMenuState } from "../menus/useContextMenuState";
import {
  EMPTY_MEMBERSHIP,
  expandToGroups,
  isInsideActiveGroup,
  pick3dGroup,
  type GroupMembership,
  type MemberKind,
} from "./groupActions";

/** `PlanSelection`s einzelnes Treffer-Feld als (Art, ID) — oder `null` (Leerraum). */
function selHit(sel: PlanSelection): { kind: MemberKind; id: string } | null {
  if (sel.wallId) return { kind: "wallIds", id: sel.wallId };
  if (sel.drawingId) return { kind: "drawingIds", id: sel.drawingId };
  if (sel.ceilingId) return { kind: "ceilingIds", id: sel.ceilingId };
  if (sel.openingId) return { kind: "openingIds", id: sel.openingId };
  if (sel.stairId) return { kind: "stairIds", id: sel.stairId };
  if (sel.roomId) return { kind: "roomIds", id: sel.roomId };
  if (sel.columnId) return { kind: "columnIds", id: sel.columnId };
  if (sel.roofId) return { kind: "roofIds", id: sel.roofId };
  if (sel.treeId) return { kind: "treeIds", id: sel.treeId };
  return null;
}

export function useMouseSelectionHandlers(opts: {
  /** `coalesceKey`: s. `projectSlice.ts` `setProject` — von `commitTextEdit`
   *  genutzt, damit EIN Tipp-Vorgang EINEN Undo-Schritt erzeugt (wie beim
   *  Griff-Ziehen), statt bei jedem Tastendruck einen neuen zu pushen. */
  setProject: (updater: ProjectMutation, coalesceKey?: string) => void;
  activeLevelId: string;
  visibleCodes: Set<string>;
  categoryDisplay: CategoryDisplayResolver & DisplayResolver;
  /** Darstellungsmodus-Resolver je Zeichnungsebene-ID (wie categoryDisplay,
   * nur für Geschoss/Zeichnung) — sperrt Elemente einer nicht-aktiven,
   * überlagerten Ebene analog zum Kategorie-Sperren unten. */
  floorDisplay: CategoryDisplayResolver & DisplayResolver;
  selectionState: Pick<ReturnType<typeof useSelectionState>, "selection" | "setSelection" | "groupPath">;
  contextMenuState: Pick<
    ReturnType<typeof useContextMenuState>,
    "setMenu" | "editTextId" | "setEditTextId" | "setEditTextMinHeightM"
  >;
  /** [218] Fenster Objekteinstellungen mit dem Abschnitt „Raumstempel" öffnen (Doppelklick auf einen Stempel). */
  openRoomStampSettings: () => void;
}) {
  // [121] Das Projekt liest jeder Handler beim Aufruf aus dem Store (App abonniert es nicht mehr).
  const { setProject, activeLevelId, visibleCodes, categoryDisplay, floorDisplay, selectionState, contextMenuState } = opts;
  const { selection, setSelection, groupPath } = selectionState;
  const { setMenu, editTextId, setEditTextId, setEditTextMinHeightM } = contextMenuState;

  // ── Maus-Schema: Auswahl + Kontextmenü aus Grundriss / 3D ─────────────────
  // Links-Klick im Grundriss: genau eine Wand wählen (Menge ersetzen) bzw.
  // Leerraum → Auswahl löschen.
  // Doppelklick auf einen Raum-Stempel: den Raum wählen + die Objekteinstellungen mit dem Abschnitt „Raumstempel"
  // öffnen ([218], kein Dialog im Fenster mehr). Gehört der Raum schon zur Auswahl, bleibt sie (Mehrfachwerte).
  const onOpenStampEditor = (roomId: string) => {
    if (!getState().selection.rooms.includes(roomId)) setSelection({ ...clearKinds(), rooms: [roomId] });
    opts.openRoomStampSettings();
  };
  // Doppelklick auf ein Text-2D-Element: selektieren + Inhalts-Editor öffnen.
  const onEditDrawingText = (drawingId: string) => {
    const d = getState().project.drawings2d.find((x) => x.id === drawingId);
    if (!d || d.geom.shape !== "text") return;
    setSelection({ ...clearKinds(), drawings: [drawingId] });
    // Bestehendes Element per Doppelklick: keine Rahmen-Mindesthöhe (nur bei
    // frisch aufgezogener Textspalte relevant, s. textbox.ts focusMinHeightM)
    // — sonst könnte eine vorige Textspalten-Erstellung hier nachwirken.
    setEditTextMinHeightM(null);
    setEditTextId(drawingId);
  };

  // Bearbeitetes Rich-Text-Dokument übernehmen (immutabel; nur bei Text-Geometrie).
  // `text` bleibt als Reintext-Spiegel bestehen (DXF-Export, Suche, Alt-Konsumenten).
  // LIVE bei jedem Tastendruck (Inline-Editor auf der Zeichenfläche, kein Dialog
  // mehr) — schreibt AUCH einen leeren Zustand zurück (kein Guard mehr), damit
  // Löschen bis auf null Zeichen sich sofort im Modell spiegelt; das eigentliche
  // Aufräumen eines leer verlassenen NEUEN Elements übernimmt `closeTextEdit`.
  // `coalesceKey`: OHNE das würde JEDER Tastendruck einen eigenen Undo-Schritt
  // pushen (bei HISTORY_LIMIT=100 wäre nach 100 Zeichen der Stand VOR dem
  // Editieren aus dem Undo-Stack gefallen) — dasselbe Koaleszenz-Muster wie
  // beim Griff-Ziehen (`moveGripOf` & Co., s. `projectSlice.ts`).
  const commitTextEdit = (doc: RichTextDoc) => {
    const id = editTextId;
    if (!id) return;
    setProject(
      opsMutation((p) =>
        patchItem(p, "drawings2d", id, (d) =>
          d.geom.shape === "text" ? { ...d, geom: { ...d.geom, doc, text: plainText(doc) } } : d,
        ),
      ),
      `commitTextEdit:${id}`,
    );
  };

  // Inline-Editor schliessen (Backdrop-Klick/Escape): bleibt das Element leer
  // (frisch über `text`/`textbox` erzeugt, nie befüllt, oder komplett wieder
  // geleert), wird es entfernt statt als leere Leiche im Modell zu bleiben.
  const closeTextEdit = () => {
    const id = editTextId;
    if (id) {
      setProject(
        opsMutation((p) => {
          const d = p.drawings2d.find((x) => x.id === id);
          // `text` ist immer der Reintext-Spiegel von `doc` (s. commitTextEdit) —
          // reicht daher allein als Leer-Test, egal ob `doc` je gesetzt wurde.
          return d && d.geom.shape === "text" && d.geom.text.trim() === "" ? removeItems(p, "drawings2d", [id]) : [];
        }),
      );
    }
    setEditTextId(null);
    setEditTextMinHeightM(null);
  };
  // Kategorie-Code des getroffenen Elements (für die Sperr-Prüfung unten) —
  // nur die Kanäle, deren Modell-Typ eine categoryCode trägt (ExtrudedSolid/
  // Kontext-Objekte bewusst ohne, siehe deren Typdefinitionen).
  const categoryCodeOfSelection = (sel: PlanSelection): string | undefined => {
    const project = getState().project;
    if (sel.wallId) return project.walls.find((w) => w.id === sel.wallId)?.categoryCode;
    if (sel.ceilingId)
      return (project.ceilings ?? []).find((c) => c.id === sel.ceilingId)?.categoryCode;
    if (sel.openingId)
      return (project.openings ?? []).find((o) => o.id === sel.openingId)?.categoryCode;
    if (sel.stairId)
      return (project.stairs ?? []).find((s) => s.id === sel.stairId)?.categoryCode;
    if (sel.roomId) return (project.rooms ?? []).find((r) => r.id === sel.roomId)?.categoryCode;
    if (sel.columnId)
      return (project.columns ?? []).find((c) => c.id === sel.columnId)?.categoryCode;
    if (sel.roofId) return (project.roofs ?? []).find((r) => r.id === sel.roofId)?.categoryCode;
    if (sel.drawingId)
      return project.drawings2d.find((d) => d.id === sel.drawingId)?.categoryCode;
    return undefined;
  };

  // Zeichnungsebene (Geschoss/Zeichnung) des getroffenen Elements — für die
  // Sperr-Prüfung bei überlagerten (nicht-aktiven) Ebenen, s. `floorDisplay`
  // und `generateVisibleLevelsPlan`. Öffnungen gehören zur Wand (keine eigene
  // Ebenen-Referenz) — bewusst ausgelassen, wie schon bei categoryCodeOfSelection.
  const floorIdOfSelection = (sel: PlanSelection): string | undefined => {
    const project = getState().project;
    if (sel.wallId) return project.walls.find((w) => w.id === sel.wallId)?.floorId;
    if (sel.ceilingId) return (project.ceilings ?? []).find((c) => c.id === sel.ceilingId)?.floorId;
    if (sel.stairId) return (project.stairs ?? []).find((s) => s.id === sel.stairId)?.floorId;
    if (sel.roomId) return (project.rooms ?? []).find((r) => r.id === sel.roomId)?.floorId;
    if (sel.columnId) return (project.columns ?? []).find((c) => c.id === sel.columnId)?.floorId;
    if (sel.roofId) return (project.roofs ?? []).find((r) => r.id === sel.roofId)?.floorId;
    if (sel.drawingId) return project.drawings2d.find((d) => d.id === sel.drawingId)?.levelId;
    return undefined;
  };

  const onPlanSelect = (sel: PlanSelection) => {
    const project = getState().project;
    // Darstellungsmodus „Andere grau & gesperrt": ein gesperrtes Element lässt
    // sich nicht anwählen (und damit auch nicht verschieben/bearbeiten) — der
    // Klick wird ignoriert, als läge dort nichts.
    const hitCode = categoryCodeOfSelection(sel);
    if (hitCode !== undefined && categoryDisplay(hitCode).locked) return;
    // Dasselbe für eine überlagerte, nicht-aktive Zeichnungsebene (mehrere
    // Geschosse gleichzeitig sichtbar, Modus „Andere grau & gesperrt"/„Nur
    // aktive gesperrt"): das Element bleibt sichtbar, ist aber nicht anwählbar.
    const hitFloorId = floorIdOfSelection(sel);
    if (hitFloorId !== undefined && hitFloorId !== activeLevelId && floorDisplay(hitFloorId).locked)
      return;
    // Schnitt-/Ansichtslinie: dieselbe Sperr-Prüfung direkt über ihre eigene
    // Zeichnungsebene-ID (sie hat keinen Wirts-Floor wie eine Wand).
    if (sel.sectionLineId && floorDisplay(sel.sectionLineId).locked) return;
    // Gruppen-Isolation (Vectorworks „Gruppe betreten"): ausserhalb der
    // aktiven Gruppe ist alles gesperrt (gedimmt gerendert, s. PlanView) —
    // derselbe Ignorier-Kurzschluss wie beim normalen Sperren oben.
    const hit = selHit(sel);
    if (hit && !isInsideActiveGroup(project, hit.kind, hit.id, groupPath)) return;
    // Objekt-Sperre (`Wall.locked` & Co., s. `state/objectLock.ts`): bewusst
    // NICHT die Auswahl blockieren (sonst kein Weg mehr zurück zum
    // Kontextmenü-„Entsperren", sobald die Selektion einmal woanders hin
    // wechselt — Sackgasse). Ein gesperrtes Element bleibt anwähl-/
    // inspizierbar; blockiert wird die MODIFIKATION direkt an den
    // Mutations-Stellen (`moveGrip`/`moveElementBy` im Kern, `grips.rs`,
    // `deleteSelection` in App.tsx) — dieselbe Semantik wie AutoCADs
    // Layer-„Lock" (weiterhin wählbar, nicht editierbar).
    // Shift+Klick: Mehrfach-Auswahl — getroffenes Element zu-/abschalten, den
    // Rest behalten (Wände und 2D-Zeichnungen unabhängig, gemischte Auswahl
    // erlaubt). Leerraum-Klick mit Shift lässt die Auswahl unverändert.
    if (sel.shift) {
      // Je Art: Auswahl-Liste + Setter. `replaces` (Shift-Durchschalten) entfernt
      // zuerst das vorige Zwischenergebnis, bevor das neue Objekt umgeschaltet wird.
      // Shift-Art (PlanSelection) → Auswahl-Art.
      const channels = {
        section: "sectionLines",
        wall: "walls",
        drawing: "drawings",
        ceiling: "ceilings",
        opening: "openings",
        stair: "stairs",
        room: "rooms",
        solid: "solids",
        column: "columns",
        roof: "roofs",
        context: "contextObjects",
        site: "site",
        tree: "trees",
        camera: "cameras",
      } as const satisfies Record<string, SelectionKind>;
      type Kind = keyof typeof channels;
      const target: { kind: Kind; id: string } | null = sel.sectionLineId
        ? { kind: "section", id: sel.sectionLineId }
        : sel.wallId
          ? { kind: "wall", id: sel.wallId }
          : sel.drawingId
            ? { kind: "drawing", id: sel.drawingId }
            : sel.ceilingId
              ? { kind: "ceiling", id: sel.ceilingId }
              : sel.openingId
                ? { kind: "opening", id: sel.openingId }
                : sel.stairId
                  ? { kind: "stair", id: sel.stairId }
                  : sel.roomId
                    ? { kind: "room", id: sel.roomId }
                    : sel.extrudedSolidId
                      ? { kind: "solid", id: sel.extrudedSolidId }
                      : sel.treeId
                        ? { kind: "tree", id: sel.treeId }
                        : sel.cameraId
                        ? { kind: "camera", id: sel.cameraId }
                        : sel.columnId
                        ? { kind: "column", id: sel.columnId }
                        : sel.roofId
                          ? { kind: "roof", id: sel.roofId }
                          : sel.contextObjectId
                            ? { kind: "context", id: sel.contextObjectId }
                            : null;
      const rep = sel.replaces;
      const base = (kind: Kind): string[] => {
        const list = selection[channels[kind]];
        return rep && rep.kind === kind ? list.filter((x) => x !== rep.id) : [...list];
      };
      const patch: Partial<Selection> = {};
      if (rep && (!target || rep.kind !== target.kind)) patch[channels[rep.kind]] = base(rep.kind);
      if (target) {
        const list = base(target.kind);
        patch[channels[target.kind]] = list.includes(target.id) ? list.filter((x) => x !== target.id) : [...list, target.id];
      }
      setSelection(patch);
      return;
    }
    // Gruppen-Erweiterung: gehört das getroffene Element zu einer (im
    // aktuellen Isolations-Kontext sichtbaren) Gruppe, wird die GANZE Gruppe
    // gewählt statt nur dieses eine Element (Vectorworks: eine Gruppe
    // verhält sich wie ein einzelnes Objekt, bis man per Doppelklick
    // hineingeht — s. `onEnterGroup`/`groupPath`).
    if (hit) {
      const { expanded, groupIds } = expandToGroups(
        project,
        { ...EMPTY_MEMBERSHIP, [hit.kind]: [hit.id] },
        groupPath,
      );
      if (groupIds.length > 0) {
        setSelection({ ...clearKinds(), ...fromIdLists(expanded), groups: groupIds });
        return;
      }
    }
    // Ohne Shift: ersetzen. Öffnung hat Vorrang (ihr Symbol liegt in der Lücke),
    // dann Wand, dann 2D-Element, dann Decke; sonst leeren. Die Arten schließen
    // sich gegenseitig aus (alle anderen und die Gruppen werden geleert).
    const one: [SelectionKind, string] | null = sel.sectionLineId
      ? ["sectionLines", sel.sectionLineId]
      : sel.openingId
        ? ["openings", sel.openingId]
        : sel.wallId
          ? ["walls", sel.wallId]
          : sel.columnId
            ? ["columns", sel.columnId]
            : sel.drawingId
              ? ["drawings", sel.drawingId]
              : sel.extrudedSolidId
                ? ["solids", sel.extrudedSolidId]
                : sel.ceilingId
                  ? ["ceilings", sel.ceilingId]
                  : sel.stairId
                    ? ["stairs", sel.stairId]
                    : sel.roomId
                      ? ["rooms", sel.roomId]
                      : sel.roofId
                        ? ["roofs", sel.roofId]
                        : sel.contextObjectId
                          ? ["contextObjects", sel.contextObjectId]
                          : sel.siteId
                            ? ["site", sel.siteId]
                            : sel.treeId
                              ? ["trees", sel.treeId]
                              : sel.cameraId
                                ? ["cameras", sel.cameraId]
                                : null;
    setSelection({ ...clearKinds(), groups: [], ...(one ? { [one[0]]: [one[1]] } : {}) });
  };
  // Links-Drag (Marquee) im Grundriss: die getroffene Wand-MENGE übernehmen
  // (nach CAD-Konvention von PlanView bestimmt). Ersetzt die bisherige Auswahl.
  const onPlanMarquee = (sel: MarqueeSelection) => {
    const project = getState().project;
    // Objekt-Sperre: NICHT hier filtern (s. Kommentar bei `onPlanSelect`) —
    // Auswahl bleibt für gesperrte Elemente uneingeschränkt möglich, die
    // Mutations-Stellen selbst prüfen `isLocked`.
    const raw: GroupMembership = {
      wallIds: sel.wallIds,
      drawingIds: sel.drawingIds ?? [],
      ceilingIds: sel.ceilingIds ?? [],
      roomIds: sel.roomIds ?? [],
      stairIds: sel.stairIds ?? [],
      columnIds: [],
      roofIds: [],
      openingIds: [],
      treeIds: sel.treeIds ?? [],
    };
    // Gruppen-Isolation: ausserhalb der aktiven Gruppe getroffene Elemente
    // sind gesperrt (werden ignoriert), wie beim Einzelklick.
    const filtered: GroupMembership =
      groupPath.length === 0
        ? raw
        : {
            wallIds: raw.wallIds.filter((id) => isInsideActiveGroup(project, "wallIds", id, groupPath)),
            drawingIds: raw.drawingIds.filter((id) => isInsideActiveGroup(project, "drawingIds", id, groupPath)),
            ceilingIds: raw.ceilingIds.filter((id) => isInsideActiveGroup(project, "ceilingIds", id, groupPath)),
            roomIds: raw.roomIds.filter((id) => isInsideActiveGroup(project, "roomIds", id, groupPath)),
            stairIds: raw.stairIds.filter((id) => isInsideActiveGroup(project, "stairIds", id, groupPath)),
            columnIds: [],
            roofIds: [],
            openingIds: [],
            treeIds: raw.treeIds.filter((id) => isInsideActiveGroup(project, "treeIds", id, groupPath)),
          };
    // Gruppen-Erweiterung: jedes getroffene Element, das zu einer sichtbaren
    // Gruppe gehört, zieht deren ganze (transitive) Mitgliedschaft nach.
    const { expanded, groupIds } = expandToGroups(project, filtered, groupPath);
    // Öffnungen/Extrusionen/Stützen/Dächer/Kontext-Objekte sind (noch) nicht
    // Teil des Marquee (Nutzer-Report betraf nur Decken/Räume/Treppen; Stütze/
    // Dach liessen sich mit derselben `marqueeHitByField`-Mechanik ergänzen,
    // falls gewünscht) → beim Aufziehen abwählen.
    setSelection({
      ...clearKinds(),
      walls: expanded.wallIds,
      drawings: expanded.drawingIds,
      ceilings: expanded.ceilingIds,
      stairs: expanded.stairIds,
      rooms: expanded.roomIds,
      trees: expanded.treeIds,
      cameras: sel.cameraIds ?? [],
      groups: groupIds,
    });
  };
  // Rechts-Klick im Grundriss: Wand-Kontextmenü. Trifft der Klick eine Wand, die
  // NICHT bereits in der Auswahl ist, wird die Auswahl auf sie gesetzt (damit die
  // Aktionen einen Bezug haben); innerhalb einer bestehenden Mehrfachauswahl
  // bleibt die Menge erhalten.
  const onPlanContextMenu = (info: {
    clientX: number;
    clientY: number;
    model: Vec2;
  }) => {
    const project = getState().project;
    // [33] Per Regel ausgeblendete Wände sind im Grundriss nicht anwählbar (wie über den Plan-Pick).
    const wallId = hitTestWall(project, activeLevelId, visibleCodes, info.model, hiddenElementIds(project, getState().scaleDenominator));
    if (wallId && !selection.walls.includes(wallId)) setSelection({ walls: [wallId] });
    setMenu({ kind: "plan", x: info.clientX, y: info.clientY, wallId, model: info.model });
  };
  // Links-KLICK im Nordstern-3D-Viewport (WASM, TS-Raycast): getroffenes Bauteil
  // wählen, sodass das Attribute-/Objekt-Info-Panel es zeigt (erster Schritt zur
  // 3D-Editierbarkeit). `additive` (Shift/Ctrl) = zur Auswahl DERSELBEN Art
  // hinzufügen, sonst ersetzen; beim Setzen die ANDEREN Arten-Arrays leeren
  // (Einzel-Selektion über Arten hinweg, konsistent mit dem 2D-Verhalten).
  // Leertreffer (kein Bauteil) → alle Selektionen leeren.
  const onViewport3dPick = (hit: Pick3dHit, additive: boolean) => {
    const project = getState().project;
    if (!hit) {
      setSelection(clearKinds());
      return;
    }
    // [149] Gruppenmitglied: die ganze Gruppe wählen (wie der Klick im Grundriss).
    const group = additive ? null : pick3dGroup(project, hit.kind, hit.id, groupPath);
    if (group) {
      setSelection({ ...clearKinds(), ...fromIdLists(group.expanded), groups: group.groupIds });
      return;
    }
    // Öffnung (Fenster/Tür), Treppe, Kontext-Objekt, 2D-Element und Dach ersetzen
    // die Auswahl exklusiv; nur Wände und Decken unterstützen additive
    // Mehrfachauswahl (wie bisher; ein 2D-Treffer wählt auch mit Shift nur sich).
    if (hit.kind === "contextObject") {
      setSelection({ ...clearKinds(), contextObjects: [hit.id] });
      return;
    }
    if (hit.kind === "opening") {
      setSelection({ ...clearKinds(), openings: [hit.id] });
      return;
    }
    if (hit.kind === "drawing") {
      setSelection({ ...clearKinds(), drawings: [hit.id] });
      return;
    }
    if (hit.kind === "stair") {
      setSelection({ ...clearKinds(), stairs: [hit.id] });
      return;
    }
    if (hit.kind === "column") {
      setSelection({ ...clearKinds(), columns: [hit.id] });
      return;
    }
    // [149] Baum: Objekt-Info wie im Grundriss.
    if (hit.kind === "tree") {
      setSelection({ ...clearKinds(), trees: [hit.id] });
      return;
    }
    // [137] Freier Körper (Loft, Rotation, Extrusion): Objekt-Info wie im Grundriss.
    if (hit.kind === "solid") {
      setSelection({ ...clearKinds(), solids: [hit.id] });
      return;
    }
    if (hit.kind === "roof") {
      // Schnittlinien bleiben hier (wie bisher) gewählt.
      setSelection({ ...clearKinds(...ELEMENT_KINDS.filter((k) => k !== "sectionLines")), roofs: [hit.id] });
      return;
    }
    const add = (ids: string[]) => (additive ? Array.from(new Set([...ids, hit.id])) : [hit.id]);
    setSelection(
      hit.kind === "wall"
        ? { ...clearKinds(), walls: add(selection.walls) }
        : { ...clearKinds(), ceilings: add(selection.ceilings) },
    );
  };
  return {
    onOpenStampEditor,
    onEditDrawingText,
    commitTextEdit,
    closeTextEdit,
    onPlanSelect,
    onPlanMarquee,
    onPlanContextMenu,
    onViewport3dPick,
  };
}

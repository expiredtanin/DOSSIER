/**
 * Stiftsatz-Aktionen im Projekt-Store (ArchiCAD-Stiftsatz-Muster): das Backen
 * (`rebakePenColors`) selbst ist bereits in `model/penSets.test.ts` pur
 * getestet — hier geht es um die Store-spezifische Verdrahtung (Auto-Aktivieren
 * des ersten Stiftsatzes, Lösch-Schutz für den aktiven Satz, Synchron-Halten
 * der `pens`-Liste über alle Stiftsätze bei `addPen`/`deletePen`).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getState, setState } from "./appStore";
import { sampleProject } from "../model/sampleProject";

// Alle `addX`-Aktionen dieser Codebase generieren IDs über `Date.now()`
// (bestehende, projektweite Konvention) — mehrere Aufrufe in DERSELBEN
// Millisekunde (wie hier, synchron im selben Test) würden sonst kollidieren.
// Ein simpler Zähler statt echtem `Date.now()` macht jeden Aufruf eindeutig,
// ohne die Produktionslogik anzufassen.
let clock = 0;
beforeEach(() => {
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock++);
  setState({
    project: { ...sampleProject, components: sampleProject.components.slice(0, 1), pens: [], penSets: [], activePenSetId: undefined },
    undoStack: [],
    redoStack: [],
    canUndo: false,
    canRedo: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("addPenSet — erster Satz wird automatisch aktiv", () => {
  it("aktiviert den ersten je angelegten Stiftsatz automatisch", () => {
    getState().addPenSet();
    const p = getState().project;
    expect(p.penSets?.length).toBe(1);
    expect(p.activePenSetId).toBe(p.penSets![0].id);
  });

  it("aktiviert einen ZWEITEN Satz NICHT automatisch", () => {
    getState().addPenSet();
    const firstId = getState().project.activePenSetId;
    getState().addPenSet();
    expect(getState().project.activePenSetId).toBe(firstId);
    expect(getState().project.penSets?.length).toBe(2);
  });

  it("übernimmt die Farben des aktiven Satzes als Startwert für den neuen", () => {
    getState().addPenSet();
    getState().addPen();
    const penId = getState().project.pens![0].id;
    getState().patchPenSetColor(getState().project.activePenSetId!, penId, "#ff00ff");
    getState().addPenSet();
    const sets = getState().project.penSets!;
    expect(sets[1].pens[penId].color).toBe("#ff00ff");
  });
});

describe("addPen — bleibt über alle Stiftsätze deckungsgleich", () => {
  it("legt in JEDEM bestehenden Stiftsatz sofort einen Farbeintrag an", () => {
    getState().addPenSet();
    getState().addPenSet();
    getState().addPen();
    const penId = getState().project.pens![0].id;
    for (const s of getState().project.penSets!) {
      expect(s.pens[penId]).toBeDefined();
    }
  });
});

describe("setActivePenSet — bäckt gekoppelte Farben sofort neu", () => {
  it("aktualisiert ein Bauteil mit `colorPenId`, sobald der aktive Satz wechselt", () => {
    getState().addPenSet();
    getState().addPen();
    const penId = getState().project.pens![0].id;
    const setA = getState().project.activePenSetId!;
    getState().patchPenSetColor(setA, penId, "#111111");
    getState().addPenSet();
    const setB = getState().project.penSets!.find((s) => s.id !== setA)!.id;
    getState().patchPenSetColor(setB, penId, "#222222");

    const compId = getState().project.components[0].id;
    getState().patchComponent(compId, { colorPenId: penId, color: "#111111" });
    expect(getState().project.components[0].color).toBe("#111111");

    getState().setActivePenSet(setB);
    expect(getState().project.components[0].color).toBe("#222222");
  });
});

describe("patchPenSetColor — bäckt nur bei Änderung des AKTIVEN Satzes neu", () => {
  it("lässt gekoppelte Farben unverändert, wenn ein NICHT-aktiver Satz editiert wird", () => {
    getState().addPenSet();
    getState().addPen();
    const penId = getState().project.pens![0].id;
    const activeId = getState().project.activePenSetId!;
    getState().patchPenSetColor(activeId, penId, "#aaaaaa");
    const compId = getState().project.components[0].id;
    getState().patchComponent(compId, { colorPenId: penId, color: "#aaaaaa" });

    getState().addPenSet();
    const otherId = getState().project.penSets!.find((s) => s.id !== activeId)!.id;
    getState().patchPenSetColor(otherId, penId, "#bbbbbb");

    expect(getState().project.components[0].color).toBe("#aaaaaa");
  });
});

describe("patchPenSetWeight — bäckt `strokeWeight` einer gekoppelten Wand sofort neu", () => {
  it("aktualisiert die Strichstärke, wenn der editierte Satz aktiv ist", () => {
    getState().addPenSet();
    getState().addPen();
    const penId = getState().project.pens![0].id;
    const activeId = getState().project.activePenSetId!;
    const wallId = getState().project.walls[0]?.id ?? sampleProject.walls[0].id;
    getState().updateWall(wallId, { colorPenId: penId });
    getState().patchPenSetWeight(activeId, penId, 0.77);
    expect(getState().project.walls.find((w) => w.id === wallId)?.strokeWeight).toBe(0.77);
  });
});

describe("deletePenSet — Lösch-Schutz für den aktiven Satz", () => {
  it("verweigert das Löschen des aktiven Stiftsatzes", () => {
    getState().addPenSet();
    const id = getState().project.activePenSetId!;
    getState().deletePenSet(id);
    expect(getState().project.penSets?.some((s) => s.id === id)).toBe(true);
  });

  it("löscht einen NICHT-aktiven Stiftsatz anstandslos", () => {
    getState().addPenSet();
    getState().addPenSet();
    const [active, other] = getState().project.penSets!.map((s) => s.id);
    expect(getState().project.activePenSetId).toBe(active);
    getState().deletePenSet(other);
    expect(getState().project.penSets?.length).toBe(1);
  });
});

describe("deletePen — entfernt den Stift + löst betroffene Verweise, Farbe bleibt", () => {
  it("löscht den Stift aus `pens` und aus jedem Stiftsatz, klärt `colorPenId` am Bauteil, behält die zuletzt gebackene Farbe", () => {
    getState().addPenSet();
    getState().addPen();
    const penId = getState().project.pens![0].id;
    getState().patchPenSetColor(getState().project.activePenSetId!, penId, "#654321");
    const compId = getState().project.components[0].id;
    getState().patchComponent(compId, { colorPenId: penId, color: "#654321" });

    getState().deletePen(penId);

    expect(getState().project.pens?.length).toBe(0);
    expect(getState().project.penSets![0].pens[penId]).toBeUndefined();
    const comp = getState().project.components[0];
    expect(comp.colorPenId).toBeUndefined();
    expect(comp.color).toBe("#654321"); // letzte gebackene Farbe bleibt als freie Farbe
  });
});

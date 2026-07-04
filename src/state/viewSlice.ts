// View-Slice: alles, was die Darstellung steuert, ohne Modell zu sein —
// Ansichtstyp, Detailgrad, Render-Modus, Referenzlinien, aktive Zeichnungsebene,
// Massstab, Linien-Modus sowie der Darstellungsmodus je Panel. Reiner Umzug aus
// App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).
//
// Entscheidung `activeCategoryCode`: liegt hier (View), NICHT in selectionSlice.
// Es ist keine Element-Selektion, sondern die „aktive Ebene" (Arbeitsfokus für
// neue Zeichnungen / Status-Leiste) — view-seitiger Zustand wie activeLevelId.

import { sampleProject } from "../model/sampleProject";
import type { DetailLevel, RenderMode, View3d, ViewType } from "../ui/TopBar";
import type { DisplayMode } from "../panels/types";
import { DEFAULT_MARQUEE_COLOR, DEFAULT_SNAP_COLOR } from "../theme/accents";
import type { StoreApi } from "./store";

/** Standard-Darstellungsmodus je Panel (wie bisher: alles sichtbar normal). */
const DEFAULT_DISPLAY_MODE: DisplayMode = "all";

/** Felder, die diese Slice in den RootState beisteuert. */
export interface ViewSlice {
  // Aktive Zeichnungsebene (Geschoss/Schnitt/Zeichnung).
  activeLevelId: string;
  // Ansichtstyp (Grundriss / Perspektive).
  viewType: ViewType;
  // Zuletzt gewählter Ansichtstyp je Zeichnungsebene — jeder Tab merkt sich
  // seinen eigenen 2D/3D-Zustand statt eines rein globalen Umschalters.
  viewTypeByLevel: Record<string, ViewType>;
  // Detailgrad im Grundriss.
  detail: DetailLevel;
  // Render-Modus der 3D-Ansicht.
  renderMode: RenderMode;
  // Kanonischer Blickwinkel der 3D-Ansicht (Front/Top/Seite/Iso/freie Persp.).
  view3d: View3d;
  // Sichtwinkel (FOV) der 3D-Perspektivkamera in Grad.
  fov: number;
  // Boden-Referenzraster im 3D-Viewport ein-/ausgeblendet (wirkt aktuell nur
  // im Nordstern/WASM-Pfad — die three.js-Sicht zeigt ihr Raster unveraendert
  // immer; s. Wasm3DViewport.tsx).
  grid3dVisible: boolean;
  // Farb-Modus des Grundrisses: "color" = Kategorie-/Element-Farben (heute),
  // "mono" = reiner Schwarz-Weiss-Plan (Tinte, keine Farb-/Schraffurfarben).
  planColorMode: "color" | "mono";
  // Wand-Achslinien im Grundriss.
  referenceLines: boolean;
  // Linien-Darstellung: "display" = Haarlinie, "print" = echte mm-Stärken.
  lineMode: "display" | "print";
  // Gewählter (angewandter) Papier-Massstab „1:N".
  scaleDenominator: number;
  // Aktive Ebene (Kategorie-Code) — Ziel neuer Zeichnungen (Arbeitsfokus).
  activeCategoryCode: string;
  // Darstellungsmodus je Panel-ID (z. B. "drawing-levels", "layers").
  displayModes: Record<string, DisplayMode>;
  // Farbe des Auswahlrahmens (Marquee-Ziehauswahl) im Grundriss. Einstellbar
  // im Einstellungs-Fenster; Default = Akzent „Yuyake" (theme/accents.ts).
  marqueeColor: string;
  // Farbe der Snap-/Endpunkt-Hervorhebung im Grundriss (Zeichnen/Editieren).
  // Einstellbar im Einstellungs-Fenster; Default = Akzent „Sora" (vorläufig,
  // siehe HANDOVER-Rückfrage „aki").
  snapColor: string;

  setActiveLevelId: (id: string) => void;
  setViewType: (v: ViewType) => void;
  setDetail: (d: DetailLevel) => void;
  setRenderMode: (m: RenderMode) => void;
  setView3d: (v: View3d) => void;
  setFov: (n: number) => void;
  setGrid3dVisible: (b: boolean) => void;
  setPlanColorMode: (m: "color" | "mono") => void;
  setReferenceLines: (b: boolean) => void;
  setLineMode: (m: "display" | "print") => void;
  setScaleDenominator: (n: number) => void;
  setActiveCategoryCode: (code: string) => void;
  /** Darstellungsmodus eines Panels lesen (Default „all"). */
  modeFor: (id: string | null) => DisplayMode;
  /** Darstellungsmodus eines Panels setzen (No-op bei null id). */
  setModeFor: (id: string | null, mode: DisplayMode) => void;
  setMarqueeColor: (hex: string) => void;
  setSnapColor: (hex: string) => void;
}

export function createViewSlice(api: StoreApi<ViewSlice>): ViewSlice {
  const { set, get } = api;
  return {
    activeLevelId: sampleProject.drawingLevels[0].id,
    viewType: "grundriss",
    viewTypeByLevel: {},
    detail: "mittel",
    renderMode: "shaded",
    view3d: "perspective",
    fov: 50,
    grid3dVisible: true,
    planColorMode: "color",
    referenceLines: false,
    lineMode: "display",
    scaleDenominator: 100,
    activeCategoryCode:
      sampleProject.walls[0]?.categoryCode ?? sampleProject.layers[0].code,
    displayModes: {},
    marqueeColor: DEFAULT_MARQUEE_COLOR,
    snapColor: DEFAULT_SNAP_COLOR,

    setActiveLevelId: (id) =>
      set((s) => ({
        activeLevelId: id,
        viewType: s.viewTypeByLevel[id] ?? "grundriss",
      })),
    setViewType: (v) =>
      set((s) => ({
        viewType: v,
        viewTypeByLevel: { ...s.viewTypeByLevel, [s.activeLevelId]: v },
      })),
    setDetail: (d) => set({ detail: d }),
    setRenderMode: (m) => set({ renderMode: m }),
    setView3d: (v) => set({ view3d: v }),
    setFov: (n) => set({ fov: n }),
    setGrid3dVisible: (b) => set({ grid3dVisible: b }),
    setPlanColorMode: (m) => set({ planColorMode: m }),
    setReferenceLines: (b) => set({ referenceLines: b }),
    setLineMode: (m) => set({ lineMode: m }),
    setScaleDenominator: (n) => set({ scaleDenominator: n }),
    setActiveCategoryCode: (code) => set({ activeCategoryCode: code }),
    modeFor: (id) => (id && get().displayModes[id]) || DEFAULT_DISPLAY_MODE,
    setModeFor: (id, mode) => {
      if (!id) return;
      set((s) => ({ displayModes: { ...s.displayModes, [id]: mode } }));
    },
    setMarqueeColor: (hex) => set({ marqueeColor: hex }),
    setSnapColor: (hex) => set({ snapColor: hex }),
  };
}

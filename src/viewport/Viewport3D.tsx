// 3D-Viewport mit Three.js. Baut das Gebäude aus dem semantischen Modell:
// Wände als Boxen, Türen als echte Aussparungen (Segmente + Sturz).
// Es werden ALLE sichtbaren Geschosse gerendert, vertikal gestapelt nach
// ihrer baseElevation (EG bei 0, OG darüber).

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type { Ceiling, Drawing2D, Project, Roof, Vec2, Wall } from "../model/types";
import { wallVerticalExtent } from "../model/wall";
import { MaterialRuntime } from "../materials/runtime";
import { Wasm3DViewport } from "./Wasm3DViewport";
import type { Pick3dHit } from "./Wasm3DViewport";
import type { DetailLevel, RenderMode, View3d } from "../ui/TopBar";
import type { ToolDraft } from "../tools/types";
import { applyAngleConstraint } from "../tools/snapping";
import { drawingGripVertices, drawingMoveAnchor } from "./drawingGrips";
import { visibleFloorKey, updateOrthoFrustum, applyView3d } from "./viewport3d/camera";
import {
  buildContext,
  buildBuilding,
  type MatCaches,
  type BuildOpts,
  type ContextMats,
} from "./viewport3d/meshBuilders";

/**
 * Render-Entscheidung je Element (Geschoss bzw. Kategorie) im 3D — gespiegelt
 * aus dem Panel-Darstellungsmodus (vgl. ItemDisplay). `render`=false lässt das
 * Element weg, `greyed`=true zeichnet es mit gedämpftem, transparentem Material.
 */
export interface RenderDisplay {
  render: boolean;
  greyed: boolean;
}

/** Resolver: liefert je Geschoss-ID / Kategorie-Code die Render-Entscheidung. */
export type DisplayResolver = (key: string) => RenderDisplay;

/** Standard-Resolver: alles normal zeichnen (kein Greying). */
const SHOW_ALL: DisplayResolver = () => ({ render: true, greyed: false });

/** Prüft, ob WebGL im Browser verfügbar ist (kann z. B. in Firefox aus sein). */
function isWebGLAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return (
      !!window.WebGLRenderingContext &&
      !!(canvas.getContext("webgl") || canvas.getContext("experimental-webgl"))
    );
  } catch {
    return false;
  }
}

/** Rechtsklick-Info im 3D-Viewport: Viewport-Pixel + optional getroffene Wand. */
export interface ViewportContextInfo {
  clientX: number;
  clientY: number;
  /** ID der per Raycast getroffenen Wand, oder null (Leerraum/Boden). */
  wallId: string | null;
}

/**
 * Grund, warum three.js statt der wgpu-Engine aktiv ist — `null`, solange die
 * Engine läuft. Speist den fett hervorgehobenen "FALLBACK MODE"-Badge (s.
 * `ThreeViewport3D`), damit ein aktiver Fallback nie stillschweigend im
 * Browser-Devtools-Log (`console.warn`) verschwindet, sondern IM Viewport
 * sichtbar ist — sonst merkt niemand, dass man gerade den ungepflegten
 * Zweitrenderer sieht (s. PENDENZEN „3D-Elemente-Parität-Audit": three.js ist
 * bewusst kein Paritätsziel mehr, nur Notfall-Fallback).
 */
let THREE_FALLBACK_REASON: string | null = null;

/**
 * Engine-Umschalter für die 3D-Sicht. Die Engine (render3d/wgpu) ist der
 * STANDARD-3D-Renderer; three.js ist nur noch Fallback — aktiv, wenn WebGPU
 * fehlt oder explizit WebGL2 gewählt ist (`?engine=webgl2` bzw. Statusleiste →
 * localStorage `cad.rendererMode === "webgl2"`). `?engine=wasm` erzwingt weiter
 * die Engine. Einmal je Seitenladung ausgewertet: ein Wechsel läuft über einen
 * Reload (setRendererMode).
 */
const WASM_ENGINE_ACTIVE: boolean = (() => {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const fromUrl = new URLSearchParams(window.location.search).get("engine");
  const explicitWebgl2 = fromUrl ? fromUrl === "webgl2" : window.localStorage.getItem("cad.rendererMode") === "webgl2";
  const wanted = fromUrl ? fromUrl === "wasm" : !explicitWebgl2;
  if (!wanted) {
    THREE_FALLBACK_REASON = explicitWebgl2 ? "manuell auf WebGL2 gestellt" : "wgpu-Engine nicht angefragt";
    return false;
  }
  if (!("gpu" in navigator)) {
    console.warn("engine=wasm angefragt, aber navigator.gpu fehlt → three.js-Fallback (3D)");
    THREE_FALLBACK_REASON = "kein WebGPU im Browser (navigator.gpu fehlt)";
    return false;
  }
  return true;
})();

/**
 * Öffentliche 3D-Sicht: wählt zwischen der nativen Engine (render3d als
 * WASM/WebGPU, Wasm3DViewport) und der three.js-Szene (ThreeViewport3D,
 * unveränderter Standardpfad). Der Engine-Pfad ist ein Integrations-Spike und
 * nutzt vorerst nur das Projekt (Massenmodell + Orbit); alle weiteren Props
 * (Auswahl, Render-Modi, Editier-Griffe) wirken nur im three.js-Pfad.
 */
export function Viewport3D(
  props: Parameters<typeof ThreeViewport3D>[0] & {
    /** Boden-Referenzraster ein-/ausblenden — wirkt NUR im WASM-Pfad (der
     * Overlay-Umschalter sitzt im Wasm3DViewport selbst); die three.js-Sicht
     * zeigt ihr Raster unveraendert immer (kein Toggle dort). */
    gridVisible?: boolean;
    /** Klick auf den Grid-Umschalter-Button im WASM-Viewport — Single Source
     * of Truth bleibt der Aufrufer (App/viewSlice `grid3dVisible`). */
    onToggleGrid?: () => void;
    /** Links-Klick-Auswahl im WASM-Viewport (TS-Raycast) — wirkt NUR im WASM-Pfad;
     * die three.js-Sicht nutzt weiter `onSelectWall`/`onSelectCeiling`. */
    onPick3d?: (hit: Pick3dHit, additive: boolean) => void;
    /** Umriss-Linien der aktuellen Auswahl — wirkt NUR im WASM-Pfad (s.
     * Wasm3DViewport); die three.js-Sicht hebt die Auswahl weiterhin über ihr
     * eigenes Material hervor (highlightMat in ThreeViewport3D). */
    highlightLines?: Float32Array | null;
    /** Aktive 3D-Schnittebene (nur WASM-Pfad) — s. Wasm3DViewport `section3d`.
     * Bindet den Live-Schnitt an eine Grundriss-Schnittlinie. */
    section3d?: { point: [number, number, number]; normal: [number, number, number] } | null;
    /** Klick auf den gebundenen Schnitt-Knopf im WASM-Viewport → Bindung lösen. */
    onClearSection3d?: () => void;
  },
) {
  const {
    gridVisible,
    onToggleGrid,
    onPick3d,
    highlightLines,
    section3d,
    onClearSection3d,
    ...threeProps
  } = props;
  if (WASM_ENGINE_ACTIVE) {
    return (
      <Wasm3DViewport
        project={props.project}
        view3d={props.view3d}
        renderMode={props.renderMode}
        detail={props.detail}
        gridVisible={gridVisible}
        groundElevation={props.gridElevation}
        onToggleGrid={onToggleGrid}
        onPick3d={onPick3d}
        highlightLines={highlightLines}
        // 3D-Editier-Griffe (s. Wasm3DViewport.tsx): dieselben Props/Callbacks
        // wie die three.js-Sicht (renderer-agnostisch).
        editWalls={props.editWalls}
        editDrawings={props.editDrawings}
        editCeilings={props.editCeilings}
        editRoofs={props.editRoofs}
        onEditVertex={props.onEditVertex}
        onEditBody={props.onEditBody}
        onEditEdge={props.onEditEdge}
        onEditRoofPitch={props.onEditRoofPitch}
        onEditWallTop={props.onEditWallTop}
        onEditEnd={props.onEditEnd}
        section3d={section3d}
        onClearSection3d={onClearSection3d}
      />
    );
  }
  return <ThreeViewport3D {...threeProps} />;
}

function ThreeViewport3D({
  project,
  visibleCodes,
  floorDisplay = SHOW_ALL,
  categoryDisplay = SHOW_ALL,
  displayKey = "",
  renderMode = "shaded",
  view3d = "perspective",
  fov = 50,
  gridElevation = 0,
  onSelectWall,
  onSelectCeiling,
  onSelectOpening,
  onSelectStair,
  onContextMenu,
  commandActive = false,
  draft = null,
  onWorkplanePoint,
  onWorkplaneConfirm,
  editWalls = [],
  editDrawings = [],
  onEditVertex,
  onEditBody,
  onEditWallTop,
  onEditEnd,
}: {
  project: Project;
  visibleCodes: Set<string>;
  /** Z-Höhe (Meter) des Bodenrasters = OKFF/baseElevation des aktiven Geschosses. */
  gridElevation?: number;
  /**
   * Kanonischer Blickwinkel der 3D-Kamera (Vectorworks/DOSSIER-Presets):
   * front/top/side/iso/perspective. Beim Wechsel springt die Kamera auf den
   * passenden Standpunkt (formatfüllend, Modell zentriert); OrbitControls bleibt
   * danach frei nutzbar (Preset = Sprung, kein Lock).
   */
  view3d?: View3d;
  /** Sichtwinkel der Perspektivkamera in Grad (Kamera-Einstellungen). */
  fov?: number;
  /**
   * Render-Modus der 3D-Szene (Oberleiste): „shaded" = normal beleuchtet,
   * „white" = einheitliches mattes Hellgrau (Clay-Look, beleuchtet),
   * „wireframe" = Drahtgitter, „hidden" = Verdeckte Kanten (flache weiße Faces +
   * schwarze Kantenlinien, tiefen-getestet → Hidden-Line-Look). Default shaded.
   */
  renderMode?: RenderMode;
  /** Detailgrad (grob/mittel/fein) — reicht die Öffnungs-Details ins wgpu-Modell. */
  detail?: DetailLevel;
  /**
   * Render-Entscheidung je Geschoss-ID (Darstellungsmodus „Zeichnungsebenen").
   * Ohne Angabe werden alle sichtbaren Geschosse normal gezeigt.
   */
  floorDisplay?: DisplayResolver;
  /**
   * Render-Entscheidung je Kategorie-Code (Darstellungsmodus „Ebenen").
   * Ohne Angabe werden alle (sichtbaren) Kategorien normal gezeigt.
   */
  categoryDisplay?: DisplayResolver;
  /**
   * Stabiler String, der die aktuellen Display-Entscheidungen kodiert. Dient
   * nur als Effekt-Abhängigkeit, damit ein Moduswechsel den Neuaufbau auslöst
   * (die Resolver-Funktionen selbst sind nicht referenzstabil).
   */
  displayKey?: string;
  /**
   * Links-Klick (Auswahl): meldet die per Raycast getroffene Wand-ID, oder
   * null bei Klick in den Leerraum. Optional.
   */
  onSelectWall?: (wallId: string | null) => void;
  /**
   * Links-Klick (Auswahl): meldet die per Raycast getroffene Decken-ID, oder
   * null bei Klick in den Leerraum bzw. wenn eine Wand getroffen wurde. Optional.
   */
  onSelectCeiling?: (ceilingId: string | null) => void;
  /**
   * Links-Klick (Auswahl): meldet die per Raycast getroffene Öffnungs-ID
   * (Fenster/Tür), oder null bei Leerraum bzw. wenn Wand/Decke getroffen wurde.
   */
  onSelectOpening?: (openingId: string | null) => void;
  /**
   * Links-Klick (Auswahl): meldet die per Raycast getroffene Treppen-ID, oder
   * null bei Leerraum bzw. wenn Wand/Decke/Öffnung getroffen wurde.
   */
  onSelectStair?: (stairId: string | null) => void;
  /**
   * Rechts-Klick: Kontextmenü an der Cursorposition. Das Standard-Browser-Menü
   * wird immer unterdrückt; ein Rechts-Drag-Pan ist deaktiviert. Optional.
   */
  onContextMenu?: (info: ViewportContextInfo) => void;
  /**
   * Läuft gerade ein zeichnender Befehl (CommandEngine aktiv)? Dann wird der
   * 3D-Viewport zur Erstellungs-Fläche: Linksklick = Punkt auf der Arbeitsebene
   * setzen (statt Wandauswahl), Pointer-Move = Vorschau, Rechtsklick/Doppelklick =
   * bestätigen. Ohne aktiven Befehl bleibt das Verhalten unverändert (Orbit +
   * Wandauswahl + Kontextmenü).
   */
  commandActive?: boolean;
  /** Aktuelle Werkzeug-Vorschau (Rubber-Band) zum Spiegeln in 3D. */
  draft?: ToolDraft | null;
  /**
   * Punkt-Eingang in die ansichts-agnostische CommandEngine. `kind="move"` =
   * Hover-Vorschau, `kind="pick"` = Klick. `model` ist der auf die Geschoss-
   * Arbeitsebene projizierte Modell-`Vec2` (Meter).
   */
  onWorkplanePoint?: (kind: "move" | "pick", model: Vec2) => void;
  /** Befehl bestätigen/beenden (Rechtsklick/Enter/Doppelklick im 3D). */
  onWorkplaneConfirm?: () => void;
  /**
   * Alle gewählten Wände — Quelle der 3D-Editier-Griffe (Endpunkt-Kugeln +
   * Höhen-/Verschiebe-Griff). Bei Mehrfachauswahl erscheinen Griffe für ALLE,
   * damit koinzidente Ecken gemeinsam gezogen werden können. Griffe nur bei
   * inaktivem Befehl (!commandActive). Wände und 2D-Elemente schließen sich aus.
   */
  editWalls?: Wall[];
  /** Alle gewählten 2D-Elemente — Vertex-Griffe in 3D (Mehrfachauswahl ⇒ alle). */
  editDrawings?: Drawing2D[];
  /** Alle gewählten Decken — Eckpunkt-/Kanten-/Verschiebe-Griffe (nur wgpu-Sicht). */
  editCeilings?: Ceiling[];
  /**
   * Endpunkt-/Vertex-Griff gezogen: neuer XY-Modellpunkt für den Vertex `index`
   * des durch `target` benannten Elements (Wand-ID, Drawing-ID ODER Decken-ID).
   * Optional `excludeWallIds`/`excludeDrawingIds` = Koinzidenz-Gruppe, die aus den
   * Snap-Quellen genommen wird; nur dann snappt App den Punkt. Liefert den
   * effektiv angewandten (gesnappten) Punkt zurück (für Marker + Mitführen).
   */
  onEditVertex?: (
    target: { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string },
    index: number,
    model: Vec2,
    excludeWallIds?: Set<string>,
    excludeDrawingIds?: Set<string>,
  ) => Vec2;
  /** Verschiebe-Griff gezogen: das `target`-Element um `delta` (XY) verschieben. */
  onEditBody?: (
    target: { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string },
    delta: Vec2,
  ) => void;
  /** Kanten-Griff einer Decke gezogen: Kante (aIndex→bIndex) um `delta` verschieben. */
  onEditEdge?: (ceilingId: string, aIndex: number, bIndex: number, delta: Vec2) => void;
  /** Alle gewählten Dächer — Eck-/Verschiebe-/First-Griffe (nur wgpu-Sicht). */
  editRoofs?: Roof[];
  /** First-Griff gezogen: neue absolute First-Höhe (Modell-Z) → Dachneigung. */
  onEditRoofPitch?: (roofId: string, apexHeight: number) => void;
  /** Höhen-Griff gezogen: neue absolute Oberkanten-Z der Wand. */
  onEditWallTop?: (wallId: string, topZ: number) => void;
  /** Ende eines Griff-Drags (Commit/Aufräumen). */
  onEditEnd?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [unavailable, setUnavailable] = useState(false);

  // Callbacks in Refs spiegeln, damit der (schwere) Aufbau-Effekt nicht von
  // referenzwechselnden Handlern abhängt — die Listener lesen stets aktuell.
  const onSelectWallRef = useRef(onSelectWall);
  const onSelectCeilingRef = useRef(onSelectCeiling);
  const onSelectOpeningRef = useRef(onSelectOpening);
  const onSelectStairRef = useRef(onSelectStair);
  const onContextMenuRef = useRef(onContextMenu);
  onSelectWallRef.current = onSelectWall;
  onSelectCeilingRef.current = onSelectCeiling;
  onSelectOpeningRef.current = onSelectOpening;
  onSelectStairRef.current = onSelectStair;
  onContextMenuRef.current = onContextMenu;

  // Erstellungs-Modus (CommandEngine aktiv) + Punkt-Eingänge ebenfalls als Refs,
  // damit die Pointer-Listener stets den aktuellen Zustand lesen, ohne dass der
  // schwere Aufbau-Effekt neu läuft.
  const commandActiveRef = useRef(commandActive);
  const onWorkplanePointRef = useRef(onWorkplanePoint);
  const onWorkplaneConfirmRef = useRef(onWorkplaneConfirm);
  // Arbeitsebenen-Höhe (y) für den Raycast — gespiegelt, damit der Listener die
  // aktuelle Geschoss-OKFF liest (gridElevation wird ohne Neuaufbau aktualisiert).
  const gridElevationRef = useRef(gridElevation);
  commandActiveRef.current = commandActive;
  onWorkplanePointRef.current = onWorkplanePoint;
  onWorkplaneConfirmRef.current = onWorkplaneConfirm;
  gridElevationRef.current = gridElevation;

  // ── 3D-Editier-Griffe: Auswahl + Callbacks in Refs ──────────────────────────
  // Die Pointer-Listener (im schweren Aufbau-Effekt registriert) lesen die
  // aktuelle Auswahl/Callbacks über diese Refs, ohne dass die Szene neu gebaut
  // wird. Ein separater leichter Effekt zeichnet die Griff-Kugeln bei Auswahl-
  // /Modelländerung neu (drawGripsRef).
  const editWallsRef = useRef(editWalls);
  const editDrawingsRef = useRef(editDrawings);
  const onEditVertexRef = useRef(onEditVertex);
  const onEditBodyRef = useRef(onEditBody);
  const onEditWallTopRef = useRef(onEditWallTop);
  const onEditEndRef = useRef(onEditEnd);
  editWallsRef.current = editWalls;
  editDrawingsRef.current = editDrawings;
  onEditVertexRef.current = onEditVertex;
  onEditBodyRef.current = onEditBody;
  onEditWallTopRef.current = onEditWallTop;
  onEditEndRef.current = onEditEnd;
  // Vom schweren Aufbau-Effekt gesetzte Funktion, die die Griff-Kugeln aus der
  // aktuellen Auswahl neu aufbaut (ohne Szenen-Neuaufbau). Von einem leichten
  // Effekt bei Auswahl-/Modell-Änderung gerufen.
  const drawGripsRef = useRef<(() => void) | null>(null);
  // Laufender Griff-Drag — als KOMPONENTEN-Ref, damit er einen Szenen-Neuaufbau
  // (Live-Mutation des Projekts während des Ziehens ⇒ heavy effect läuft neu)
  // ÜBERLEBT. Sonst würde jeder pointermove den Drag abbrechen. Die (bei jedem
  // Aufbau neu registrierten) Pointer-Listener lesen denselben Ref weiter.
  const gripDragRef = useRef<{
    kind: "vertex" | "height" | "move";
    vertexIndex: number;
    lastModel: Vec2 | null;
    /**
     * Ortho-Anker beim Vertex-Drag (Shift): die FIXE Bezugsecke, relativ zu der
     * der gezogene Punkt auf H/V eingerastet wird (Original-Nachbarvertex bzw.
     * das andere Wandende). null = kein Anker (keine Ortho-Beschränkung möglich).
     */
    anchor: Vec2 | null;
    pointerId: number;
    /** Element, dessen Griff gezogen wird (Wand-ID ODER Drawing-ID). */
    target: { wallId?: string; drawingId?: string };
    /** Für den Höhen-Griff: die Wand-ID (OK-Z setzen). */
    wallId: string | null;
    /**
     * Koinzidente Endpunkt-Griffe ANDERER gewählter Elemente, die mitgeführt
     * werden (gemeinsame Ecke). Beim Drag-Start einmal bestimmt.
     */
    coincident: Array<{ target: { wallId?: string; drawingId?: string }; index: number }>;
    /**
     * Beim KÖRPER-Verschieben (move): koinzidente Endpunkte ANDERER gewählter
     * Elemente, die an einer Ecke des verschobenen Elements hängen. Sie wandern um
     * dasselbe Delta mit (gemeinsame Ecke bleibt verbunden). `pos` ist die LIVE
     * Position des Sibling-Vertex (inkrementell fortgeschrieben).
     */
    moveCoincident: Array<{
      target: { wallId?: string; drawingId?: string };
      index: number;
      pos: Vec2;
    }>;
    /** IDs der gesamten Koinzidenz-Gruppe (Selbst + Mitgeführte) → Snap-Ausschluss. */
    excludeWallIds: Set<string>;
    excludeDrawingIds: Set<string>;
  } | null>(null);

  // Kamera + Controls in Refs spiegeln, damit ein leichter Effekt (Blickwinkel-
  // Preset, FOV) sie ohne kompletten Szenen-Neuaufbau aktualisieren kann.
  // Es gibt ZWEI Kameras: die Perspektivkamera (Preset `perspective`) und eine
  // Orthografische (parallele) Kamera für front/top/side/iso — damit „Isometrie"
  // eine echte parallele Projektion ohne Fluchtpunkt-Verzerrung ist.
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const orthoCameraRef = useRef<THREE.OrthographicCamera | null>(null);
  // Aktuell aktive Kamera (Render-Loop + Raycast lesen diese).
  const activeCameraRef = useRef<THREE.Camera | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  // Bounding-Box der gebauten Szene (für formatfüllende Presets).
  const boundsRef = useRef<THREE.Box3 | null>(null);
  // Aktueller Blickwinkel/FOV in Refs, damit der schwere Aufbau-Effekt sie beim
  // Neuaufbau (Initialwert) liest, ohne von ihnen abzuhängen.
  const view3dRef = useRef(view3d);
  const fovRef = useRef(fov);
  // Gespiegelter Kamera-Zustand (Position + Target + Ortho-Zoom), der einen
  // Szenen-Neuaufbau ÜBERLEBT. Bei jeder Projekt-Mutation läuft der schwere
  // Aufbau-Effekt neu; ohne diesen Snapshot würde die frisch erzeugte Kamera auf
  // den Preset-Standpunkt zurückspringen (Bug: „Kamera bewegt sich beim
  // Editieren / springt in die Top-Ansicht"). Der Snapshot wird im Render-Loop
  // laufend fortgeschrieben und beim Neuaufbau als Startzustand wiederhergestellt.
  // null = noch kein Snapshot (erster Aufbau → Preset anwenden).
  const camStateRef = useRef<{
    position: THREE.Vector3;
    target: THREE.Vector3;
    up: THREE.Vector3;
    perspective: boolean;
    orthoZoom: number;
  } | null>(null);
  // Bodenraster (separat gehalten, damit es ohne Szenen-Neuaufbau auf die Höhe
  // des aktiven Geschosses (OKFF) gehoben werden kann).
  const gridRef = useRef<THREE.GridHelper | null>(null);
  // Funktion, die die 3D-Draft-Vorschau (Linien + Snap-Marker) aus einem
  // ToolDraft neu aufbaut. Vom schweren Aufbau-Effekt gesetzt, von einem leichten
  // Effekt bei `draft`-Änderung gerufen — so wird die Vorschau ohne Szenen-
  // Neuaufbau aktualisiert.
  const drawDraftRef = useRef<((d: ToolDraft | null) => void) | null>(null);
  view3dRef.current = view3d;
  fovRef.current = fov;

  useEffect(() => {
    const mount = ref.current;
    if (!mount) return;

    if (!isWebGLAvailable()) {
      setUnavailable(true);
      return;
    }

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f5f7);

    const camera = new THREE.PerspectiveCamera(fovRef.current, 1, 0.1, 1000);
    camera.position.set(8, 7, 9);
    cameraRef.current = camera;

    // Orthografische (parallele) Kamera für front/top/side/iso. Das Frustum wird
    // unten aus den Modell-Bounds + Canvas-Seitenverhältnis gesetzt; near/far
    // großzügig, damit das Modell bei jeder Distanz sicher dazwischen liegt.
    const orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 5000);
    orthoCameraRef.current = orthoCamera;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setUnavailable(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // Filmisches Tonemapping + sRGB-Ausgabe für einen fotorealistischeren,
    // nicht ausgefressenen Kontrast (ACES komprimiert Lichter sanft, statt sie
    // hart zu clippen). Belichtung leicht über 1, damit die PBR-Materialien
    // (s. u.) nicht zu dunkel wirken.
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.appendChild(renderer.domElement);

    // Neutrale Raum-Umgebung (PMREMGenerator + RoomEnvironment) als IBL-Quelle:
    // gibt MeshStandardMaterial weiche, plausible Reflexionen/Ambient-Licht,
    // ohne eine externe HDR-Datei laden zu müssen. Nur `scene.environment`
    // gesetzt (NICHT `scene.background`) — der helle Papier-Hintergrund bleibt
    // wie bisher erhalten.
    const pmremGenerator = new THREE.PMREMGenerator(renderer);
    const envRenderTarget = pmremGenerator.fromScene(new RoomEnvironment(), 0.04);
    scene.environment = envRenderTarget.texture;
    pmremGenerator.dispose();

    // OrbitControls startet an der Perspektivkamera; bei Preset-Wechsel wird
    // `.object` auf die aktive Kamera umgehängt (siehe applyView3d). Aktive
    // Kamera initial = Perspektive (wird vom Initial-Preset ggf. überschrieben).
    activeCameraRef.current = camera;
    const controls = new OrbitControls(camera, renderer.domElement);
    controlsRef.current = controls;
    // Kein Nachlauf/Trägheit — die Ansicht stoppt sofort beim Loslassen
    // (kontrollierter, weniger „verspielt"; Wunsch des Nutzers).
    controls.enableDamping = false;
    controls.target.set(2.5, 1, 2);

    // Maus-Schema (docs/design/context-menu.md): MITTE = navigieren (Orbit),
    // Shift+Mitte = Pan, RAD = Zoom, LINKS = Auswahl, RECHTS = Kontextmenü.
    // OrbitControls kennt den Shift-Modifier eingebaut: ist eine Taste auf
    // ROTATE gesetzt und Shift gedrückt, schwenkt es stattdessen (PAN). Links
    // und Rechts auf -1 (deaktiviert) → kein Orbit links, kein Pan rechts;
    // beides bedienen wir selbst (Raycast-Auswahl bzw. Kontextmenü).
    controls.mouseButtons = {
      LEFT: -1 as unknown as THREE.MOUSE,
      MIDDLE: THREE.MOUSE.ROTATE,
      RIGHT: -1 as unknown as THREE.MOUSE,
    };
    controls.enableZoom = true; // Rad-Zoom (Standard, explizit).
    controls.enablePan = true; // für Shift+Mitte.
    // Top-Ansicht ohne Orbit (senkrechter Blick bleibt gesperrt); auch nach einem
    // Szenen-Neuaufbau konsistent, da die Controls hier frisch entstehen.
    controls.enableRotate = view3dRef.current !== "top";

    // Licht — mit der Raum-Umgebung (s. o.) als weichem IBL-Ambient reichen
    // gedämpftes Umgebungslicht + eine gerichtete „Sonne" für Modellierung
    // (Schlagschatten sind hier bewusst NICHT aktiv, wie zuvor).
    scene.add(new THREE.AmbientLight(0xffffff, 0.35));
    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(6, 12, 4);
    scene.add(sun);

    // Boden + Raster — auf der Z-Höhe (OKFF) des aktiven Geschosses.
    const grid = new THREE.GridHelper(40, 40, 0xcccccc, 0xe6e6e6);
    grid.position.y = gridElevation;
    scene.add(grid);
    gridRef.current = grid;

    // Gebäude bauen — sichtbare Geschosse (gemäß floorDisplay), vertikal
    // gestapelt; je Geschoss nur Wände mit sichtbarer Kategorie (categoryDisplay).
    // Normale und gedimmte Materialien getrennt cachen.
    const mats: MatCaches = {
      normal: new Map<string, THREE.MeshStandardMaterial>(),
      greyed: new Map<string, THREE.MeshStandardMaterial>(),
      lines: new Map<string, THREE.LineBasicMaterial>(),
    };
    // Geteilte Materialien für den „Verdeckte Kanten"-Modus: flache weiße Faces
    // (polygonOffset, damit die Kantenlinien nicht z-fighten) + schwarze Kanten.
    const hiddenFace = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1,
    });
    const edgeMat = new THREE.LineBasicMaterial({ color: 0x1a1a1a });
    // „Weiss"-Modus: einheitliches mattes Hellgrau (Clay-Look) für alle Volumen.
    const whiteFace = new THREE.MeshStandardMaterial({
      color: 0xe8e8e8,
      roughness: 0.85,
      metalness: 0,
      envMapIntensity: 0.6,
    });
    // Laufzeit für PBR-Texturen (Render-Modus „textured"). Lädt Karten lazy +
    // gecacht; im Cleanup werden Texturen/Materialien freigegeben.
    const matRuntime = new MaterialRuntime();
    const opts: BuildOpts = {
      mats,
      renderMode,
      hiddenFace,
      edgeMat,
      whiteFace,
      matRuntime,
    };
    const building = buildBuilding(
      project,
      visibleCodes,
      floorDisplay,
      categoryDisplay,
      opts,
    );
    scene.add(building);

    // Kontext-Schicht (importierte Meshes, Konturen, Gelände-TIN). Eigene
    // dezente Materialien, klar vom BIM unterscheidbar. Die three-Objekte
    // entstehen erst hier aus den rohen positions/indices des Modells. Plan-
    // Konvention: Modell (x,y,z) → Three (x, z, y) (Z = Höhe nach oben).
    // CONTEXT_WIREFRAME als Flag, um das TIN als Drahtgitter zu zeigen.
    const CONTEXT_WIREFRAME = false;
    const ctxMats: ContextMats = {
      terrain: new THREE.MeshStandardMaterial({
        color: 0xa9b0a2, // gedämpftes Lehm-/Geländegrün-grau (Clay-Look)
        roughness: 0.95,
        metalness: 0,
        side: THREE.DoubleSide,
        wireframe: CONTEXT_WIREFRAME,
        flatShading: true,
        envMapIntensity: 0.5,
      }),
      mesh: new THREE.MeshStandardMaterial({
        color: 0x9fa6ae, // neutrales Hellgrau für importierte Meshes
        roughness: 0.9,
        metalness: 0,
        side: THREE.DoubleSide,
        wireframe: CONTEXT_WIREFRAME,
        envMapIntensity: 0.5,
      }),
      contour: new THREE.LineBasicMaterial({ color: 0x6b7a5a }),
    };
    const contextGroup = buildContext(project.context ?? [], ctxMats);
    scene.add(contextGroup);

    // Modell-Bounds aus den gebauten Wänden bestimmen (Boden/Raster ignorieren)
    // und den Initial-Preset anwenden, damit beim Aufbau der gewünschte
    // Blickwinkel formatfüllend sitzt.
    const bounds = new THREE.Box3();
    if (building.children.length > 0) bounds.setFromObject(building);
    // Kontext-Geometrie (Gelände/Meshes) in die Bounds einbeziehen, damit
    // Presets sie formatfüllend einrahmen — auch wenn (noch) kein Gebäude steht.
    if (contextGroup.children.length > 0) bounds.expandByObject(contextGroup);
    if (bounds.isEmpty()) bounds.set(new THREE.Vector3(0, 0, 0), new THREE.Vector3(5, 3, 5));
    boundsRef.current = bounds;

    // Aktuelles Seitenverhältnis des Canvas (für das Ortho-Frustum + Perspektiv-
    // aspect). Beim ersten Aufbau aus den Mount-Maßen abgeleitet.
    const currentAspect = () => {
      const w = mount.clientWidth || 1;
      const h = mount.clientHeight || 1;
      return w / h;
    };

    // Kamera-Standpunkt bestimmen: Beim ERSTEN Aufbau (kein Snapshot) den
    // Blickwinkel-Preset formatfüllend anwenden. Bei jedem NEUAUFBAU (z. B. weil
    // eine Griff-Mutation die Szene neu baut) den zuvor gespiegelten Kamera-
    // Zustand WIEDERHERSTELLEN, statt den Preset erneut anzuwenden — so bleibt
    // die Kamera exakt stehen (der Nutzer steuert sie allein).
    const snap = camStateRef.current;
    if (snap) {
      const active: THREE.PerspectiveCamera | THREE.OrthographicCamera =
        snap.perspective ? camera : orthoCamera;
      if (!snap.perspective) {
        updateOrthoFrustum(orthoCamera, bounds, currentAspect());
        orthoCamera.zoom = snap.orthoZoom;
      } else {
        camera.aspect = currentAspect();
      }
      active.position.copy(snap.position);
      active.up.copy(snap.up);
      active.updateProjectionMatrix();
      if (controls.object !== active) controls.object = active;
      controls.target.copy(snap.target);
      controls.update();
      activeCameraRef.current = active;
    } else {
      applyView3d(
        camera,
        orthoCamera,
        activeCameraRef,
        controls,
        bounds,
        view3dRef.current,
        currentAspect(),
      );
    }

    // Resize handhaben. updateStyle=false: die CSS-Größe steuert das Layout,
    // wir setzen nur die Renderauflösung. Nur bei echter Änderung neu setzen,
    // um Observer-Rückkopplung zu vermeiden. Sowohl das Perspektiv-aspect als
    // auch das Ortho-Frustum werden nachgeführt.
    let lastW = -1;
    let lastH = -1;
    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (w === 0 || h === 0 || (w === lastW && h === lastH)) return;
      lastW = w;
      lastH = h;
      renderer.setSize(w, h, false);
      const aspect = w / h;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      // Ortho-Frustum dem neuen Seitenverhältnis anpassen (formatfüllend),
      // ohne Position/Target zu verändern.
      updateOrthoFrustum(orthoCamera, boundsRef.current ?? bounds, aspect);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let raf = 0;
    const animate = () => {
      controls.update();
      renderer.render(scene, activeCameraRef.current ?? camera);
      // Kamera-Zustand fortlaufend spiegeln, damit ein Szenen-Neuaufbau (etwa
      // durch eine Live-Mutation beim Griff-Drag) den aktuellen Standpunkt
      // wiederherstellen kann, statt auf den Preset zurückzuspringen.
      const active = (activeCameraRef.current ?? camera) as
        | THREE.PerspectiveCamera
        | THREE.OrthographicCamera;
      const isPersp = active === camera;
      const snap = camStateRef.current;
      if (snap) {
        snap.position.copy(active.position);
        snap.target.copy(controls.target);
        snap.up.copy(active.up);
        snap.perspective = isPersp;
        snap.orthoZoom = orthoCamera.zoom;
      } else {
        camStateRef.current = {
          position: active.position.clone(),
          target: controls.target.clone(),
          up: active.up.clone(),
          perspective: isPersp,
          orthoZoom: orthoCamera.zoom,
        };
      }
      raf = requestAnimationFrame(animate);
    };
    animate();

    // ── Maus-Auswahl + Kontextmenü (Raycast) ────────────────────────────────
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

    // ── Erstellungs-Modus: Raycast auf die Arbeitsebene ─────────────────────
    // Horizontale Ebene bei y = gridElevation (OKFF des aktiven Geschosses).
    // Pointer → NDC → Strahl der AKTIVEN Kamera → Schnitt mit der Ebene → Welt-
    // punkt P → Modell-Vec2. Inverses Mapping aus addDrawing2DLines abgeleitet:
    // dort Modell (x,y) → three (x, baseElevation, y); also model.x = P.x,
    // model.y = P.z. Kein Vorzeichen-/Z-Flip.
    const workplane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const hitVec = new THREE.Vector3();
    const workplaneModel = (clientX: number, clientY: number): Vec2 | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, activeCameraRef.current ?? camera);
      // Ebene auf die aktuelle Geschoss-Höhe heben: Plane n·x + d = 0 mit
      // n=(0,1,0) → d = -y. constant = -gridElevation.
      workplane.constant = -gridElevationRef.current;
      const hit = raycaster.ray.intersectPlane(workplane, hitVec);
      if (!hit) return null; // Strahl parallel zur Ebene (Blick exakt horizontal)
      return { x: hit.x, y: hit.z };
    };

    // ── 3D-Draft-Vorschau (Linien + Snap-Marker auf der Arbeitsebene) ───────
    const draftGroup = new THREE.Group();
    draftGroup.frustumCulled = false;
    scene.add(draftGroup);
    const draftLineMat = new THREE.LineBasicMaterial({ color: 0x2f8fff });
    // Draft-Stützpunkte + Snap-Marker „immer oben" (depthTest/Write aus), damit
    // sie nie hinter Wänden verschwinden — wie die Editier-Griffe.
    const draftVertMat = new THREE.MeshBasicMaterial({
      color: 0x2f8fff,
      depthTest: false,
      depthWrite: false,
    });
    const snapMarkMat = new THREE.MeshBasicMaterial({
      color: 0xffcc44,
      depthTest: false,
      depthWrite: false,
    });
    const draftSphereGeo = new THREE.SphereGeometry(0.045, 12, 10);
    const clearDraftGroup = () => {
      for (let i = draftGroup.children.length - 1; i >= 0; i--) {
        const child = draftGroup.children[i];
        const ls = child as THREE.LineSegments;
        if (ls.isLineSegments || (child as THREE.Line).isLine) {
          (child as THREE.Line).geometry.dispose();
        }
        const m = child as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
        draftGroup.remove(child);
      }
    };
    // Modell (x,y) → three (x, y_plane, y); y leicht über der Ebene gegen Z-Fighting.
    const drawDraft = (d: ToolDraft | null) => {
      clearDraftGroup();
      if (!d) return;
      const yPlane = gridElevationRef.current + 0.012;
      const addSeg = (a: Vec2, b: Vec2) => {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute(
          "position",
          new THREE.BufferAttribute(
            new Float32Array([a.x, yPlane, a.y, b.x, yPlane, b.y]),
            3,
          ),
        );
        const line = new THREE.Line(geo, draftLineMat);
        line.frustumCulled = false;
        draftGroup.add(line);
      };
      for (const shape of d.preview) {
        if (shape.kind === "line") addSeg(shape.a, shape.b);
        else if (shape.kind === "poly") {
          for (let i = 0; i < shape.pts.length - 1; i++) addSeg(shape.pts[i], shape.pts[i + 1]);
          if (shape.closed && shape.pts.length > 2)
            addSeg(shape.pts[shape.pts.length - 1], shape.pts[0]);
        }
      }
      // Gesetzte Stützpunkte als kleine Kugeln (immer oben).
      for (const v of d.vertices) {
        const m = new THREE.Mesh(draftSphereGeo, draftVertMat);
        m.position.set(v.x, yPlane, v.y);
        m.renderOrder = 1000;
        draftGroup.add(m);
      }
      // Snap-Marker (orange Kugel) am gefangenen Punkt (immer oben).
      if (d.snap) {
        const m = new THREE.Mesh(draftSphereGeo, snapMarkMat);
        m.position.set(d.snap.point.x, yPlane, d.snap.point.y);
        m.renderOrder = 1001;
        draftGroup.add(m);
      }
    };
    drawDraftRef.current = drawDraft;
    drawDraft(draft);

    // ── 3D-Editier-Griffe (Endpunkt/Vertex, Höhe, Verschieben) ───────────────
    // Eigene Gruppe in der Szene mit Griff-Kugeln. Jede Kugel trägt in userData
    // ihren Griff-Deskriptor (kind + index + Element-ID). Wird per drawGrips aus
    // der aktuellen Auswahl (editWallsRef/editDrawingsRef) neu aufgebaut — bei
    // inaktivem Befehl. Bei Mehrfachauswahl bekommen ALLE Elemente Griffe (Basis
    // fürs gemeinsame Ziehen koinzidenter Ecken). Re-Render ohne Szenen-Neuaufbau
    // über drawGripsRef.
    const gripGroup = new THREE.Group();
    gripGroup.frustumCulled = false;
    // „Immer oben": Griff-Gruppe nach dem Rest rendern; die Materialien deaktivieren
    // den Tiefentest (s. u.), sodass die Kugeln nie hinter Wänden verschwinden.
    gripGroup.renderOrder = 999;
    scene.add(gripGroup);
    // Akzentmaterialien: Endpunkt-/Vertex-Griffe (Endpunkt-Ziehen), Höhen-Griff
    // (oben, andere Farbe) und Verschiebe-Griff (Achsmitte). depthTest=false +
    // depthWrite=false → die Kugeln werden von KEINER Geometrie verdeckt (immer
    // sichtbar, auch von hinter/unter der Wand).
    const onTop = { depthTest: false, depthWrite: false } as const;
    const gripVertMat = new THREE.MeshBasicMaterial({ color: 0xff8c1a, ...onTop });
    const gripHeightMat = new THREE.MeshBasicMaterial({ color: 0x2f8fff, ...onTop });
    const gripMoveMat = new THREE.MeshBasicMaterial({ color: 0x18b85a, ...onTop });
    const gripGeo = new THREE.SphereGeometry(0.075, 16, 12);
    // Griff-Deskriptor in userData der Kugel.
    type GripKind = "vertex" | "height" | "move";
    const clearGripGroup = () => {
      for (let i = gripGroup.children.length - 1; i >= 0; i--) {
        gripGroup.remove(gripGroup.children[i]);
      }
    };
    // Ein Griff. `target` benennt das Element (Wand-ID ODER Drawing-ID), damit
    // App den richtigen Vertex mutiert und der Drag die Koinzidenz-Gruppe findet.
    const addGrip = (
      kind: GripKind,
      index: number,
      pos: THREE.Vector3,
      target: { wallId?: string; drawingId?: string },
    ) => {
      const mat =
        kind === "height" ? gripHeightMat : kind === "move" ? gripMoveMat : gripVertMat;
      const m = new THREE.Mesh(gripGeo, mat);
      m.position.copy(pos);
      m.userData.gripKind = kind;
      m.userData.gripIndex = index;
      m.userData.gripTarget = target;
      m.frustumCulled = false;
      m.renderOrder = 1000;
      gripGroup.add(m);
    };
    // Baut die Griff-Kugeln aus der aktuellen Auswahl. Modell (x,y) → three
    // (x, z, y). Bei aktivem Befehl: keine Griffe (Erstellungs-Fläche).
    const drawGrips = () => {
      clearGripGroup();
      if (commandActiveRef.current) return;
      const walls = editWallsRef.current ?? [];
      const drawings = editDrawingsRef.current ?? [];
      for (const wall of walls) {
        // Wand-UK/OK absolut (Z) — Endpunkt-Griffe sitzen auf der UK (Boden der
        // Wand), Höhen-Griff auf der OK in der Achsmitte.
        const { zBottom, zTop } = wallVerticalExtent(project, wall);
        const tgt = { wallId: wall.id };
        addGrip("vertex", 0, new THREE.Vector3(wall.start.x, zBottom, wall.start.y), tgt);
        addGrip("vertex", 1, new THREE.Vector3(wall.end.x, zBottom, wall.end.y), tgt);
        const mid: Vec2 = {
          x: (wall.start.x + wall.end.x) / 2,
          y: (wall.start.y + wall.end.y) / 2,
        };
        addGrip("height", -1, new THREE.Vector3(mid.x, zTop, mid.y), tgt);
        // Verschiebe-Griff etwas über der UK in der Achsmitte (vom Höhen-Griff
        // farblich/​vertikal getrennt, damit die beiden nicht koinzidieren).
        addGrip("move", -1, new THREE.Vector3(mid.x, zBottom + 0.05, mid.y), tgt);
      }
      for (const drawing of drawings) {
        const verts = drawingGripVertices(drawing);
        const yPlane = gridElevationRef.current + 0.02;
        const tgt = { drawingId: drawing.id };
        verts.forEach((v, i) =>
          addGrip("vertex", i, new THREE.Vector3(v.x, yPlane, v.y), tgt),
        );
        // Verschiebe-Griff (ganzes 2D-Element bewegen) im Schwerpunkt der Ecken —
        // analog zum Wand-Verschiebe-Griff, damit 2D-Elemente auch in 3D frei
        // verschiebbar sind (nicht nur ihre einzelnen Vertices). Formen ohne
        // Vertex-Griffe (circle/arc/text) bekommen ihren Anker aus dem Geometrie-
        // Ursprung, damit auch sie einen Verschiebe-Griff erhalten.
        const anchor = drawingMoveAnchor(drawing, verts);
        if (anchor)
          addGrip("move", -1, new THREE.Vector3(anchor.x, yPlane + 0.03, anchor.y), tgt);
      }
    };
    drawGripsRef.current = drawGrips;
    drawGrips();

    // Snap-Marker für den 3D-Vertex-Drag (orange Kugel, immer oben). Wird beim
    // Drag positioniert/ein- bzw. ausgeblendet; eigene Geometrie/Material, im
    // Cleanup verworfen.
    const gripSnapMat = new THREE.MeshBasicMaterial({ color: 0xffcc44, ...onTop });
    const gripSnapGeo = new THREE.SphereGeometry(0.06, 14, 12);
    const gripSnapMarker = new THREE.Mesh(gripSnapGeo, gripSnapMat);
    gripSnapMarker.frustumCulled = false;
    gripSnapMarker.renderOrder = 1001;
    gripSnapMarker.visible = false;
    gripGroup.add(gripSnapMarker);
    // Zeigt den Snap-Marker am Modellpunkt (x,y) auf der Arbeitsebene, oder
    // blendet ihn aus (p=null).
    const showGripSnap = (p: Vec2 | null) => {
      if (!p) {
        gripSnapMarker.visible = false;
        return;
      }
      gripSnapMarker.position.set(p.x, gridElevationRef.current + 0.02, p.y);
      gripSnapMarker.visible = true;
    };

    // Per Raycast die getroffene Wand-ID bestimmen (klettert von der Mesh zur
    // userData.wallId; null bei Leerraum/Boden/Raster).
    const pickWall = (clientX: number, clientY: number): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, activeCameraRef.current ?? camera);
      const hits = raycaster.intersectObjects(building.children, true);
      for (const hit of hits) {
        const id = hit.object.userData?.wallId;
        if (typeof id === "string") return id;
      }
      return null;
    };

    // Per Raycast die getroffene Decken-ID bestimmen (userData.ceilingId). Wird
    // nur ausgewertet, wenn keine Wand getroffen wurde (Wände haben Vorrang).
    const pickCeiling = (clientX: number, clientY: number): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, activeCameraRef.current ?? camera);
      const hits = raycaster.intersectObjects(building.children, true);
      for (const hit of hits) {
        const id = hit.object.userData?.ceilingId;
        if (typeof id === "string") return id;
      }
      return null;
    };

    // Per Raycast die getroffene Öffnungs-ID bestimmen (userData.openingId).
    const pickOpening = (clientX: number, clientY: number): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, activeCameraRef.current ?? camera);
      const hits = raycaster.intersectObjects(building.children, true);
      for (const hit of hits) {
        const id = hit.object.userData?.openingId;
        if (typeof id === "string") return id;
      }
      return null;
    };

    // Per Raycast die getroffene Treppen-ID bestimmen (userData.stairId).
    const pickStair = (clientX: number, clientY: number): string | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, activeCameraRef.current ?? camera);
      const hits = raycaster.intersectObjects(building.children, true);
      for (const hit of hits) {
        const id = hit.object.userData?.stairId;
        if (typeof id === "string") return id;
      }
      return null;
    };

    // Auswahl-Hervorhebung: die Meshes der gewählten Wand mit einem geteilten
    // Highlight-Material überziehen; Originale merken und beim Wechsel/Cleanup
    // wiederherstellen. Material wird im Cleanup verworfen.
    const highlightMat = new THREE.MeshStandardMaterial({
      color: 0x5fa896,
      emissive: 0x1a655a,
      emissiveIntensity: 0.6,
      roughness: 0.6,
      metalness: 0,
      transparent: true,
      opacity: 0.92,
    });
    let selectedMeshes: THREE.Mesh[] = [];
    const restoreSelection = () => {
      for (const m of selectedMeshes) {
        const orig = m.userData?.origMaterial;
        if (orig) m.material = orig as THREE.Material;
      }
      selectedMeshes = [];
    };
    const selectWall = (wallId: string | null) => {
      restoreSelection();
      if (wallId) {
        building.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && mesh.userData?.wallId === wallId) {
            mesh.userData.origMaterial = mesh.material;
            mesh.material = highlightMat;
            selectedMeshes.push(mesh);
          }
        });
      }
      onSelectWallRef.current?.(wallId);
    };
    // Auswahl-Hervorhebung einer Decke (analog selectWall, über userData.ceilingId).
    const selectCeiling = (ceilingId: string | null) => {
      restoreSelection();
      if (ceilingId) {
        building.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && mesh.userData?.ceilingId === ceilingId) {
            mesh.userData.origMaterial = mesh.material;
            mesh.material = highlightMat;
            selectedMeshes.push(mesh);
          }
        });
      }
      onSelectCeilingRef.current?.(ceilingId);
    };
    // Auswahl-Hervorhebung einer Öffnung (über userData.openingId).
    const selectOpening = (openingId: string | null) => {
      restoreSelection();
      if (openingId) {
        building.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && mesh.userData?.openingId === openingId) {
            mesh.userData.origMaterial = mesh.material;
            mesh.material = highlightMat;
            selectedMeshes.push(mesh);
          }
        });
      }
      onSelectOpeningRef.current?.(openingId);
    };
    // Auswahl-Hervorhebung einer Treppe (über userData.stairId).
    const selectStair = (stairId: string | null) => {
      restoreSelection();
      if (stairId) {
        building.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && mesh.userData?.stairId === stairId) {
            mesh.userData.origMaterial = mesh.material;
            mesh.material = highlightMat;
            selectedMeshes.push(mesh);
          }
        });
      }
      onSelectStairRef.current?.(stairId);
    };
    // Links-Klick-Auswahl: erst Öffnung, dann Wand, dann Decke, dann Treppe;
    // Auswahlen schließen sich gegenseitig aus.
    const selectAt = (clientX: number, clientY: number) => {
      const openingId = pickOpening(clientX, clientY);
      if (openingId) {
        selectOpening(openingId);
        onSelectWallRef.current?.(null);
        onSelectCeilingRef.current?.(null);
        onSelectStairRef.current?.(null);
        return;
      }
      const wallId = pickWall(clientX, clientY);
      if (wallId) {
        selectWall(wallId);
        onSelectCeilingRef.current?.(null);
        onSelectOpeningRef.current?.(null);
        onSelectStairRef.current?.(null);
        return;
      }
      const ceilingId = pickCeiling(clientX, clientY);
      if (ceilingId) {
        selectCeiling(ceilingId);
        onSelectOpeningRef.current?.(null);
        onSelectStairRef.current?.(null);
        return;
      }
      const stairId = pickStair(clientX, clientY);
      if (stairId) {
        selectStair(stairId);
        onSelectWallRef.current?.(null);
        onSelectCeilingRef.current?.(null);
        onSelectOpeningRef.current?.(null);
        return;
      }
      // Leerraum: alle Auswahlen leeren.
      selectWall(null);
      onSelectCeilingRef.current?.(null);
      onSelectOpeningRef.current?.(null);
      onSelectStairRef.current?.(null);
    };

    // ── Griff-Raycast + Drag-Zustand ─────────────────────────────────────────
    // Der laufende Drag liegt im KOMPONENTEN-Ref gripDragRef (überlebt Neuaufbau).
    // War beim (Re-)Aufbau bereits ein Drag aktiv, OrbitControls sofort sperren,
    // damit die Geste nahtlos weiterläuft.
    if (gripDragRef.current) controls.enabled = false;
    // Vertikale Drag-Ebene durch die Wandachse (für den Höhen-Griff): die OK-Z
    // wird aus dem Schnitt des Strahls mit dieser Ebene gelesen.
    const heightPlane = new THREE.Plane();
    const heightHit = new THREE.Vector3();

    // Getroffene Griff-Kugel (oder null). Liefert ihren Deskriptor inkl. Element.
    const pickGrip = (
      clientX: number,
      clientY: number,
    ): {
      kind: GripKind;
      index: number;
      target: { wallId?: string; drawingId?: string };
    } | null => {
      if (gripGroup.children.length === 0) return null;
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, activeCameraRef.current ?? camera);
      const hits = raycaster.intersectObjects(gripGroup.children, false);
      for (const hit of hits) {
        const kind = hit.object.userData?.gripKind as GripKind | undefined;
        if (kind)
          return {
            kind,
            index: hit.object.userData?.gripIndex ?? -1,
            target: hit.object.userData?.gripTarget ?? {},
          };
      }
      return null;
    };

    // Endpunkt eines gewählten Elements an Vertex-Index `index`. Wände: 0=start,
    // 1=end. 2D-Elemente: via drawingGripVertices (gleiche Indizierung wie App).
    const vertexPointOf = (
      target: { wallId?: string; drawingId?: string },
      index: number,
    ): Vec2 | null => {
      if (target.wallId) {
        const w = (editWallsRef.current ?? []).find((x) => x.id === target.wallId);
        if (!w) return null;
        return index === 0 ? w.start : w.end;
      }
      if (target.drawingId) {
        const d = (editDrawingsRef.current ?? []).find((x) => x.id === target.drawingId);
        if (!d) return null;
        return drawingGripVertices(d)[index] ?? null;
      }
      return null;
    };

    // Ortho-Anker eines Vertex-Griffs: die FIXE Nachbarecke DESSELBEN Elements,
    // relativ zu der ein Shift-Drag auf H/V eingerastet wird. Wand: das andere
    // Ende. 2D-Element: der vorige Vertex (sonst der nächste). null, wenn es
    // keinen Nachbarn gibt.
    const anchorFor = (
      target: { wallId?: string; drawingId?: string },
      index: number,
    ): Vec2 | null => {
      if (target.wallId) return vertexPointOf(target, index === 0 ? 1 : 0);
      if (target.drawingId) {
        const d = (editDrawingsRef.current ?? []).find((x) => x.id === target.drawingId);
        if (!d) return null;
        const verts = drawingGripVertices(d);
        if (verts.length < 2) return null;
        const ref = index > 0 ? index - 1 : 1;
        return verts[ref] ?? null;
      }
      return null;
    };

    // Koinzidente Endpunkt-Griffe der ÜBRIGEN gewählten Elemente zum Punkt `p`
    // bestimmen (gemeinsame Ecke). Scope: nur unter den GEWÄHLTEN Elementen.
    // Toleranz: ~ Snap-Toleranz (tolerancePx/pxPerMeter); 2 mm Mindestabstand,
    // damit minimale Float-Abweichungen einer geteilten Ecke greifen.
    const COINCIDENT_TOL = 0.05; // m
    const findCoincident = (
      p: Vec2,
      self: { wallId?: string; drawingId?: string },
    ): Array<{ target: { wallId?: string; drawingId?: string }; index: number }> => {
      const out: Array<{ target: { wallId?: string; drawingId?: string }; index: number }> = [];
      const near = (q: Vec2) => Math.hypot(q.x - p.x, q.y - p.y) <= COINCIDENT_TOL;
      for (const w of editWallsRef.current ?? []) {
        if (w.id === self.wallId) continue;
        if (near(w.start)) out.push({ target: { wallId: w.id }, index: 0 });
        if (near(w.end)) out.push({ target: { wallId: w.id }, index: 1 });
      }
      for (const d of editDrawingsRef.current ?? []) {
        if (d.id === self.drawingId) continue;
        drawingGripVertices(d).forEach((v, i) => {
          if (near(v)) out.push({ target: { drawingId: d.id }, index: i });
        });
      }
      return out;
    };

    // Alle Eckpunkte eines Elements (Wand: start/end; 2D: Griff-Vertices) — Basis
    // für die Koinzidenz-Erkennung beim Körper-Verschieben (jede Ecke prüfen).
    const elementVertices = (target: { wallId?: string; drawingId?: string }): Vec2[] => {
      if (target.wallId) {
        const w = (editWallsRef.current ?? []).find((x) => x.id === target.wallId);
        return w ? [w.start, w.end] : [];
      }
      if (target.drawingId) {
        const d = (editDrawingsRef.current ?? []).find((x) => x.id === target.drawingId);
        return d ? drawingGripVertices(d) : [];
      }
      return [];
    };

    // Koinzidente Sibling-Vertices für ALLE Ecken des verschobenen Elements
    // sammeln (Körper-Drag). Dedupliziert je (target,index); die LIVE-Position
    // wird mitgeführt, damit das Delta inkrementell aufaddiert werden kann.
    const findMoveCoincident = (
      self: { wallId?: string; drawingId?: string },
    ): Array<{ target: { wallId?: string; drawingId?: string }; index: number; pos: Vec2 }> => {
      const seen = new Set<string>();
      const out: Array<{ target: { wallId?: string; drawingId?: string }; index: number; pos: Vec2 }> = [];
      for (const corner of elementVertices(self)) {
        for (const c of findCoincident(corner, self)) {
          const key = `${c.target.wallId ?? ""}|${c.target.drawingId ?? ""}|${c.index}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const pos = vertexPointOf(c.target, c.index);
          if (pos) out.push({ ...c, pos: { ...pos } });
        }
      }
      return out;
    };

    // Strahl auf eine vertikale Ebene durch die Wandachse projizieren → Höhen-Z.
    // Ebene: Normale waagerecht, senkrecht zur Achse, durch den Achsmittelpunkt
    // (so liegt der Cursor „an der Wand" und die vertikale Bewegung steuert die OK).
    const heightZAt = (clientX: number, clientY: number, wall: Wall): number | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, activeCameraRef.current ?? camera);
      const ux = wall.end.x - wall.start.x;
      const uy = wall.end.y - wall.start.y;
      const len = Math.hypot(ux, uy) || 1;
      // Achsrichtung in three (x,_,z) = Modell (x,_,y); Ebenen-Normale = Achse.
      const nrm = new THREE.Vector3(ux / len, 0, uy / len);
      const mid = new THREE.Vector3(
        (wall.start.x + wall.end.x) / 2,
        0,
        (wall.start.y + wall.end.y) / 2,
      );
      heightPlane.setFromNormalAndCoplanarPoint(nrm, mid);
      const hit = raycaster.ray.intersectPlane(heightPlane, heightHit);
      return hit ? hit.y : null;
    };

    // Beginnt ein Griff-Drag, falls eine Griff-Kugel getroffen wurde (Links).
    // OrbitControls bleibt ohnehin auf Links inaktiv; wir blockieren zusätzlich
    // die Selektion/den Klick auf der pointerup-Seite, solange gripDrag aktiv ist.
    const tryStartGripDrag = (e: PointerEvent): boolean => {
      if (commandActiveRef.current) return false;
      const g = pickGrip(e.clientX, e.clientY);
      if (!g) return false;
      // Koinzidenz-Gruppe nur bei Vertex-Drags: die Endpunkte der übrigen
      // gewählten Elemente, die mit dem gezogenen Punkt zusammenfallen, werden
      // mitgeführt (gemeinsame Ecke bleibt verbunden).
      let coincident: Array<{
        target: { wallId?: string; drawingId?: string };
        index: number;
      }> = [];
      if (g.kind === "vertex") {
        const self = vertexPointOf(g.target, g.index);
        if (self) coincident = findCoincident(self, g.target);
      }
      // Körper-Drag: koinzidente Enden anderer GEWÄHLTER Elemente an JEDER Ecke
      // des verschobenen Elements mitführen (gemeinsame Ecke bleibt verbunden).
      const moveCoincident =
        g.kind === "move" ? findMoveCoincident(g.target) : [];
      // Snap-Ausschluss = gesamte Koinzidenz-Gruppe (Selbst + Mitgeführte), damit
      // der Punkt nicht an sich selbst oder einem verbundenen Ende fängt.
      const excludeWallIds = new Set<string>();
      const excludeDrawingIds = new Set<string>();
      const addExclude = (t: { wallId?: string; drawingId?: string }) => {
        if (t.wallId) excludeWallIds.add(t.wallId);
        if (t.drawingId) excludeDrawingIds.add(t.drawingId);
      };
      addExclude(g.target);
      coincident.forEach((c) => addExclude(c.target));
      gripDragRef.current = {
        kind: g.kind,
        vertexIndex: g.index,
        lastModel: g.kind === "move" ? workplaneModel(e.clientX, e.clientY) : null,
        anchor: g.kind === "vertex" ? anchorFor(g.target, g.index) : null,
        wallId: g.kind === "height" ? g.target.wallId ?? null : null,
        pointerId: e.pointerId,
        target: g.target,
        coincident,
        moveCoincident,
        excludeWallIds,
        excludeDrawingIds,
      };
      controls.enabled = false; // OrbitControls aus, solange wir ziehen
      dom.setPointerCapture?.(e.pointerId);
      return true;
    };

    // Klick-Erkennung ohne Drag: Position bei pointerdown merken, bei pointerup
    // nur als Klick werten, wenn der Zeiger kaum bewegt wurde.
    let downX = 0;
    let downY = 0;
    let downButton = -1;
    const CLICK_SLOP = 4; // px
    const onPointerDownDom = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
      downButton = e.button;
      // Linksklick auf eine Griff-Kugel startet einen Editier-Drag (vor Auswahl).
      if (e.button === 0) tryStartGripDrag(e);
    };
    const onPointerUpDom = (e: PointerEvent) => {
      // Lief ein Griff-Drag, ist die Geste verbraucht: committen, KEINE Auswahl.
      if (gripDragRef.current) {
        gripDragRef.current = null;
        controls.enabled = true;
        showGripSnap(null); // Snap-Marker ausblenden
        dom.releasePointerCapture?.(e.pointerId);
        onEditEndRef.current?.();
        return;
      }
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved > CLICK_SLOP) return;
      // LINKS = Punkt setzen (Erstellungs-Modus) bzw. Auswahl (Ruhe). Kein Orbit
      // links (OrbitControls LEFT = -1), daher ist Links hier immer frei.
      if (e.button === 0 && downButton === 0) {
        if (commandActiveRef.current) {
          const m = workplaneModel(e.clientX, e.clientY);
          if (m) onWorkplanePointRef.current?.("pick", m);
        } else {
          selectAt(e.clientX, e.clientY);
        }
      }
    };
    // Pointer-Move: laufender Griff-Drag hat Vorrang (Endpunkt/Vertex/Höhe/
    // Verschieben). Sonst im Erstellungs-Modus Vorschau-Punkt an die Engine; ohne
    // aktiven Befehl unverändert (OrbitControls behandelt Mitte/Rechts selbst).
    const onPointerMoveDom = (e: PointerEvent) => {
      const drag = gripDragRef.current;
      if (drag) {
        if (drag.kind === "vertex") {
          const raw = workplaneModel(e.clientX, e.clientY);
          if (raw) {
            // Shift = Ortho-Lock: den gezogenen Punkt auf H/V gegenüber dem
            // FIXEN Anker (Nachbarecke) zwingen — Achse = die, der der Cursor
            // näher ist (applyAngleConstraint mit 90°, wie Ortho beim Zeichnen).
            // Der Lock dominiert (kein Snap), damit die Endkoordinate garantiert
            // eine Achse mit dem Anker teilt.
            const orthoLock = e.shiftKey && drag.anchor;
            const m = orthoLock
              ? applyAngleConstraint(drag.anchor!, raw, 90)
              : raw;
            // Ohne Lock: DIESELBE Snap-Logik wie die Plan-Griffe (App:
            // computeSnap mit Ausschluss der Koinzidenz-Gruppe). Mit Lock: den
            // gezwungenen Punkt direkt anwenden (kein erneutes Snappen).
            const applied = orthoLock
              ? (onEditVertexRef.current?.(drag.target, drag.vertexIndex, m) ?? m)
              : (onEditVertexRef.current?.(
                  drag.target,
                  drag.vertexIndex,
                  m,
                  drag.excludeWallIds,
                  drag.excludeDrawingIds,
                ) ?? m);
            // Snap-Marker am gesnappten Punkt, falls vom rohen Punkt verschieden.
            const snapped =
              !orthoLock && Math.hypot(applied.x - raw.x, applied.y - raw.y) > 1e-6;
            showGripSnap(snapped ? applied : null);
            // Koinzidente Endpunkte der übrigen gewählten Elemente mitführen:
            // exakt auf denselben gesnappten Punkt (snapped=false ⇒ direkt).
            for (const c of drag.coincident) {
              onEditVertexRef.current?.(c.target, c.index, applied);
            }
          }
        } else if (drag.kind === "move") {
          const m = workplaneModel(e.clientX, e.clientY);
          if (m && drag.lastModel) {
            const delta = { x: m.x - drag.lastModel.x, y: m.y - drag.lastModel.y };
            if (delta.x !== 0 || delta.y !== 0) {
              onEditBodyRef.current?.(drag.target, delta);
              // Koinzidente Sibling-Ecken um dasselbe Delta mitführen: ihre LIVE
              // Position fortschreiben und absolut neu setzen (kein Snap).
              for (const c of drag.moveCoincident) {
                c.pos = { x: c.pos.x + delta.x, y: c.pos.y + delta.y };
                onEditVertexRef.current?.(c.target, c.index, c.pos);
              }
            }
            drag.lastModel = m;
          } else if (m) {
            drag.lastModel = m;
          }
        } else if (drag.kind === "height") {
          const wall = (editWallsRef.current ?? []).find((w) => w.id === drag.wallId);
          if (wall && drag.wallId) {
            const z = heightZAt(e.clientX, e.clientY, wall);
            if (z !== null) onEditWallTopRef.current?.(drag.wallId, z);
          }
        }
        return;
      }
      if (!commandActiveRef.current) return;
      const m = workplaneModel(e.clientX, e.clientY);
      if (m) onWorkplanePointRef.current?.("move", m);
    };
    // Doppelklick im Erstellungs-Modus = bestätigen/beenden (z. B. Polylinie).
    const onDblClickDom = (e: MouseEvent) => {
      if (!commandActiveRef.current) return;
      e.preventDefault();
      onWorkplaneConfirmRef.current?.();
    };
    // RECHTS: im Erstellungs-Modus = bestätigen (kein Kontextmenü); sonst
    // Kontextmenü. Browser-Menü immer unterdrücken, Rechts-Drag-Pan ist aus.
    const onContextMenuDom = (e: MouseEvent) => {
      e.preventDefault();
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (commandActiveRef.current) {
        // Nach einem Rechts-Drag (Orbit/Pan) NICHT bestätigen.
        if (moved > CLICK_SLOP && downButton === 2) return;
        onWorkplaneConfirmRef.current?.();
        return;
      }
      const cb = onContextMenuRef.current;
      if (!cb) return;
      // Nach einem Drag (falls doch) kein Menü öffnen.
      if (moved > CLICK_SLOP && downButton === 2) return;
      cb({ clientX: e.clientX, clientY: e.clientY, wallId: pickWall(e.clientX, e.clientY) });
    };
    const dom = renderer.domElement;
    dom.addEventListener("pointerdown", onPointerDownDom);
    dom.addEventListener("pointerup", onPointerUpDom);
    dom.addEventListener("pointermove", onPointerMoveDom);
    dom.addEventListener("dblclick", onDblClickDom);
    dom.addEventListener("contextmenu", onContextMenuDom);

    return () => {
      cancelAnimationFrame(raf);
      dom.removeEventListener("pointerdown", onPointerDownDom);
      dom.removeEventListener("pointerup", onPointerUpDom);
      dom.removeEventListener("pointermove", onPointerMoveDom);
      dom.removeEventListener("dblclick", onDblClickDom);
      dom.removeEventListener("contextmenu", onContextMenuDom);
      drawDraftRef.current = null;
      clearDraftGroup();
      scene.remove(draftGroup);
      draftLineMat.dispose();
      draftVertMat.dispose();
      snapMarkMat.dispose();
      draftSphereGeo.dispose();
      // Editier-Griffe abräumen.
      drawGripsRef.current = null;
      clearGripGroup();
      scene.remove(gripGroup);
      gripVertMat.dispose();
      gripHeightMat.dispose();
      gripMoveMat.dispose();
      gripGeo.dispose();
      gripSnapMat.dispose();
      gripSnapGeo.dispose();
      restoreSelection();
      highlightMat.dispose();
      ro.disconnect();
      controls.dispose();
      controlsRef.current = null;
      cameraRef.current = null;
      orthoCameraRef.current = null;
      activeCameraRef.current = null;
      boundsRef.current = null;
      renderer.dispose();
      envRenderTarget.dispose();
      for (const m of mats.normal.values()) m.dispose();
      for (const m of mats.greyed.values()) m.dispose();
      for (const m of mats.lines.values()) m.dispose();
      hiddenFace.dispose();
      edgeMat.dispose();
      whiteFace.dispose();
      matRuntime.dispose();
      // EdgesGeometry der Hidden-Line-Kanten freigeben (Faces teilen ihre Geo
      // mit dem Mesh und werden über die Mesh-Geo unten/ohnehin verworfen).
      building.traverse((o) => {
        const seg = o as THREE.LineSegments;
        if (seg.isLineSegments) seg.geometry.dispose();
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      // Kontext-Gruppe sauber freigeben (Geometrien + geteilte Materialien).
      contextGroup.traverse((o) => {
        const seg = o as THREE.LineSegments;
        if (seg.isLineSegments) seg.geometry.dispose();
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      ctxMats.terrain.dispose();
      ctxMats.mesh.dispose();
      ctxMats.contour.dispose();
      mount.removeChild(renderer.domElement);
    };
    // Sichtbare Geschoss-IDs + sichtbare Codes als stabiler String, damit eine
    // neue Set-Instanz gleichen Inhalts den Effekt nicht unnötig neu auslöst
    // und Umschalten von Geschoss/Kategorie den Neuaufbau auslöst. displayKey
    // kodiert die aktuellen Display-Modi (Resolver sind nicht referenzstabil).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    project,
    visibleFloorKey(project),
    [...visibleCodes].sort().join(","),
    displayKey,
    renderMode,
  ]);

  // Leichter Effekt: Blickwinkel-Preset anwenden, wenn `view3d` wechselt — ohne
  // die (teure) Szene neu zu bauen. Springt die Kamera auf den Standpunkt;
  // OrbitControls bleibt danach frei.
  useEffect(() => {
    // Während eines laufenden Griff-Drags NIE die Kamera umsetzen (der Nutzer hat
    // einen Punkt „in der Hand"); der Preset wird erst nach dem Drag wirksam.
    if (gripDragRef.current) return;
    const camera = cameraRef.current;
    const orthoCamera = orthoCameraRef.current;
    const controls = controlsRef.current;
    const bounds = boundsRef.current;
    const mount = ref.current;
    if (camera && orthoCamera && controls && bounds && mount) {
      const aspect = (mount.clientWidth || 1) / (mount.clientHeight || 1);
      applyView3d(camera, orthoCamera, activeCameraRef, controls, bounds, view3d, aspect);
    }
  }, [view3d]);

  // Leichter Effekt: FOV (Sichtwinkel) der Perspektivkamera live setzen.
  useEffect(() => {
    const camera = cameraRef.current;
    if (!camera) return;
    camera.fov = fov;
    camera.updateProjectionMatrix();
  }, [fov]);

  // Leichter Effekt: Top-Ansicht sperren — in der orthografischen Draufsicht kein
  // Orbit (Rotieren), damit die Ansicht ruhig senkrecht von oben bleibt (Wunsch:
  // „am liebsten Top-View gesperrt"). Pan (Shift+Mitte) + Zoom bleiben erlaubt,
  // damit man den Ausschnitt in x/y noch verschieben kann. In allen anderen
  // Ansichten ist der Orbit wieder frei.
  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.enableRotate = view3d !== "top";
  }, [view3d]);

  // Leichter Effekt: Bodenraster auf die Z-Höhe des aktiven Geschosses heben
  // (ohne Szenen-Neuaufbau), passend zu den 2D-Zeichnungen auf derselben Höhe.
  useEffect(() => {
    if (gridRef.current) gridRef.current.position.y = gridElevation;
  }, [gridElevation]);

  // Leichter Effekt: 3D-Draft-Vorschau bei `draft`-Änderung neu zeichnen (ohne
  // Szenen-Neuaufbau). Leert die Vorschau bei null.
  useEffect(() => {
    drawDraftRef.current?.(draft);
  }, [draft]);

  // Leichter Effekt: Editier-Griffe neu zeichnen, wenn sich die Auswahl, die
  // gezogene Geometrie (Live-Mutation), der Befehlszustand oder die Geschoss-
  // höhe ändert — ohne Szenen-Neuaufbau (die Kugeln folgen so dem Element).
  useEffect(() => {
    drawGripsRef.current?.();
  }, [editWalls, editDrawings, commandActive, gridElevation]);

  return (
    <div className="viewport" ref={ref}>
      {unavailable && (
        <div className="viewport-fallback">
          <strong>3D-Ansicht nicht verfügbar</strong>
          <span>
            WebGL ist in deinem Browser deaktiviert. Der Grundriss funktioniert
            weiterhin. So aktivierst du 3D in Firefox: <code>about:config</code> →
            <code>webgl.disabled</code> auf <code>false</code> setzen.
          </span>
        </div>
      )}
      {!unavailable && (
        <div className="viewport-engine-badge" title={THREE_FALLBACK_REASON ?? undefined}>
          FALLBACK MODE
        </div>
      )}
    </div>
  );
}

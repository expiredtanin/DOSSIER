// 3D-Viewport mit Three.js. Baut das Gebäude aus dem semantischen Modell:
// Wände als Boxen, Türen als echte Aussparungen (Segmente + Sturz).
// Es werden ALLE sichtbaren Geschosse gerendert, vertikal gestapelt nach
// ihrer baseElevation (EG bei 0, OG darüber).

import type { MutableRefObject } from "react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import type {
  Ceiling,
  ContextObject,
  Drawing2D,
  DrawingLevel,
  Opening,
  Project,
  Stair,
  Vec2,
  Wall,
} from "../model/types";
import {
  flattenCategories,
  getCeilingType,
  getComponent,
  getStairType,
  getWallType,
  stairsOfFloor,
  wallTypeThickness,
} from "../model/types";
import { along, clippedBand } from "../model/geometry";
import { stairGeometry } from "../geometry/stair";
import {
  doorSymbol,
  openingInterval,
  openingVerticalExtent,
  wallAxisFrame,
} from "../geometry/opening";
import { computeJoins } from "../model/joins";
import type { WallCuts } from "../model/joins";
import {
  ceilingVerticalExtent,
  stairVerticalExtent,
  wallReferenceOffset,
  wallVerticalExtent,
} from "../model/wall";
import { MaterialRuntime } from "../materials/runtime";
import { Wasm3DViewport } from "./Wasm3DViewport";
import type { Pick3dHit } from "./Wasm3DViewport";
import type { RenderMode, View3d } from "../ui/TopBar";
import type { ToolDraft } from "../tools/types";
import { applyAngleConstraint } from "../tools/snapping";
import { drawingGripVertices, drawingMoveAnchor } from "./drawingGrips";

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
  const wanted = fromUrl
    ? fromUrl === "wasm"
    : window.localStorage.getItem("cad.rendererMode") !== "webgl2";
  if (!wanted) return false;
  if (!("gpu" in navigator)) {
    console.warn("engine=wasm angefragt, aber navigator.gpu fehlt → three.js-Fallback (3D)");
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
  },
) {
  const { gridVisible, onToggleGrid, onPick3d, highlightLines, ...threeProps } = props;
  if (WASM_ENGINE_ACTIVE) {
    return (
      <Wasm3DViewport
        project={props.project}
        view3d={props.view3d}
        renderMode={props.renderMode}
        gridVisible={gridVisible}
        groundElevation={props.gridElevation}
        onToggleGrid={onToggleGrid}
        onPick3d={onPick3d}
        highlightLines={highlightLines}
        // 3D-Editier-Griffe (s. Wasm3DViewport.tsx): dieselben Props/Callbacks
        // wie die three.js-Sicht (renderer-agnostisch).
        editWalls={props.editWalls}
        editDrawings={props.editDrawings}
        onEditVertex={props.onEditVertex}
        onEditBody={props.onEditBody}
        onEditWallTop={props.onEditWallTop}
        onEditEnd={props.onEditEnd}
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
  /**
   * Endpunkt-/Vertex-Griff gezogen: neuer XY-Modellpunkt für den Vertex `index`
   * des durch `target` benannten Elements (Wand-ID ODER Drawing-ID). Optional
   * `excludeWallIds`/`excludeDrawingIds` = Koinzidenz-Gruppe, die aus den
   * Snap-Quellen genommen wird; nur dann snappt App den Punkt. Liefert den
   * effektiv angewandten (gesnappten) Punkt zurück (für Marker + Mitführen).
   * Wird auf dieselbe Store-Action (`moveGripOf`) gelegt wie die Plan-Griffe.
   */
  onEditVertex?: (
    target: { wallId?: string; drawingId?: string },
    index: number,
    model: Vec2,
    excludeWallIds?: Set<string>,
    excludeDrawingIds?: Set<string>,
  ) => Vec2;
  /** Verschiebe-Griff gezogen: das `target`-Element um `delta` (XY) verschieben. */
  onEditBody?: (target: { wallId?: string; drawingId?: string }, delta: Vec2) => void;
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
    </div>
  );
}

/** Getrennte Material-Caches: normal und gedimmt (je Component-ID). */
interface MatCaches {
  normal: Map<string, THREE.MeshStandardMaterial>;
  greyed: Map<string, THREE.MeshStandardMaterial>;
  /** Linien-Materialien der 2D-Zeichengeometrie (Schlüssel: `farbe|greyed`). */
  lines: Map<string, THREE.LineBasicMaterial>;
}

/** Bündel der Bau-Optionen, das durch die Bau-Helfer gereicht wird. */
interface BuildOpts {
  mats: MatCaches;
  renderMode: RenderMode;
  /** Geteiltes flaches Face-Material für den Hidden-Line-Modus. */
  hiddenFace: THREE.MeshBasicMaterial;
  /** Geteiltes Kanten-Material für den Hidden-Line-Modus. */
  edgeMat: THREE.LineBasicMaterial;
  /** Geteiltes mattes helles Material für den „Weiss"-Modus (Clay-Look). */
  whiteFace: THREE.MeshStandardMaterial;
  /** Laufzeit für PBR-Texturen (Render-Modus „textured"); sonst ungenutzt. */
  matRuntime: MaterialRuntime;
}

/** Stabiler Schlüssel der sichtbaren Geschosse (IDs in Dokumentreihenfolge). */
function visibleFloorKey(project: Project): string {
  return project.drawingLevels
    .filter((l) => l.kind === "floor" && l.visible)
    .map((l) => l.id)
    .join(",");
}

/**
 * Setzt das Frustum einer OrthographicCamera so, dass die Modell-Bounds bei
 * gegebenem Canvas-Seitenverhältnis formatfüllend (mit etwas Rand) abgebildet
 * werden. Die parallele Projektion zeigt keine Fluchtpunkt-Verzerrung — die
 * Größe im Bild bestimmt allein das Frustum (nicht die Kamera-Distanz).
 *
 * Bemessung: Halb-Höhe/Halb-Breite aus dem Bounds-Radius (Diagonale/2, damit das
 * Modell aus jeder Richtung — auch iso — komplett passt), dann ans aspect
 * angepasst (an der jeweils engeren Achse). near/far bleiben fix (großzügig).
 */
function updateOrthoFrustum(
  camera: THREE.OrthographicCamera,
  bounds: THREE.Box3,
  aspect: number,
): void {
  const size = bounds.getSize(new THREE.Vector3());
  // Diagonal-Radius: deckt jede Blickrichtung (inkl. iso) formatfüllend ab.
  const radius = Math.max(0.5 * Math.hypot(size.x, size.y, size.z), 0.001);
  const margin = 1.1; // etwas Rand
  // Halb-Ausdehnungen so, dass ein 2·radius großes Quadrat ins Bild passt.
  let halfW: number;
  let halfH: number;
  if (aspect >= 1) {
    halfH = radius * margin;
    halfW = halfH * aspect;
  } else {
    halfW = radius * margin;
    halfH = halfW / aspect;
  }
  camera.left = -halfW;
  camera.right = halfW;
  camera.top = halfH;
  camera.bottom = -halfH;
  camera.updateProjectionMatrix();
}

/**
 * Wendet einen kanonischen Blickwinkel-Preset (Vectorworks/DOSSIER) an und
 * bestimmt die aktive Kamera:
 *   perspective → PerspectiveCamera (Fluchtpunkt-Projektion, FOV wirkt).
 *   front/back/side/left/top/iso/isoFrontLeft/isoBackRight/isoBackLeft →
 *     OrthographicCamera (echte parallele Projektion; „Isometrie" zeigt
 *     parallele Kanten parallel, ohne Konvergenz).
 *
 * Für die aktive Kamera: Ziel = Modell-Zentrum, Position = Zentrum + Richtung ×
 * Distanz, up=(0,1,0) (für top eine stabile up-Achse über winzigen Z-Anteil).
 * Bei der Perspektive macht die Distanz das Modell formatfüllend (Radius/FOV);
 * bei Ortho ist die Distanz nur fürs Clipping relevant (Größe macht das Frustum,
 * siehe updateOrthoFrustum) — sie wird so gewählt, dass das Modell sicher
 * zwischen near/far liegt.
 *
 * OrbitControls wird auf die aktive Kamera umgehängt (`.object`) und sein target
 * aufs Zentrum gesetzt; danach kann frei orbitiert/gezoomt/geschwenkt werden
 * (Preset = „dorthin springen", kein Lock).
 */
function applyView3d(
  camera: THREE.PerspectiveCamera,
  orthoCamera: THREE.OrthographicCamera,
  activeCameraRef: MutableRefObject<THREE.Camera | null>,
  controls: OrbitControls,
  bounds: THREE.Box3,
  view3d: View3d,
  aspect: number,
): void {
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const radius = Math.max(0.5 * Math.hypot(size.x, size.y, size.z), 0.001);

  // Blickrichtung je Preset (vom Zentrum zur Kamera, normalisiert). Kardinal-
  // Paare sind exakte Gegenrichtungen (back = -front, left = -side); die vier
  // Iso-Richtungen sind die oberen Oktanten (untere bleiben im Hochbau
  // ungenutzt) — dieselbe Achs-Konvention wie `preset_camera` in render3d/
  // src/math.rs (WASM-Pfad), s. View3d in TopBar.tsx.
  let dir: THREE.Vector3;
  switch (view3d) {
    case "front":
      dir = new THREE.Vector3(0, 0, 1);
      break;
    case "back":
      dir = new THREE.Vector3(0, 0, -1);
      break;
    case "side":
      dir = new THREE.Vector3(1, 0, 0);
      break;
    case "left":
      dir = new THREE.Vector3(-1, 0, 0);
      break;
    case "top":
      dir = new THREE.Vector3(0, 1, 0.0001); // winziger Z-Anteil → stabiles Up
      break;
    case "iso":
      dir = new THREE.Vector3(1, 1, 1).normalize();
      break;
    case "isoFrontLeft":
      dir = new THREE.Vector3(-1, 1, 1).normalize();
      break;
    case "isoBackRight":
      dir = new THREE.Vector3(1, 1, -1).normalize();
      break;
    case "isoBackLeft":
      dir = new THREE.Vector3(-1, 1, -1).normalize();
      break;
    case "perspective":
    default:
      // Heutiger 3/4-Blick (vorne-oben-rechts), etwas flacher als die Isometrie.
      dir = new THREE.Vector3(0.62, 0.5, 0.7).normalize();
      break;
  }

  const perspective = view3d === "perspective";
  const active: THREE.PerspectiveCamera | THREE.OrthographicCamera = perspective
    ? camera
    : orthoCamera;

  if (perspective) {
    // Distanz so, dass die Bounds im FOV liegen (+ Reserve).
    const half = Math.max(THREE.MathUtils.degToRad(camera.fov) * 0.5, 0.1);
    const dist = (radius / Math.sin(half)) * 1.25 + radius;
    camera.aspect = aspect;
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(center);
    camera.updateProjectionMatrix();
  } else {
    // Frustum (Größe) ans aspect anpassen; Distanz nur fürs Clipping relevant,
    // weit genug, damit das Modell sicher zwischen near (0.1) und far liegt.
    updateOrthoFrustum(orthoCamera, bounds, aspect);
    const dist = radius * 4 + 10;
    orthoCamera.position.copy(center).addScaledVector(dir, dist);
    orthoCamera.up.set(0, 1, 0);
    orthoCamera.lookAt(center);
    orthoCamera.updateProjectionMatrix();
  }

  // OrbitControls an die aktive Kamera binden. `.object` lässt sich live tauschen
  // (robuster als Neu-Erstellen: Maus-Schema/Listener bleiben erhalten); danach
  // update() für die korrekte sphärische Ausrichtung relativ zum Target.
  if (controls.object !== active) controls.object = active;
  controls.target.copy(center);
  controls.update();
  activeCameraRef.current = active;
}

/** Geteilte Materialien der Kontext-Schicht (Gelände/Mesh/Kontur). */
interface ContextMats {
  terrain: THREE.MeshStandardMaterial;
  mesh: THREE.MeshStandardMaterial;
  contour: THREE.LineBasicMaterial;
}

/**
 * Baut die Kontext-Gruppe aus `Project.context`:
 *   • TerrainMesh / ImportedMesh → BufferGeometry aus positions/indices.
 *   • ContourSet               → LineSegments je Kontur auf ihrer Z-Höhe.
 *
 * Achs-Konvention: das Modell speichert (x, y, z) mit z = Höhe; Three nutzt y als
 * Höhe. Wir bilden Modell (x,y,z) → Three (x, z, y) ab (wie die übrige Szene, in
 * der Plan-Y auf die Three-Z-Achse fällt und die Höhe auf Three-Y).
 */
function buildContext(
  context: ContextObject[],
  mats: ContextMats,
): THREE.Group {
  const group = new THREE.Group();
  for (const obj of context) {
    if (obj.type === "terrainMesh" || obj.type === "importedMesh") {
      const mesh = buildContextMesh(
        obj.positions,
        obj.indices,
        obj.type === "terrainMesh" ? mats.terrain : mats.mesh,
      );
      if (mesh) group.add(mesh);
    } else if (obj.type === "contourSet") {
      const lines = buildContourLines(obj.contours, mats.contour);
      if (lines) group.add(lines);
    }
  }
  return group;
}

/** BufferGeometry-Mesh aus rohen (x,y,z)-positions/indices; Modell→Three-Achsen. */
function buildContextMesh(
  positions: number[],
  indices: number[],
  mat: THREE.Material,
): THREE.Mesh | null {
  if (positions.length < 9 || indices.length < 3) return null;
  // Modell (x,y,z) → Three (x, z, y).
  const verts = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    verts[i] = positions[i]; // x
    verts[i + 1] = positions[i + 2]; // y(Three) = z(Modell) = Höhe
    verts[i + 2] = positions[i + 1]; // z(Three) = y(Modell)
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(verts, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return new THREE.Mesh(geo, mat);
}

/** LineSegments aller Konturen (jede Kontur als zusammenhängender Linienzug). */
function buildContourLines(
  contours: import("../model/types").Contour[],
  mat: THREE.LineBasicMaterial,
): THREE.LineSegments | null {
  const pos: number[] = [];
  for (const c of contours) {
    const n = c.pts.length;
    if (n < 2) continue;
    const segCount = c.closed ? n : n - 1;
    for (let i = 0; i < segCount; i++) {
      const a = c.pts[i];
      const b = c.pts[(i + 1) % n];
      // Modell (x,y,z=c.z) → Three (x, z, y).
      pos.push(a.x, c.z, a.y, b.x, c.z, b.y);
    }
  }
  if (pos.length === 0) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(pos), 3));
  geo.computeBoundingSphere();
  const seg = new THREE.LineSegments(geo, mat);
  seg.frustumCulled = false;
  return seg;
}

function buildBuilding(
  project: Project,
  visibleCodes: Set<string>,
  floorDisplay: DisplayResolver,
  categoryDisplay: DisplayResolver,
  opts: BuildOpts,
): THREE.Group {
  const group = new THREE.Group();
  // Geschosse gemäß Darstellungsmodus auswählen; jedes vertikal um seine
  // baseElevation versetzt stapeln. Ein gedimmtes Geschoss färbt all seine
  // Wände gedämpft ein.
  const floors = project.drawingLevels.filter((l) => l.kind === "floor");
  for (const floor of floors) {
    const d = floorDisplay(floor.id);
    if (!d.render) continue;
    buildFloor(group, project, floor, visibleCodes, categoryDisplay, d.greyed, opts);
  }
  return group;
}

/**
 * Baut ein einzelnes Geschoss in die Gruppe. Es werden nur die Wände dieses
 * Geschosses mit sichtbarer Kategorie verwendet; die Gehrung wird auf genau
 * dieser Wandmenge berechnet. Jede vertikale Koordinate wird um die
 * baseElevation des Geschosses verschoben, sodass die Geschosse stapeln.
 */
function buildFloor(
  group: THREE.Group,
  project: Project,
  floor: DrawingLevel,
  visibleCodes: Set<string>,
  categoryDisplay: DisplayResolver,
  floorGreyed: boolean,
  opts: BuildOpts,
): void {
  const baseElevation = floor.baseElevation ?? 0;
  // Sichtbarkeit wie bisher; der Kategorie-Darstellungsmodus verfeinert sie.
  const walls = project.walls.filter(
    (w) =>
      w.floorId === floor.id &&
      visibleCodes.has(w.categoryCode) &&
      categoryDisplay(w.categoryCode).render,
  );
  // Gehrungs-Schnittlinien auf der gefilterten Wandmenge berechnen, damit 3D
  // mit dem gehrten Grundriss übereinstimmt.
  const joins = computeJoins(project, walls);
  for (const wall of walls) {
    // Gedimmt, wenn das Geschoss ODER die Kategorie der Wand gedimmt ist.
    const greyed = floorGreyed || categoryDisplay(wall.categoryCode).greyed;
    const doors = project.doors.filter((d) => d.hostWallId === wall.id);
    const wallOpenings = (project.openings ?? []).filter(
      (o) => o.hostWallId === wall.id,
    );
    const cuts = joins.get(wall.id) ?? { startCut: null, endCut: null };
    addWallMeshes(group, project, wall, doors, wallOpenings, cuts, baseElevation, greyed, opts);
    // Rahmen/Glas/Blatt der Öffnungen NUR, wenn die Öffnungs-Kategorie sichtbar ist.
    for (const o of wallOpenings) {
      const oGreyed = floorGreyed || categoryDisplay(o.categoryCode).greyed;
      if (visibleCodes.has(o.categoryCode) && categoryDisplay(o.categoryCode).render) {
        addOpeningMeshes(group, project, wall, o, oGreyed, opts);
      }
    }
  }

  // Decken dieses Geschosses als extrudierte Slabs (Umriss × Dicke) an der
  // korrekten Z-Lage (OK = Geschoss-Oberkante, wächst nach unten).
  const ceilings = (project.ceilings ?? []).filter(
    (c) =>
      c.floorId === floor.id &&
      visibleCodes.has(c.categoryCode) &&
      categoryDisplay(c.categoryCode).render,
  );
  for (const ceiling of ceilings) {
    const greyed = floorGreyed || categoryDisplay(ceiling.categoryCode).greyed;
    addCeilingMesh(group, project, ceiling, greyed, opts);
  }

  // Treppen dieses Geschosses als gestufte Boxen (Tritte + Setzstufen), von der
  // Geschoss-UK bis zur nächsten Geschoss-OK aufsteigend.
  const stairs = stairsOfFloor(project, floor.id).filter(
    (s) =>
      visibleCodes.has(s.categoryCode) && categoryDisplay(s.categoryCode).render,
  );
  for (const stair of stairs) {
    const greyed = floorGreyed || categoryDisplay(stair.categoryCode).greyed;
    addStairMeshes(group, project, stair, greyed, opts);
  }

  // Freie 2D-Zeichengeometrie dieses Geschosses flach auf der Geschossebene
  // (Z = baseElevation) — z. B. ein Linien-Raster liegt auf dem Boden des Geschosses.
  const drawings = project.drawings2d.filter(
    (d) =>
      d.levelId === floor.id &&
      visibleCodes.has(d.categoryCode) &&
      categoryDisplay(d.categoryCode).render,
  );
  for (const d of drawings) {
    const greyed = floorGreyed || categoryDisplay(d.categoryCode).greyed;
    addDrawing2DLines(group, project, d, baseElevation, greyed, opts);
  }
}

/** Modellfarbe eines 2D-Zeichenelements (color → LineStyle → Kategorie). */
function drawing2DColor(project: Project, d: Drawing2D): string {
  if (d.color) return d.color;
  const ls = d.lineStyleId
    ? project.lineStyles.find((l) => l.id === d.lineStyleId)
    : undefined;
  if (ls?.color) return ls.color;
  const cat = flattenCategories(project.layers).find((c) => c.code === d.categoryCode);
  return cat?.color ?? "#888888";
}

// drawingGripVertices/drawingMoveAnchor sind nach `./drawingGrips` ausgelagert
// (gemeinsam mit Wasm3DViewport.tsx genutzt — s. dortiger Modul-Kommentar).

/** Strecken eines 2D-Zeichenelements (line/polyline/rect); andere → leer. */
function drawing2DSegments(d: Drawing2D): [Vec2, Vec2][] {
  const g = d.geom;
  const out: [Vec2, Vec2][] = [];
  if (g.shape === "line") out.push([g.a, g.b]);
  else if (g.shape === "polyline") {
    for (let i = 0; i < g.pts.length - 1; i++) out.push([g.pts[i], g.pts[i + 1]]);
    if (g.closed && g.pts.length > 2) out.push([g.pts[g.pts.length - 1], g.pts[0]]);
  } else if (g.shape === "rect") {
    const c1 = g.min, c3 = g.max;
    const c2 = { x: g.max.x, y: g.min.y }, c4 = { x: g.min.x, y: g.max.y };
    out.push([c1, c2], [c2, c3], [c3, c4], [c4, c1]);
  }
  return out;
}

/**
 * Zeichnet ein 2D-Element als flache Linien auf der Geschossebene. Plan (x,y) →
 * Three (x, baseElevation, y); ein winziger Höhen-Offset verhindert Z-Fighting mit
 * dem Boden/Raster. Material je Farbe (+ gedimmt) gecached.
 */
function addDrawing2DLines(
  group: THREE.Group,
  project: Project,
  d: Drawing2D,
  baseElevation: number,
  greyed: boolean,
  opts: BuildOpts,
): void {
  const segs = drawing2DSegments(d);
  if (segs.length === 0) return;
  const color = drawing2DColor(project, d);
  const key = `${color}|${greyed}`;
  let mat = opts.mats.lines.get(key);
  if (!mat) {
    mat = new THREE.LineBasicMaterial({
      color: new THREE.Color(color),
      transparent: greyed,
      opacity: greyed ? 0.35 : 1,
    });
    opts.mats.lines.set(key, mat);
  }
  const y = baseElevation + 0.01; // knapp über der Geschossebene (kein Z-Fighting)
  const positions = new Float32Array(segs.length * 6);
  segs.forEach(([a, b], i) => {
    positions.set([a.x, y, a.y, b.x, y, b.y], i * 6);
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.computeBoundingSphere();
  const seg = new THREE.LineSegments(geo, mat);
  // Dünne Liniengeometrie nicht vorzeitig wegcullen; Tiefentest bleibt aktiv,
  // damit Wände die bodennahen Linien korrekt verdecken (natürliche Verdeckung).
  seg.frustumCulled = false;
  group.add(seg);
}

/**
 * Wand als extrudierte Schicht-Bänder — pro Schicht ein eigenes Prisma, um
 * Türen ausgespart, mit Sturz darüber. Es wird DASSELBE gehrte Band-Polygon
 * wie im Grundriss extrudiert, sodass Ecken auch in 3D sauber stoßen.
 * `baseElevation` hebt das gesamte Geschoss vertikal an.
 */
function addWallMeshes(
  group: THREE.Group,
  project: Project,
  wall: Wall,
  doors: Project["doors"],
  wallOpenings: Opening[],
  cuts: WallCuts,
  // baseElevation wird jetzt über wallVerticalExtent (UK/OK-Auflösung) bezogen;
  // der Parameter bleibt für die Aufrufstelle erhalten, wird hier aber nicht
  // mehr direkt genutzt.
  _baseElevation: number,
  greyed: boolean,
  opts: BuildOpts,
): void {
  const wt = getWallType(project, wall);
  const total = wallTypeThickness(wt);
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);

  // Vertikale Ausdehnung (absolute Z): UK/OK aus den Wand-Attributen, sonst
  // baseElevation des Geschosses … +height (= heutiges Verhalten). Wir geben
  // die absoluten Z-Werte direkt an addLayerPrism (baseElevation dort = 0).
  const { zBottom, zTop } = wallVerticalExtent(project, wall);
  // Tür-/Sturzhöhen sind relativ zur Wand-UK definiert (Türen sitzen am Boden).
  const wallTopRel = zTop - zBottom;

  // Öffnungen (Legacy-Türen + neue Öffnungen) mit sill/head RELATIV zur Wand-UK:
  //   • Tür    — sillRel 0 … headRel = height (Segment darunter entfällt).
  //   • Fenster— sillRel = Brüstung … headRel = sillRel + height (Brüstungsmauer
  //     UNTER dem Fenster bleibt stehen, Sturz DARÜBER ebenfalls).
  const openings = [
    ...doors.map((d) => ({
      from: d.position,
      to: d.position + d.width,
      sillRel: 0,
      headRel: Math.min(d.height, wallTopRel),
    })),
    ...wallOpenings
      .map((o) => {
        const iv = openingInterval(wall, o);
        if (!iv) return null;
        const sillRel = Math.max(0, Math.min(o.sillHeight, wallTopRel));
        const headRel = Math.min(sillRel + o.height, wallTopRel);
        return { from: iv.from, to: iv.to, sillRel, headRel };
      })
      .filter((x): x is { from: number; to: number; sillRel: number; headRel: number } => x != null),
  ].sort((a, b) => a.from - b.from);

  // Referenzlinien-Versatz über die Dicke (center=0 → unverändert).
  const refOff = wallReferenceOffset(wall, total);

  // Schichten von außen (-T/2) nach innen (+T/2) stapeln, um den Referenzversatz
  // verschoben (damit die Achse bei „außen"/„innen" auf der Wandfläche liegt).
  let off = refOff - total / 2;
  for (const layer of wt.layers) {
    // Material je Modus: Hidden-Line nutzt die geteilten flachen weißen Faces,
    // „Weiss" das geteilte matte Clay-Material, „Texturiert" ein PBR-Material je
    // Fläche (s. u., daher hier null), shaded/wireframe das (ggf. gedimmte)
    // Component-Material.
    const textured = opts.renderMode === "textured";
    // Im Texturiert-Modus das (gecachte) PBR-Material des Bauteils (oder null →
    // matte Default-Farbe). Da die Seitenwand-UVs in Welt-Metern liegen und das
    // Material `repeat = 1/sizeM` trägt, gilt EIN Material für alle Flächen.
    const textureMat = textured
      ? opts.matRuntime.get(getComponent(project, layer.componentId).material)
      : null;
    // Material je Modus: Hidden-Line die geteilten flachen weißen Faces, „Weiss"
    // das matte Clay-Material, „Texturiert" das PBR-Material (sonst Fallback auf
    // das matte Component-Material — Wände ohne Textur bleiben sichtbar),
    // shaded/wireframe das (ggf. gedimmte) Component-Material.
    const mat =
      opts.renderMode === "hidden"
        ? opts.hiddenFace
        : opts.renderMode === "white"
          ? opts.whiteFace
          : textured && textureMat
            ? textureMat
            : layerMaterial(project, layer.componentId, greyed, opts);
    const offA = off;
    const offB = off + layer.thickness;

    // Vollhohe Segmente zwischen den Öffnungen. Z-Werte sind ABSOLUT (zBottom…
    // zTop); baseElevation wurde bereits in die Extent-Auflösung eingerechnet,
    // daher hier 0. Tür-/Sturzhöhen sind relativ zur Wand-UK → zBottom + rel.
    let cursor = 0;
    for (const op of openings) {
      if (op.from > cursor)
        addLayerPrism(group, wall, cursor, op.from, zBottom, zTop, offA, offB, cuts, 0, mat, opts);
      // Brüstungsmauer UNTER der Öffnung (Fenster: sillRel > 0; Tür: sillRel 0 → nichts).
      if (op.sillRel > 1e-4)
        addLayerPrism(group, wall, op.from, op.to, zBottom, zBottom + op.sillRel, offA, offB, cuts, 0, mat, opts);
      // Sturz ÜBER der Öffnung (türnahe Enden bleiben rechtwinklig).
      if (op.headRel < wallTopRel)
        addLayerPrism(group, wall, op.from, op.to, zBottom + op.headRel, zTop, offA, offB, cuts, 0, mat, opts);
      cursor = Math.max(cursor, op.to);
    }
    if (cursor < length)
      addLayerPrism(group, wall, cursor, length, zBottom, zTop, offA, offB, cuts, 0, mat, opts);

    off += layer.thickness;
  }
}

/**
 * 3D-Geometrie einer Öffnung: Rahmen (dünne Box um die lichte Öffnung) + Glas
 * (Fenster, halbtransparente Scheibe) bzw. Türblatt (Fenster: entfällt; Tür:
 * flaches Panel in geöffneter Stellung, Winkel aus swingAngle). Alle Meshes
 * tragen `userData.openingId` für die Raycast-Auswahl. Plan (x,y) → Three (x,z=y),
 * Höhe entlang Three-Y. Materialien werden je Aufruf erzeugt (leichtgewichtig).
 */
function addOpeningMeshes(
  group: THREE.Group,
  project: Project,
  wall: Wall,
  o: Opening,
  greyed: boolean,
  opts: BuildOpts,
): void {
  const iv = openingInterval(wall, o);
  if (!iv) return;
  const { u, n } = wallAxisFrame(wall);
  const total = wallTypeThickness(getWallType(project, wall));
  const refOff = wallReferenceOffset(wall, total);
  const { zBottom, zTop } = openingVerticalExtent(project, wall, o);
  const h = zTop - zBottom;
  if (h <= 1e-4) return;
  const p0 = along(wall.start, wall.end, iv.from);
  const width = iv.to - iv.from;
  const frameDepth = Math.min(o.frameThickness ?? total, total);
  const opacity = greyed ? 0.3 : 1;

  // Ein Balken (Box) entlang (u, n, y): Länge len entlang `dir` in der XZ-Ebene,
  // Querschnitt breadth×heightBox. `centerAlong` = Abstand vom p0 entlang `along`,
  // `offN` = Versatz quer (n), `y0..y1` vertikale Lage. Rotiert um Y auf die
  // Achsrichtung.
  const angle = Math.atan2(u.y, u.x); // Achswinkel in der XZ-Ebene (Plan)
  const addBar = (
    mat: THREE.Material,
    aFrom: number,
    aTo: number,
    offN: number,
    breadthN: number,
    y0: number,
    y1: number,
  ) => {
    const lenA = aTo - aFrom;
    const hy = y1 - y0;
    if (lenA <= 1e-5 || hy <= 1e-5 || breadthN <= 1e-5) return;
    const geo = new THREE.BoxGeometry(lenA, hy, breadthN);
    const mesh = new THREE.Mesh(geo, mat);
    // Mittelpunkt: entlang der Achse (aFrom+aTo)/2, quer offN, Höhe (y0+y1)/2.
    const midA = (aFrom + aTo) / 2;
    const cx = p0.x + u.x * midA + n.x * offN;
    const cz = p0.y + u.y * midA + n.y * offN;
    mesh.position.set(cx, (y0 + y1) / 2, cz);
    // Box-Länge liegt auf lokaler X → um Y auf die Plan-Achsrichtung drehen.
    // Plan-Y bildet auf Three-Z ab, daher −angle als Drehung um die Three-Y-Achse.
    mesh.rotation.y = -angle;
    mesh.userData.openingId = o.id;
    if (opts.renderMode === "hidden") {
      const edges = new THREE.EdgesGeometry(geo, 1);
      mesh.add(new THREE.LineSegments(edges, opts.edgeMat));
    }
    group.add(mesh);
  };

  // Rahmen-Material (dunkelgrau) + Glas-Material (bläulich, transparent).
  const frameMat = new THREE.MeshStandardMaterial({
    color: greyed ? 0x9aa0a6 : 0x55606c,
    roughness: 0.55,
    metalness: 0.15,
    envMapIntensity: 0.7,
    transparent: greyed,
    opacity,
  });
  const jambW = 0.05; // 5 cm Rahmenprofil
  // Vertikale Rahmenprofile an beiden Pfosten + oben/unten (nur so breit wie die
  // lichte Öffnung; sie sitzen INNERHALB der Lücke).
  addBar(frameMat, 0, jambW, refOff, frameDepth, zBottom, zTop);
  addBar(frameMat, width - jambW, width, refOff, frameDepth, zBottom, zTop);
  addBar(frameMat, jambW, width - jambW, refOff, frameDepth, zTop - jambW, zTop);
  addBar(frameMat, jambW, width - jambW, refOff, frameDepth, zBottom, zBottom + jambW);

  if (o.kind === "window") {
    // Glasscheibe in der Wandmitte, zwischen den Rahmenprofilen.
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x9fc4e8,
      roughness: 0.08,
      metalness: 0,
      envMapIntensity: 1,
      transparent: true,
      opacity: greyed ? 0.18 : 0.35,
      depthWrite: false,
    });
    addBar(
      glassMat,
      jambW,
      width - jambW,
      refOff,
      Math.min(0.02, frameDepth * 0.4),
      zBottom + jambW,
      zTop - jambW,
    );
    return;
  }

  // Tür: flaches Blatt in geöffneter Stellung. Anschlag am Scharnier-Pfosten,
  // gedreht um swingAngle in die Aufschlagrichtung. Das Blatt liegt VERTIKAL vom
  // Boden (zBottom) bis zTop; sein Grundriss-Verlauf folgt der doorSymbol-Achse.
  const sym = doorSymbol(wall, o);
  if (!sym) return;
  const leafMat = new THREE.MeshStandardMaterial({
    color: greyed ? 0xb0b4b8 : 0x8a6f57,
    roughness: 0.75,
    metalness: 0,
    envMapIntensity: 0.6,
    transparent: greyed,
    opacity,
  });
  // Blatt als dünne Box zwischen hinge und openEnd (im Grundriss), vertikal
  // extrudiert. Länge = Türbreite, Dicke ~4 cm.
  const dx = sym.openEnd.x - sym.hinge.x;
  const dz = sym.openEnd.y - sym.hinge.y;
  const leafLen = Math.hypot(dx, dz);
  if (leafLen <= 1e-4) return;
  const leafAngle = Math.atan2(dz, dx);
  const leafGeo = new THREE.BoxGeometry(leafLen, zTop - zBottom, 0.04);
  const leaf = new THREE.Mesh(leafGeo, leafMat);
  leaf.position.set(
    sym.hinge.x + dx / 2,
    (zBottom + zTop) / 2,
    sym.hinge.y + dz / 2,
  );
  leaf.rotation.y = -leafAngle;
  leaf.userData.openingId = o.id;
  if (opts.renderMode === "hidden") {
    const edges = new THREE.EdgesGeometry(leafGeo, 1);
    leaf.add(new THREE.LineSegments(edges, opts.edgeMat));
  }
  group.add(leaf);
}

/**
 * MeshStandardMaterial pro Component-ID gecached (3D-Farbe = component.color).
 * Rauigkeit hoch (mattes Putz-/Wandbild), keine Metallizität — passend für
 * Wände/Decken. Gedimmte Variante: Bauteilfarbe Richtung Grau gemischt +
 * transparent, damit gedimmte Geschosse/Kategorien als „andere" sichtbar,
 * aber zurückgenommen sind.
 */
function layerMaterial(
  project: Project,
  componentId: string,
  greyed: boolean,
  opts: BuildOpts,
): THREE.MeshStandardMaterial {
  const { mats } = opts;
  // Drahtgitter: Component-Material mit wireframe=true. Wird mitgecacht; da der
  // Render-Modus den gesamten Szenen-Neuaufbau auslöst, ist der Cache pro Modus
  // konsistent (die Caches leben innerhalb des Aufbau-Effekts).
  const wireframe = opts.renderMode === "wireframe";
  const cache = greyed ? mats.greyed : mats.normal;
  let mat = cache.get(componentId);
  if (!mat) {
    const color = new THREE.Color(getComponent(project, componentId).color);
    if (greyed) {
      // Zu mittlerem Grau hin mischen (entsättigen) und transparent machen.
      color.lerp(new THREE.Color(0x9aa0a6), 0.7);
      mat = new THREE.MeshStandardMaterial({
        color,
        wireframe,
        roughness: 0.9,
        metalness: 0,
        envMapIntensity: 0.6,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
    } else {
      mat = new THREE.MeshStandardMaterial({
        color,
        wireframe,
        roughness: 0.9,
        metalness: 0,
        envMapIntensity: 0.6,
      });
    }
    cache.set(componentId, mat);
  }
  return mat;
}

/**
 * Ein Schicht-Prisma: das (ggf. gehrte) Band-Polygon von Achs-Abstand s..e
 * zwischen den Offsets offA..offB wird vertikal von baseY bis topY extrudiert.
 * Es wird exakt dasselbe Polygon wie im Grundriss verwendet.
 * Gehrung greift nur an den echten Wandenden (s==0 bzw. e==length).
 * `baseElevation` verschiebt das Prisma vertikal (Geschoss-Stapelung).
 */
function addLayerPrism(
  group: THREE.Group,
  wall: Wall,
  s: number,
  e: number,
  baseY: number,
  topY: number,
  offA: number,
  offB: number,
  cuts: WallCuts,
  baseElevation: number,
  mat: THREE.Material,
  opts: BuildOpts,
): void {
  if (e - s <= 1e-6) return;
  const length = Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  const p1 = along(wall.start, wall.end, s);
  const p2 = along(wall.start, wall.end, e);
  const startCut = s <= 1e-6 ? cuts.startCut : null;
  const endCut = e >= length - 1e-6 ? cuts.endCut : null;

  const quad = clippedBand(p1, p2, offA, offB, startCut, endCut);

  // Plan (x,y) → Three (x, y). Y-Spiegelung, damit die Form im Three-XY-
  // System dieselbe Wicklung behält wie im Grundriss; nach der Extrusion
  // wird das Prisma so rotiert, dass Plan-Y auf die Three-Z-Achse fällt.
  const shape = new THREE.Shape();
  const pt = (v: Vec2, i: number) => (i === 0 ? shape.moveTo(v.x, v.y) : shape.lineTo(v.x, v.y));
  quad.forEach(pt);
  shape.closePath();

  const depth = topY - baseY;
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });

  // Texturiert-Modus mit aoMap: die Ambient-Occlusion-Karte liest aus `uv2`.
  // ExtrudeGeometry erzeugt nur `uv`; wir kopieren sie nach `uv2` (gleiche UV-
  // Koordinaten in Welt-Metern → identische Kachelung wie die übrigen Karten).
  const std = mat as THREE.MeshStandardMaterial;
  if (opts.renderMode === "textured" && std.isMeshStandardMaterial && std.aoMap) {
    const uv = geo.getAttribute("uv");
    if (uv && !geo.getAttribute("uv2")) {
      geo.setAttribute(
        "uv2",
        new THREE.BufferAttribute((uv as THREE.BufferAttribute).array, 2),
      );
    }
  }
  const mesh = new THREE.Mesh(geo, mat);
  // Wand-ID für die Raycast-Auswahl mitführen (Links-Klick im Viewport).
  mesh.userData.wallId = wall.id;
  // ExtrudeGeometry liegt in der XY-Ebene und wächst entlang +Z. Drehung +90°
  // um X bildet Plan (x,y) → Three (x, z=y) ab (wie zuvor bei den Boxen); die
  // Extrusion zeigt dadurch nach −Y, deshalb sitzt die Form auf topY und
  // wächst hinunter bis baseY. Die baseElevation hebt das gesamte Geschoss an.
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = topY + baseElevation;
  // Verdeckte Kanten: schwarze EdgesGeometry-Linien als Kind des Mesh (erben
  // dessen Transform). Zusammen mit den (tiefen-getesteten) weißen Faces +
  // polygonOffset ergibt das den Hidden-Line-Look (Kanten dahinter verdeckt).
  if (opts.renderMode === "hidden") {
    const edges = new THREE.EdgesGeometry(geo, 1);
    mesh.add(new THREE.LineSegments(edges, opts.edgeMat));
  }
  group.add(mesh);
}

/**
 * Eine Decke als extrudierter Slab: das geschlossene Umriss-Polygon wird um die
 * Deckendicke extrudiert und an die OK (zTop) der Decke gesetzt (wächst nach
 * unten bis zBottom) — dieselbe Plan→Three-Abbildung und Extrusions-Konvention
 * wie beim Wand-Schicht-Prisma. Das Material folgt dem Render-Modus (analog Wand)
 * und wird aus dem BAUTEIL der ersten Schicht des Aufbau-Typs aufgelöst.
 * `userData.ceilingId` trägt die Auswahl-ID für den Raycast.
 */
function addCeilingMesh(
  group: THREE.Group,
  project: Project,
  ceiling: Ceiling,
  greyed: boolean,
  opts: BuildOpts,
): void {
  const outline = ceiling.outline;
  if (outline.length < 3) return;
  const wt = getCeilingType(project, ceiling);
  if (wt.layers.length === 0) return;
  const componentId = wt.layers[0].componentId;
  const { zBottom, zTop } = ceilingVerticalExtent(project, ceiling);
  const depth = zTop - zBottom;
  if (depth <= 1e-6) return;

  // Material je Render-Modus (wie addWallMeshes).
  const textured = opts.renderMode === "textured";
  const textureMat = textured
    ? opts.matRuntime.get(getComponent(project, componentId).material)
    : null;
  const mat =
    opts.renderMode === "hidden"
      ? opts.hiddenFace
      : opts.renderMode === "white"
        ? opts.whiteFace
        : textured && textureMat
          ? textureMat
          : layerMaterial(project, componentId, greyed, opts);

  const shape = new THREE.Shape();
  outline.forEach((v, i) => (i === 0 ? shape.moveTo(v.x, v.y) : shape.lineTo(v.x, v.y)));
  shape.closePath();
  const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });

  // aoMap-UV2-Kopie wie beim Wand-Prisma (Texturiert-Modus).
  const std = mat as THREE.MeshStandardMaterial;
  if (opts.renderMode === "textured" && std.isMeshStandardMaterial && std.aoMap) {
    const uv = geo.getAttribute("uv");
    if (uv && !geo.getAttribute("uv2")) {
      geo.setAttribute(
        "uv2",
        new THREE.BufferAttribute((uv as THREE.BufferAttribute).array, 2),
      );
    }
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.userData.ceilingId = ceiling.id;
  // Plan (x,y) → Three (x, z=y); Extrusion zeigt nach −Y, daher an OK setzen.
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = zTop;
  if (opts.renderMode === "hidden") {
    const edges = new THREE.EdgesGeometry(geo, 1);
    mesh.add(new THREE.LineSegments(edges, opts.edgeMat));
  }
  group.add(mesh);
}

/**
 * Eine Treppe als gestufte Boxen: jeder Tritt wird als Vollblock von der
 * Treppen-UK (zBottom) bis zur Oberkante SEINER Setzstufe (zBottom + topRise)
 * extrudiert — so entsteht das treppenartige Stufenprofil (Tritt + Setzstufe in
 * einem). Das Zwischenpodest (L/Wendel) wird bis zu seiner Höhe extrudiert. Das
 * Material folgt dem Render-Modus; ein neutraler Beton-Grauton dient als Default.
 * `userData.stairId` trägt die Auswahl-ID für den Raycast.
 *
 * Ist ein Treppentyp (`StairType`) aufgelöst und dessen Tragart ungleich
 * "massiv", wird die Treppe stattdessen UNTEN OFFEN dargestellt: jeder Tritt
 * wird nur als dünne Platte (Dicke `treadThickness`) an seiner Oberkante
 * modelliert, optional mit Trittkanten-Überstand (Nase) und/oder geschlossenen
 * Setzstufen-Platten — je nach `StairType`-Feldern.
 */
function addStairMeshes(
  group: THREE.Group,
  project: Project,
  stair: Stair,
  greyed: boolean,
  opts: BuildOpts,
): void {
  const { zBottom, zTop } = stairVerticalExtent(project, stair);
  const totalRise = zTop - zBottom;
  if (totalRise <= 1e-6) return;
  const geo = stairGeometry(stair, totalRise);
  const st = getStairType(project, stair);

  // Material je Render-Modus. Ohne Component-Referenz nutzen wir einen neutralen
  // Beton-Grauton (gedimmt heller/transparent).
  const baseMat =
    opts.renderMode === "hidden"
      ? opts.hiddenFace
      : opts.renderMode === "white"
        ? opts.whiteFace
        : new THREE.MeshStandardMaterial({
            color: greyed ? 0xb8bcc2 : 0x9aa0a6,
            roughness: 0.85,
            metalness: 0,
            envMapIntensity: 0.6,
            transparent: greyed,
            opacity: greyed ? 0.35 : 1,
          });

  // Extrudiert ein geschlossenes Grundriss-Polygon zu einer Platte zwischen
  // `bottom` und `top` (beide relativ zur Treppen-UK `zBottom`). Analog zum
  // Vollblock, aber mit frei wählbarer Unterkante statt immer 0.
  const extrudeSlab = (pts: Vec2[], bottom: number, top: number) => {
    const depth = top - bottom;
    if (pts.length < 3 || depth <= 1e-6) return;
    const shape = new THREE.Shape();
    pts.forEach((v, i) => (i === 0 ? shape.moveTo(v.x, v.y) : shape.lineTo(v.x, v.y)));
    shape.closePath();
    const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
    const mesh = new THREE.Mesh(g, baseMat);
    mesh.userData.stairId = stair.id;
    // Plan (x,y) → Three (x, z=y); Extrusion nach −Y, daher an die Platten-OK setzen.
    mesh.rotation.x = Math.PI / 2;
    mesh.position.y = zBottom + top;
    if (opts.renderMode === "hidden") {
      const edges = new THREE.EdgesGeometry(g, 1);
      mesh.add(new THREE.LineSegments(edges, opts.edgeMat));
    }
    group.add(mesh);
  };

  // Vollblock (Default/"massiv"): von der Treppen-UK bis zur Tritt-Oberkante.
  const extrudeBlock = (pts: Vec2[], top: number) => extrudeSlab(pts, 0, top);

  const centroidOf = (pts: Vec2[]): Vec2 => {
    let x = 0, y = 0;
    for (const p of pts) { x += p.x; y += p.y; }
    return { x: x / pts.length, y: y / pts.length };
  };

  // Bestimmt die "vordere" Kante eines Tritt-Vierecks (die Kante in Richtung
  // des nächsten Tritts). `target` ist der Schwerpunkt eines Nachbartritts;
  // `preferNear` wählt die dem Ziel NÄCHSTE Kante (Nachbar = nächster Tritt),
  // sonst die FERNSTE (Nachbar = vorheriger Tritt, Vorderkante liegt entgegengesetzt).
  // Rückgabe: Indizes der beiden Eckpunkte der Vorderkante + deren Richtung
  // (vom Trittschwerpunkt zur Kantenmitte, normiert).
  const frontEdgeOf = (
    pts: Vec2[],
    target: Vec2,
    preferNear: boolean,
  ): { a: number; b: number; dir: Vec2 } => {
    const c = centroidOf(pts);
    let best = 0;
    let bestDist = preferNear ? Infinity : -Infinity;
    for (let e = 0; e < pts.length; e++) {
      const p0 = pts[e];
      const p1 = pts[(e + 1) % pts.length];
      const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
      const d = Math.hypot(mid.x - target.x, mid.y - target.y);
      if (preferNear ? d < bestDist : d > bestDist) {
        bestDist = d;
        best = e;
      }
    }
    const p0 = pts[best];
    const p1 = pts[(best + 1) % pts.length];
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const dx = mid.x - c.x;
    const dy = mid.y - c.y;
    const len = Math.hypot(dx, dy) || 1e-9;
    return { a: best, b: (best + 1) % pts.length, dir: { x: dx / len, y: dy / len } };
  };

  if (!st || st.structure === "massiv") {
    // Default/rückwärtskompatibel: durchgehend massive Vollblöcke.
    for (const tr of geo.treads) extrudeBlock(tr.pts, tr.topRise);
  } else {
    // Offene Treppe (Wangen-, aufgesattelte oder Spindeltreppe): dünne
    // Tritt-Platten statt Vollblöcken, darunter bleibt die Treppe offen.
    const treads = geo.treads;
    for (let k = 0; k < treads.length; k++) {
      const tr = treads[k];
      let pts = tr.pts;

      // Nase (Nosing): die Vorderkante des Tritts (Richtung nächster Tritt)
      // um den Überstand nach vorne verlängern. Die Vorderkante wird über den
      // Nachbartritt (Schwerpunkt) bestimmt — für den letzten Tritt (kein
      // Nachfolger) wird stattdessen die dem Vorgänger abgewandte Kante genutzt.
      const nosing = st.nosing ?? 0;
      if (nosing > 1e-6) {
        const hasNext = k + 1 < treads.length;
        const hasPrev = k > 0;
        const ref = hasNext ? treads[k + 1] : hasPrev ? treads[k - 1] : null;
        if (ref) {
          const { a, b, dir } = frontEdgeOf(pts, centroidOf(ref.pts), hasNext);
          const nosed = pts.slice();
          nosed[a] = { x: pts[a].x + dir.x * nosing, y: pts[a].y + dir.y * nosing };
          nosed[b] = { x: pts[b].x + dir.x * nosing, y: pts[b].y + dir.y * nosing };
          pts = nosed;
        }
      }

      // Tritt-Platte: dünne Scheibe, Oberkante an der Setzstufen-Oberkante.
      extrudeSlab(pts, tr.topRise - st.treadThickness, tr.topRise);

      // Geschlossene Setzstufe: vertikale Platte an der RÜCKKante dieses Tritts
      // (= Vorderkante des Vorgängers), von dessen UK (`baseRise`) bis zu
      // dieser Oberkante (`topRise`). Offene Treppe (closedRisers=false) lässt
      // diese Fläche bewusst weg.
      if (st.closedRisers) {
        const hasNext = k + 1 < treads.length;
        const ref = hasNext ? treads[k + 1] : k > 0 ? treads[k - 1] : null;
        if (ref) {
          // Rückkante = Gegenkante der Vorderkante desselben Tritts.
          const front = frontEdgeOf(tr.pts, centroidOf(ref.pts), hasNext);
          const n = tr.pts.length;
          const backA = (front.a + Math.floor(n / 2)) % n;
          const backB = (front.b + Math.floor(n / 2)) % n;
          const riserPts = [tr.pts[backA], tr.pts[backB]];
          // Dünne Platte: Rückkante zu einer flachen Wange in Setzrichtung
          // aufgeweitet (minimaler Versatz nach vorn), damit ein extrudierbares
          // Polygon entsteht.
          const thin = Math.min(st.treadThickness, 0.02) || 0.01;
          const offA = { x: tr.pts[backA].x - front.dir.x * thin, y: tr.pts[backA].y - front.dir.y * thin };
          const offB = { x: tr.pts[backB].x - front.dir.x * thin, y: tr.pts[backB].y - front.dir.y * thin };
          const riserPoly = [riserPts[0], riserPts[1], offB, offA];
          extrudeSlab(riserPoly, tr.baseRise, tr.topRise);
        }
      }

      // TODO Geländer (railing) noch nicht umgesetzt.
    }
  }

  // Podest (L/Wendel-Auge): bis zur mittleren Höhe extrudieren, damit es sichtbar
  // als Absatz erscheint (halber Gesamt-Rise als sinnvoller Default). Bleibt
  // unabhängig von der Tragart immer als Vollblock stehen.
  if (geo.landing && geo.landing.length >= 3) {
    // Höhe des Podests = Höhe des höchsten Tritts unter/an der Podestposition;
    // wir nehmen die halbe Gesamt-Steighöhe als robusten Näherungswert.
    extrudeBlock(geo.landing, totalRise * 0.5);
  }
}

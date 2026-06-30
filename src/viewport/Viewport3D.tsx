// 3D-Viewport mit Three.js. Baut das Gebäude aus dem semantischen Modell:
// Wände als Boxen, Türen als echte Aussparungen (Segmente + Sturz).
// Es werden ALLE sichtbaren Geschosse gerendert, vertikal gestapelt nach
// ihrer baseElevation (EG bei 0, OG darüber).

import type { MutableRefObject } from "react";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type {
  ContextObject,
  Drawing2D,
  DrawingLevel,
  Project,
  Vec2,
  Wall,
} from "../model/types";
import {
  flattenCategories,
  getComponent,
  getWallType,
  wallTypeThickness,
} from "../model/types";
import { along, clippedBand } from "../model/geometry";
import { computeJoins } from "../model/joins";
import type { WallCuts } from "../model/joins";
import { wallReferenceOffset, wallVerticalExtent } from "../model/wall";
import type { RenderMode, View3d } from "../ui/TopBar";

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

export function Viewport3D({
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
  onContextMenu,
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
   * Rechts-Klick: Kontextmenü an der Cursorposition. Das Standard-Browser-Menü
   * wird immer unterdrückt; ein Rechts-Drag-Pan ist deaktiviert. Optional.
   */
  onContextMenu?: (info: ViewportContextInfo) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [unavailable, setUnavailable] = useState(false);

  // Callbacks in Refs spiegeln, damit der (schwere) Aufbau-Effekt nicht von
  // referenzwechselnden Handlern abhängt — die Listener lesen stets aktuell.
  const onSelectWallRef = useRef(onSelectWall);
  const onContextMenuRef = useRef(onContextMenu);
  onSelectWallRef.current = onSelectWall;
  onContextMenuRef.current = onContextMenu;

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
  // Bodenraster (separat gehalten, damit es ohne Szenen-Neuaufbau auf die Höhe
  // des aktiven Geschosses (OKFF) gehoben werden kann).
  const gridRef = useRef<THREE.GridHelper | null>(null);
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
    mount.appendChild(renderer.domElement);

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

    // Licht
    scene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1);
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
      normal: new Map<string, THREE.MeshLambertMaterial>(),
      greyed: new Map<string, THREE.MeshLambertMaterial>(),
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
    });
    const opts: BuildOpts = { mats, renderMode, hiddenFace, edgeMat, whiteFace };
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
      }),
      mesh: new THREE.MeshStandardMaterial({
        color: 0x9fa6ae, // neutrales Hellgrau für importierte Meshes
        roughness: 0.9,
        metalness: 0,
        side: THREE.DoubleSide,
        wireframe: CONTEXT_WIREFRAME,
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

    applyView3d(
      camera,
      orthoCamera,
      activeCameraRef,
      controls,
      bounds,
      view3dRef.current,
      currentAspect(),
    );

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
      raf = requestAnimationFrame(animate);
    };
    animate();

    // ── Maus-Auswahl + Kontextmenü (Raycast) ────────────────────────────────
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();

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

    // Auswahl-Hervorhebung: die Meshes der gewählten Wand mit einem geteilten
    // Highlight-Material überziehen; Originale merken und beim Wechsel/Cleanup
    // wiederherstellen. Material wird im Cleanup verworfen.
    const highlightMat = new THREE.MeshLambertMaterial({
      color: 0x5fa896,
      emissive: 0x1a655a,
      emissiveIntensity: 0.6,
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
    };
    const onPointerUpDom = (e: PointerEvent) => {
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      if (moved > CLICK_SLOP) return;
      // LINKS = Auswahl (kein Orbit links).
      if (e.button === 0 && downButton === 0) {
        selectWall(pickWall(e.clientX, e.clientY));
      }
    };
    // RECHTS = Kontextmenü; Browser-Menü unterdrücken, Rechts-Drag-Pan ist aus.
    const onContextMenuDom = (e: MouseEvent) => {
      e.preventDefault();
      const cb = onContextMenuRef.current;
      if (!cb) return;
      const moved = Math.hypot(e.clientX - downX, e.clientY - downY);
      // Nach einem Drag (falls doch) kein Menü öffnen.
      if (moved > CLICK_SLOP && downButton === 2) return;
      cb({ clientX: e.clientX, clientY: e.clientY, wallId: pickWall(e.clientX, e.clientY) });
    };
    const dom = renderer.domElement;
    dom.addEventListener("pointerdown", onPointerDownDom);
    dom.addEventListener("pointerup", onPointerUpDom);
    dom.addEventListener("contextmenu", onContextMenuDom);

    return () => {
      cancelAnimationFrame(raf);
      dom.removeEventListener("pointerdown", onPointerDownDom);
      dom.removeEventListener("pointerup", onPointerUpDom);
      dom.removeEventListener("contextmenu", onContextMenuDom);
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
      for (const m of mats.normal.values()) m.dispose();
      for (const m of mats.greyed.values()) m.dispose();
      for (const m of mats.lines.values()) m.dispose();
      hiddenFace.dispose();
      edgeMat.dispose();
      whiteFace.dispose();
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

  // Leichter Effekt: Bodenraster auf die Z-Höhe des aktiven Geschosses heben
  // (ohne Szenen-Neuaufbau), passend zu den 2D-Zeichnungen auf derselben Höhe.
  useEffect(() => {
    if (gridRef.current) gridRef.current.position.y = gridElevation;
  }, [gridElevation]);

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
  normal: Map<string, THREE.MeshLambertMaterial>;
  greyed: Map<string, THREE.MeshLambertMaterial>;
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
 *   front/side/top/iso → OrthographicCamera (echte parallele Projektion;
 *     „Isometrie" zeigt parallele Kanten parallel, ohne Konvergenz).
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

  // Blickrichtung je Preset (vom Zentrum zur Kamera, normalisiert).
  let dir: THREE.Vector3;
  switch (view3d) {
    case "front":
      dir = new THREE.Vector3(0, 0, 1);
      break;
    case "side":
      dir = new THREE.Vector3(1, 0, 0);
      break;
    case "top":
      dir = new THREE.Vector3(0, 1, 0.0001); // winziger Z-Anteil → stabiles Up
      break;
    case "iso":
      dir = new THREE.Vector3(1, 1, 1).normalize();
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
    const cuts = joins.get(wall.id) ?? { startCut: null, endCut: null };
    addWallMeshes(group, project, wall, doors, cuts, baseElevation, greyed, opts);
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
  const openings = doors
    .map((d) => ({ from: d.position, to: d.position + d.width, top: d.height }))
    .sort((a, b) => a.from - b.from);

  // Vertikale Ausdehnung (absolute Z): UK/OK aus den Wand-Attributen, sonst
  // baseElevation des Geschosses … +height (= heutiges Verhalten). Wir geben
  // die absoluten Z-Werte direkt an addLayerPrism (baseElevation dort = 0).
  const { zBottom, zTop } = wallVerticalExtent(project, wall);
  // Tür-/Sturzhöhen sind relativ zur Wand-UK definiert (Türen sitzen am Boden).
  const wallTopRel = zTop - zBottom;

  // Referenzlinien-Versatz über die Dicke (center=0 → unverändert).
  const refOff = wallReferenceOffset(wall, total);

  // Schichten von außen (-T/2) nach innen (+T/2) stapeln, um den Referenzversatz
  // verschoben (damit die Achse bei „außen"/„innen" auf der Wandfläche liegt).
  let off = refOff - total / 2;
  for (const layer of wt.layers) {
    // Material je Modus: Hidden-Line nutzt die geteilten flachen weißen Faces,
    // „Weiss" das geteilte matte Clay-Material, shaded/wireframe das (ggf.
    // gedimmte) Component-Material.
    const mat =
      opts.renderMode === "hidden"
        ? opts.hiddenFace
        : opts.renderMode === "white"
          ? opts.whiteFace
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
      // Sturz über der Öffnung (türnahe Enden bleiben rechtwinklig).
      if (op.top < wallTopRel)
        addLayerPrism(group, wall, op.from, op.to, zBottom + op.top, zTop, offA, offB, cuts, 0, mat, opts);
      cursor = Math.max(cursor, op.to);
    }
    if (cursor < length)
      addLayerPrism(group, wall, cursor, length, zBottom, zTop, offA, offB, cuts, 0, mat, opts);

    off += layer.thickness;
  }
}

/**
 * MeshLambertMaterial pro Component-ID gecached (3D-Farbe = component.color).
 * Gedimmte Variante: Bauteilfarbe Richtung Grau gemischt + transparent, damit
 * gedimmte Geschosse/Kategorien als „andere" sichtbar, aber zurückgenommen sind.
 */
function layerMaterial(
  project: Project,
  componentId: string,
  greyed: boolean,
  opts: BuildOpts,
): THREE.MeshLambertMaterial {
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
      mat = new THREE.MeshLambertMaterial({
        color,
        wireframe,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      });
    } else {
      mat = new THREE.MeshLambertMaterial({ color, wireframe });
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

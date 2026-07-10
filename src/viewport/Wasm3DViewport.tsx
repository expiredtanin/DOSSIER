// 3D-Viewport auf der nativen Engine: render3d (Rust/wgpu) als WASM/WebGPU-
// Canvas. Aktiv hinter demselben Engine-Umschalter wie die 2D-Plan-Ansicht
// (`?engine=wasm` bzw. Statusleisten-Wahl, siehe Viewport3D.tsx); die three.js-
// Sicht bleibt der unveränderte Standardpfad.
//
// INTEGRATIONS-SPIKE (Umfang bewusst schmal): Massenmodell (Wände mit Öffnungs-
// Teilquadern + Deckenplatten, alle Geschosse gestapelt) + Orbit-Navigation +
// Kamera-Presets (`view3d`, von der Oberleiste getrieben — s. u.) + Darstellungs-
// art (volle `renderMode`-Union der Oberleiste — shaded/white/textured/
// wireframe/hidden — via `set_render_style` in Rust; "textured" faellt dort
// vorerst auf "shaded" zurueck) + ein-/ausblendbares Boden-Referenzraster
// (`gridVisible`/`groundElevation`, Overlay-Umschalter im Viewport selbst).
// Auswahl/Raycast sowie Griffe/Zeichnen der three.js-Sicht folgen später —
// bis dahin gilt: RECHTS unterdrückt weiterhin nur das Browser-Menü (kein
// Kontextmenü im Engine-Pfad).
//
// KAMERA-PRESETS: `view3d`/`renderMode` kommen als Props von der Oberleiste
// (TopBar → App.tsx → Viewport3D-Umschalter, dieselbe Quelle wie die three.js-
// Sicht). Front/Top/Side/Iso/Perspective rechnet NICHT mehr diese Datei (die
// alte VIEW_PRESETS-Tabelle war perspektivisch-only und damit für Front/Top/
// Side falsch) — stattdessen `WebModelRenderer.set_view_preset` in Rust
// (`web.rs` → `math::preset_camera`): Front/Top/Side werden dort ECHT
// orthografisch, Iso/Perspective perspektivisch, exakt wie die native Fenster-
// Sicht. „Praeset = hinspringen, kein Lock" (wie `applyView3d` in der three.js-
// Sicht): manuelles Orbit/Pan/Zoom bleibt danach frei — es fährt mit der
// FREIEN perspektivischen Orbit-Kamera fort (Kugelkoordinaten, s. u.), deren
// Start-Blickwinkel VIEW3D_ORBIT so wählt, dass der erste Drag-Frame nahtlos
// an die Praeset-Blickrichtung anschliesst (Rust berechnet dieselbe Richtung
// für die exakte, evtl. orthografische Praeset-Kamera).
//
// MAUS-SCHEMA (bewusst ANDERS als die three.js-Sicht — Laptop-freundlich, ohne
// Modifier-Taste zu verlangen; im Engine-Pfad gibt es noch keine Auswahl/kein
// Kontextmenü, LINKS/RECHTS sind also frei für Navigation):
//   LINKS ziehen   = Orbit (drehen) — entdeckbarste Geste, da frei.
//   MITTE ziehen   = Pan (bewegen) — konsistent mit der 2D-Grundriss-Ansicht
//                    (dort ist MITTE ebenfalls Pan).
//   RECHTS ziehen  = Pan (bewegen), zweiter leicht erreichbarer Weg; das
//                    Browser-Kontextmenü bleibt unterdrückt (RECHTS-KLICK ohne
//                    Bewegung löst ohnehin kein Menü aus, es gibt hier keins).
//   RAD            = Zoom, Ziel leicht Richtung Cursor-Strahl verschoben
//                    (Näherungs-„Zoom-to-Cursor", s. onWheel).
// Die Orbit-/Pan-Mathematik folgt den OrbitControls-Konventionen (Winkel je
// Pixel an der Viewport-Höhe normiert), damit sich beide Pfade gleich anfühlen.

import { useEffect, useRef, useState } from "react";
import type { Project, Wall, Drawing2D, Ceiling, Roof, Vec2 } from "../model/types";
import { ceilingVerticalExtent, wallVerticalExtent } from "../model/wall";
import { roofBaseElevation, roofGeometry } from "../geometry/roof";
import { projectToModel3d, pickGeometry, TRUCK_MESH_READY_EVENT } from "../plan/toWalls3d";
import type { DetailLevel, RenderMode, View3d } from "../ui/TopBar";
import { t } from "../i18n";
import { useWasm3dRenderer } from "./useWasm3dRenderer";
import type { Camera3d } from "./useWasm3dRenderer";
import { cameraRay, pickNearest, rayPlaneY, rayPlane, worldToScreen } from "./raycast3d";
import type { Vec3 } from "./raycast3d";
import { drawingGripVertices, drawingMoveAnchor } from "./drawingGrips";

/** Ein per 3D-Klick getroffenes Bauteil, oder null (Leerraum). */
export type Pick3dHit =
  | { kind: "wall" | "ceiling" | "opening" | "stair" | "roof"; id: string }
  | null;

/** Klick-vs-Drag-Schwelle (Pixel): bleibt die Maus zwischen pointerdown und
 * pointerup darunter, gilt die Links-Geste als KLICK (Pick) statt als Orbit-Drag. */
const CLICK_THRESHOLD_PX = 4;

// ── 3D-Editier-Griffe ─────────────────────────────────────────────────────
// Volle Parität mit den three.js-Griffen (`Viewport3D.tsx`/`drawGrips`):
// Wand-Endpunkte + Höhen-Griff (OK der Wand) + Verschiebe-Griff (ganze Wand),
// dieselben drei Griff-Arten für gewählte 2D-Zeichnungen (Vertex + Verschieben).
// Bewusst NICHT nachgebaut: Snap/Koinzidenz-Mitführen beim Ziehen (mehrere
// gewählte Elemente mit gemeinsamer Ecke) — das bleibt dem three.js-Pfad
// vorbehalten, bis sich das dort bewährte Muster als eigener Bedarf zeigt.
//
// DARSTELLUNG: ECHTE DOM-Buttons (kleine Kreise, `position:absolute` über dem
// Canvas), nicht In-Szene-Geometrie. Ein erster Versuch zeichnete die Griffe
// als Drahtgitter-Kugeln über denselben `setHighlightLines`-Kanal wie den
// Auswahl-Umriss — Nutzer-Feedback 2026-07-06: "immernoch kein GUI button
// sondern geometrie" (zurecht: dünne Linien-Kugeln lesen sich nicht als
// klickbarer Punkt, ausserdem teilten sie sich die Farbe mit dem Umriss und
// sassen exakt auf dessen Ecken). Echte DOM-Buttons sind trivial zu treffen
// (native Pointer-Events statt Ray-Toleranz-Mathe) und sehen wie ein
// GUI-Element aus. Kosten: die Bildschirm-Position muss der Kamera folgen —
// `useEffect` unten pollt sie per `requestAnimationFrame`, solange Griffe
// aktiv sind (billige 2D-Projektion, kein WASM/GPU-Aufruf).
type GripKind = "vertex" | "height" | "move" | "edge" | "roofpitch";
interface Grip {
  kind: GripKind;
  /** Element, dessen Griff das ist (Wand-/Drawing-/Decken-/Dach-ID). */
  target: { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string };
  /** Vertex-Index (`vertex`) bzw. erster Kanten-Index (`edge`); -1 sonst. */
  index: number;
  /** Zweiter Kanten-Index (nur `kind==="edge"`). */
  index2?: number;
  pos: Vec3;
}

/**
 * Alle Griffe der gewählten Wände + 2D-Zeichnungen: pro Wand zwei Endpunkte
 * (UK), ein Höhen-Griff (Achsmitte, OK) und ein Verschiebe-Griff (Achsmitte,
 * knapp über UK) — Positionen exakt wie `drawGrips` in `Viewport3D.tsx`. Pro
 * Zeichnung ein Vertex-Griff je Eckpunkt + ein Verschiebe-Griff im Schwerpunkt,
 * auf der Ebene des aktiven Geschosses (`drawingElevation`).
 */
function computeGrips(
  project: Project,
  walls: readonly Wall[],
  drawings: readonly Drawing2D[],
  ceilings: readonly Ceiling[],
  roofs: readonly Roof[],
  drawingElevation: number,
): Grip[] {
  const out: Grip[] = [];
  for (const w of walls) {
    const { zBottom, zTop } = wallVerticalExtent(project, w);
    const target = { wallId: w.id };
    out.push({ kind: "vertex", target, index: 0, pos: [w.start.x, zBottom, w.start.y] });
    out.push({ kind: "vertex", target, index: 1, pos: [w.end.x, zBottom, w.end.y] });
    const midX = (w.start.x + w.end.x) / 2;
    const midY = (w.start.y + w.end.y) / 2;
    out.push({ kind: "height", target, index: -1, pos: [midX, zTop, midY] });
    out.push({ kind: "move", target, index: -1, pos: [midX, zBottom + 0.05, midY] });
  }
  for (const d of drawings) {
    const verts = drawingGripVertices(d);
    const target = { drawingId: d.id };
    const y = drawingElevation + 0.02;
    verts.forEach((v, i) => out.push({ kind: "vertex", target, index: i, pos: [v.x, y, v.y] }));
    const anchor = drawingMoveAnchor(d, verts);
    if (anchor) out.push({ kind: "move", target, index: -1, pos: [anchor.x, y + 0.03, anchor.y] });
  }
  // Decken: Eckpunkt-Griffe (Umriss) + je Seite ein Kanten-Mittelpunkt-Griff
  // (Nutzer-Wunsch „an allen seiten auch ein punkt … wie an den eckpunkten") +
  // ein Verschiebe-Griff im Schwerpunkt. Griffe sitzen auf der Deckenoberkante.
  for (const c of ceilings) {
    const pts = c.outline;
    const n = pts.length;
    if (n < 2) continue;
    const target = { ceilingId: c.id };
    const y = ceilingVerticalExtent(project, c).zTop + 0.02;
    let sx = 0;
    let sy = 0;
    pts.forEach((p, i) => {
      out.push({ kind: "vertex", target, index: i, pos: [p.x, y, p.y] });
      const q = pts[(i + 1) % n];
      out.push({
        kind: "edge",
        target,
        index: i,
        index2: (i + 1) % n,
        pos: [(p.x + q.x) / 2, y, (p.y + q.y) / 2],
      });
      sx += p.x;
      sy += p.y;
    });
    out.push({ kind: "move", target, index: -1, pos: [sx / n, y + 0.03, sy / n] });
  }
  // Dächer: Eckpunkt-Griffe (Umriss = Traufe-Grundriss, resize) + Verschiebe-Griff
  // + ein FIRST-/Neigungs-Griff am höchsten Punkt (vertikal ziehen ändert die
  // Neigung). Eckpunkte auf Traufhöhe.
  for (const roof of roofs) {
    const pts = roof.outline;
    const rn = pts.length;
    if (rn < 4) continue;
    const target = { roofId: roof.id };
    const eavesZ = roofBaseElevation(project, roof);
    let sx = 0;
    let sy = 0;
    pts.forEach((p, i) => {
      out.push({ kind: "vertex", target, index: i, pos: [p.x, eavesZ + 0.02, p.y] });
      sx += p.x;
      sy += p.y;
    });
    out.push({ kind: "move", target, index: -1, pos: [sx / rn, eavesZ + 0.05, sy / rn] });
    // First-/Neigungs-Griff am höchsten Dachpunkt (aus der 3D-Geometrie).
    const g = roofGeometry(roof, eavesZ);
    if (g.ridgeHeight > 0.01) {
      let apex: readonly [number, number, number] | null = null;
      for (const pl of g.planes) {
        for (const v of pl.pts) if (!apex || v[2] > apex[2]) apex = v;
      }
      // g-Punkte sind MODELL [x, y, z=Höhe] → world [x, Höhe, y].
      if (apex) out.push({ kind: "roofpitch", target, index: -1, pos: [apex[0], apex[2], apex[1]] });
    }
  }
  return out;
}

/** Vertikaler Öffnungswinkel (Radiant) — wie die three.js-PerspectiveCamera (50°),
 * auch für die FREIE Orbit-Kamera hier (die Presets selbst nutzen den Rust-
 * seitigen Default-FOV, s. `types::default_fov`, denselben Wert). */
const FOV_Y = (50 * Math.PI) / 180;
/** Pitch-Klemme gegen den Gimbal-Flip (identisch zu render3d::math::orbit_eye). */
const PITCH_LIMIT = Math.PI / 2 - 0.01;

/** Orbit-Zustand der Kamera: Kugelkoordinaten um ein Blickziel (world, Y-up). */
interface OrbitState {
  /** Azimut um die Y-Achse (Radiant). */
  yaw: number;
  /** Erhebung über die XZ-Ebene (Radiant, geklemmt). */
  pitch: number;
  /** Abstand vom Ziel (Meter). */
  dist: number;
  /** Blickziel (world). */
  target: [number, number, number];
  /** Soll die freie Kamera orthografisch bleiben? (true fuer alle Presets ausser
   * `perspective`) — sonst kippt die erste Kamerabewegung fälschlich in
   * Perspektive („locked iso"). */
  ortho: boolean;
  /** Orthografische Bild-Halbhoehe (Meter), UNABHAENGIG von `dist` gefuehrt: eine
   * echte Ortho-Kamera skaliert ihr Bild ueber diese Groesse, nicht ueber den
   * Augabstand. Wird beim Preset aus `dist*tan(FOV_Y/2)` geseedet (perspektiv-
   * äquivalente Bildhoehe an der eingepassten Distanz → kein Sprung beim ersten
   * Move) und beim Zoom in Ortho-Modus multiplikativ skaliert. */
  orthoHalfHeight: number;
}

/** Fertige (freie, perspektivische) Kamera aus dem Orbit-Zustand (Konvention
 * wie render3d::math::orbit_eye). Für die manuelle Navigation NACH einem
 * Praeset-Sprung — die Presets selbst zeichnen über `set_view_preset`. */
function orbitCamera(o: OrbitState): Camera3d {
  const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, o.pitch));
  const r = o.dist * Math.cos(pitch);
  return {
    eye: [
      o.target[0] + r * Math.cos(o.yaw),
      o.target[1] + o.dist * Math.sin(pitch),
      o.target[2] + r * Math.sin(o.yaw),
    ],
    target: [o.target[0], o.target[1], o.target[2]],
    up: [0, 1, 0],
    // Projektion aus dem Orbit-Zustand (war hartkodiert `true`/`dist*0.5` — genau
    // DAS war der Locked-Iso-Bug: die erste Bewegung nach einem Ortho-Preset kippte
    // sofort in Perspektive). Ortho behaelt seine eigene, dist-unabhaengige Halbhoehe.
    perspective: !o.ortho,
    fovY: FOV_Y,
    orthoHalfHeight: o.orthoHalfHeight,
  };
}

/**
 * Formatfüllendes Ziel + Distanz: Bounding-Box des geflachten Modells (Wände +
 * Decken, world: x = Modell-x, z = Modell-y, y = Höhe) einpassen. Mirror der
 * Rust-Bounding-Box in `web::model_bounds`/`set_view_preset` — beide Seiten
 * müssen auf dieselbe Distanz/dasselbe Ziel kommen, damit der Orbit-Zustand
 * (hier) nahtlos an die exakte Praeset-Kamera (dort) anschliesst.
 */
function fitTargetDist(project: Project): {
  target: [number, number, number];
  dist: number;
} {
  const model = projectToModel3d(project);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  const grow = (x: number, y: number, z: number) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  };
  for (const w of model.walls) {
    grow(w.start[0], w.baseElevation, w.start[1]);
    grow(w.end[0], w.baseElevation + w.height, w.end[1]);
  }
  for (const s of model.slabs) {
    for (const p of s.outline) {
      grow(p[0], s.zBottom, p[1]);
      grow(p[0], s.zTop, p[1]);
    }
  }
  // Leeres Modell: neutraler Standpunkt (entspricht dem three.js-Start und dem
  // Rust-Fallback in `set_view_preset` bei fehlender Bounding-Box).
  if (!Number.isFinite(minX)) {
    return { dist: 14, target: [2.5, 1, 2] };
  }
  const target: [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];
  const radius =
    Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 || 1;
  // Abstand so, dass die Bounding-Kugel ins vertikale Sichtfeld passt (+ Rand).
  const dist = Math.max(4, (radius / Math.tan(FOV_Y / 2)) * 1.2);
  return { target, dist };
}

/**
 * Orbit-Blickwinkel (yaw/pitch), die DIESELBE Blickrichtung wie das jeweilige
 * `view3d`-Praeset ergeben (hergeleitet aus `preset_camera` in
 * render3d/src/math.rs — front/side/top/iso/perspective). Dient NICHT dem
 * Zeichnen der Presets selbst (das macht `set_view_preset` in Rust, inkl.
 * echter Orthografie für front/top/side) — nur als Startpunkt für den freien
 * Orbit-Zustand, damit ein Drag direkt nach einem Praeset-Sprung nicht aus
 * einem unpassenden Blickwinkel losspringt.
 */
const ISO_PITCH = Math.asin(1 / Math.sqrt(3));
const VIEW3D_ORBIT: Record<View3d, { yaw: number; pitch: number }> = {
  front: { yaw: Math.PI / 2, pitch: 0 },
  back: { yaw: -Math.PI / 2, pitch: 0 },
  side: { yaw: 0, pitch: 0 },
  left: { yaw: Math.PI, pitch: 0 },
  top: { yaw: Math.PI / 2, pitch: PITCH_LIMIT },
  iso: { yaw: Math.PI / 4, pitch: ISO_PITCH },
  isoFrontLeft: { yaw: (3 * Math.PI) / 4, pitch: ISO_PITCH },
  isoBackRight: { yaw: -Math.PI / 4, pitch: ISO_PITCH },
  isoBackLeft: { yaw: (-3 * Math.PI) / 4, pitch: ISO_PITCH },
  perspective: { yaw: Math.PI / 4, pitch: 0.5 },
};

export function Wasm3DViewport({
  project,
  view3d = "perspective",
  renderMode = "shaded",
  detail = "fein",
  gridVisible = true,
  groundElevation = 0,
  onToggleGrid,
  onPick3d,
  highlightLines = null,
  editWalls = [],
  editDrawings = [],
  editCeilings = [],
  editRoofs = [],
  onEditVertex,
  onEditBody,
  onEditEdge,
  onEditRoofPitch,
  onEditWallTop,
  onEditEnd,
}: {
  project: Project;
  /** Kanonischer Blickwinkel (Oberleiste) — s. Datei-Kommentar. */
  view3d?: View3d;
  /** Darstellungsart (Oberleiste) — alle fünf Werte wirken hier, s.
   * Datei-Kommentar. */
  renderMode?: RenderMode;
  /** Detailgrad (grob/mittel/fein) — steuert die Öffnungs-Rahmen/Sprossen im 3D. */
  detail?: DetailLevel;
  /** Boden-Referenzraster sichtbar? Umgeschaltet über den Overlay-Button unten
   * rechts im Viewport (`onToggleGrid`) — Single Source of Truth ist der
   * Aufrufer (App/viewSlice `grid3dVisible`), diese Komponente spiegelt nur. */
  gridVisible?: boolean;
  /** Hoehe (world-Y, Meter) des Bodenrasters = OKFF/`baseElevation` des
   * aktiven Geschosses (vom Aufrufer berechnet, s. App.tsx). */
  groundElevation?: number;
  /** Klick auf den Grid-Umschalter-Button; ohne Angabe kein Button. */
  onToggleGrid?: () => void;
  /**
   * Links-KLICK (kein Drag) auf ein Bauteil: meldet das per TS-Raycast getroffene
   * Bauteil (Wand/Decke) oder null (Leerraum → Auswahl leeren). `additive` =
   * Shift/Ctrl/Meta gedrückt (zur Auswahl hinzufügen statt ersetzen). Der
   * Aufrufer (App) setzt daraus die Store-Selektion; ohne Angabe passiert nichts.
   */
  onPick3d?: (hit: Pick3dHit, additive: boolean) => void;
  /**
   * Umriss-Linien der aktuellen Auswahl (LineList-Vertex-Array, s.
   * `selectionHighlightLines` in plan/toWalls3d.ts) — werden ohne Tiefentest
   * immer sichtbar obenauf gezeichnet (Akzentfarbe kommt vom Aufrufer/App).
   * `null`/leeres Array = kein Highlight (leere Auswahl).
   */
  highlightLines?: Float32Array | null;
  /** Gewählte Wände — Quelle der 3D-Endpunkt-/Höhen-/Verschiebe-Griffe. */
  editWalls?: Wall[];
  /** Gewählte 2D-Zeichnungen — Quelle der 3D-Vertex-/Verschiebe-Griffe. */
  editDrawings?: Drawing2D[];
  /** Gewählte Decken — Quelle der 3D-Eckpunkt-/Kanten-/Verschiebe-Griffe. */
  editCeilings?: Ceiling[];
  /** Gewählte Dächer — Quelle der 3D-Eckpunkt-/Verschiebe-/First-Griffe. */
  editRoofs?: Roof[];
  /** Endpunkt-Griff gezogen: neuer XY-Modellpunkt für den Vertex `index` des Elements. */
  onEditVertex?: (
    target: { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string },
    index: number,
    model: Vec2,
  ) => Vec2;
  /** Verschiebe-Griff gezogen: das Element um `delta` (XY) verschieben. */
  onEditBody?: (
    target: { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string },
    delta: Vec2,
  ) => void;
  /** Kanten-Griff einer Decke gezogen: Kante (aIndex→bIndex) um `delta` (XY) verschieben. */
  onEditEdge?: (ceilingId: string, aIndex: number, bIndex: number, delta: Vec2) => void;
  /** First-/Neigungs-Griff eines Dachs gezogen: neue absolute Firsthöhe (Z). */
  onEditRoofPitch?: (roofId: string, apexZ: number) => void;
  /** Höhen-Griff gezogen: neue absolute Oberkanten-Z der Wand. */
  onEditWallTop?: (wallId: string, topZ: number) => void;
  /** Ende eines Griff-Drags. */
  onEditEnd?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Pick-Callback in einem Ref spiegeln, damit der (einmal registrierte)
  // Pointer-Listener stets den aktuellen liest (additive-Logik in App liest
  // die frische Store-Auswahl), ohne den Listener-Effekt neu aufzubauen.
  const onPick3dRef = useRef(onPick3d);
  onPick3dRef.current = onPick3d;
  // Griff-Auswahl/Callbacks ebenfalls als Refs (gleiches Muster) — der Pointer-
  // Listener-Effekt unten bleibt stabil ([ready, render]) und liest trotzdem
  // stets die aktuelle Auswahl/den aktuellen Callback.
  const editWallsRef = useRef(editWalls);
  editWallsRef.current = editWalls;
  const editDrawingsRef = useRef(editDrawings);
  editDrawingsRef.current = editDrawings;
  const editCeilingsRef = useRef(editCeilings);
  editCeilingsRef.current = editCeilings;
  const editRoofsRef = useRef(editRoofs);
  editRoofsRef.current = editRoofs;
  const onEditVertexRef = useRef(onEditVertex);
  onEditVertexRef.current = onEditVertex;
  const onEditBodyRef = useRef(onEditBody);
  onEditBodyRef.current = onEditBody;
  const onEditEdgeRef = useRef(onEditEdge);
  onEditEdgeRef.current = onEditEdge;
  const onEditRoofPitchRef = useRef(onEditRoofPitch);
  onEditRoofPitchRef.current = onEditRoofPitch;
  const onEditWallTopRef = useRef(onEditWallTop);
  onEditWallTopRef.current = onEditWallTop;
  const onEditEndRef = useRef(onEditEnd);
  onEditEndRef.current = onEditEnd;
  const groundElevationRef = useRef(groundElevation);
  groundElevationRef.current = groundElevation;
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const {
    render,
    updateModel,
    setRenderStyle,
    applyViewPreset,
    setGroundGrid,
    setSectionPlane,
    setHighlightLines,
    ready,
    failed,
  } = useWasm3dRenderer(canvasRef, true);
  // Live-Schnitt-Zustand (lokaler Overlay-Umschalter, MVP): vertikale
  // Schnittebene durch die Modellmitte, Blick +Y (Grundriss-Y = world Z, s.
  // section.rs `looking_plus_y`: normal = [0,0,1]). Kein Store-/App-Prop —
  // reine Viewport-Ansichts-Option analog zum Grid-Overlay.
  const [sectionActive, setSectionActive] = useState(false);
  // Orbit-Zustand in einem Ref (kein React-State): Mausbewegungen zeichnen
  // direkt neu, ohne die Komponente je Frame zu re-rendern. Dient NUR der
  // freien Navigation NACH einem Praeset-Sprung (s. Datei-Kommentar).
  const orbitRef = useRef<OrbitState | null>(null);
  // Redraw-Strategie des zuletzt aktiven Kamera-Modus (Praeset ODER freier
  // Orbit) — Resize/Modell-Update ruft diese auf, ohne den Modus zu kennen.
  const redrawRef = useRef<() => void>(() => {});
  // Frisches Projekt für den (stabilen) Init-Effekt unten.
  const projectRef = useRef(project);
  projectRef.current = project;

  // Modell bei Bereitschaft + jeder Projektänderung neu einspielen. Die
  // Kamera bleibt dabei stehen (gleiches Verhalten wie der three.js-Kamera-
  // Snapshot) — nur das `view3d`-Effekt unten springt aktiv auf ein Praeset.
  useEffect(() => {
    if (!ready) return;
    updateModel(project, detail);
    redrawRef.current();
  }, [ready, project, detail, updateModel]);

  // truck-Extrusionen (s. toWalls3d.ts emitExtrudedSolids): die WASM-Extrusion
  // läuft asynchron und ist beim ersten `updateModel` oben typischerweise noch
  // nicht fertig — ohne diesen Re-Push bliebe sie trotz erfolgreichen Ladens
  // unsichtbar, weil `project` sich dafür nicht ändert.
  useEffect(() => {
    if (!ready) return;
    const onMeshReady = () => {
      updateModel(projectRef.current, detailRef.current);
      redrawRef.current();
    };
    window.addEventListener(TRUCK_MESH_READY_EVENT, onMeshReady);
    return () => window.removeEventListener(TRUCK_MESH_READY_EVENT, onMeshReady);
  }, [ready, updateModel]);

  // Blickwinkel-Praeset anwenden, wenn `view3d` wechselt (oder der Renderer
  // bereit wird): springt über `set_view_preset` (Rust) auf die formatfüllende,
  // ggf. orthografische Praeset-Kamera — „hinspringen, kein Lock", der
  // Orbit-Zustand wird nur als Startpunkt für spätere manuelle Navigation
  // nachgezogen (s. VIEW3D_ORBIT).
  useEffect(() => {
    if (!ready) return;
    applyViewPreset(view3d);
    const { yaw, pitch } = VIEW3D_ORBIT[view3d];
    const { target, dist } = fitTargetDist(projectRef.current);
    // Alle Presets ausser `perspective` sind orthografisch (front/top/side/iso, wie
    // die Rust-Seite `preset_camera`) → die freie Kamera bleibt danach ebenfalls
    // ortho („locked iso"). orthoHalfHeight auf die perspektiv-aequivalente Bildhoehe
    // an der eingepassten Distanz seeden, damit der erste manuelle Move/Zoom groessen-
    // gleich an das von Rust gezeichnete Preset-Bild anschliesst (kein Sprung).
    const ortho = view3d !== "perspective";
    orbitRef.current = {
      yaw,
      pitch,
      dist,
      target,
      ortho,
      orthoHalfHeight: dist * Math.tan(FOV_Y / 2),
    };
    redrawRef.current = () => render(null);
    redrawRef.current();
  }, [ready, view3d, applyViewPreset, render]);

  // Darstellungsart (volle RenderMode-Union) an den Renderer weiterreichen,
  // sobald sie wechselt oder der Renderer bereit wird — dann mit der aktuell
  // aktiven Kamera (Praeset ODER Orbit) neu zeichnen.
  useEffect(() => {
    if (!ready) return;
    setRenderStyle(renderMode);
    redrawRef.current();
  }, [ready, renderMode, setRenderStyle]);

  // Boden-Referenzraster: bei Bereitschaft oder Wechsel von Sichtbarkeit/
  // Geschoss-Hoehe neu setzen + zeichnen. Fixe Ausdehnung/Abstand (40 m /
  // 1 m) — ausreichend fuer die ueblichen Grundriss-Groessen dieses Spikes.
  useEffect(() => {
    if (!ready) return;
    setGroundGrid(gridVisible, groundElevation, 40, 1);
    redrawRef.current();
  }, [ready, gridVisible, groundElevation, setGroundGrid]);

  // Live-Schnitt: bei Bereitschaft, Umschalten (`sectionActive`) oder
  // Modelländerung neu setzen. MVP-Ebene = vertikal durch die Modellmitte
  // (`fitTargetDist`-Ziel), Blick nach +Y -> Normale [0,0,1] (Grundriss-Y =
  // world Z, s. section.rs `looking_plus_y`). Bei aktivem Schnitt baut Rust die
  // Schnittflaechen-Schraffur (Caps) aus den gecachten Waenden/Decken.
  useEffect(() => {
    if (!ready) return;
    // Bei inaktivem Schnitt braucht es kein Ziel (Ebene ist ohnehin unsichtbar)
    // — `fitTargetDist` NICHT aufrufen, das würde sonst bei JEDER Projekt-
    // Änderung (auch waehrend eines Griff-Drags) unnoetig die komplette
    // Wand-/Oeffnungs-/Decken-Geometrie erneut flatten, nur um eine Bounding-
    // Box zu ziehen, die `updateModel` fuer denselben `project`-Stand gerade
    // erst berechnet hat.
    if (!sectionActive) {
      setSectionPlane(false, [0, 0, 0], [0, 0, 1]);
      redrawRef.current();
      return;
    }
    const { target } = fitTargetDist(project);
    setSectionPlane(true, target, [0, 0, 1]);
    redrawRef.current();
  }, [ready, sectionActive, project, setSectionPlane]);

  // Auswahl-Hervorhebung: bei Bereitschaft oder Änderung der Highlight-Linien
  // (Auswahl gewechselt/aufgehoben) neu setzen + zeichnen. Die Engine hält das
  // Highlight, bis es erneut gesetzt wird — Kamerabewegungen (Orbit/Pan/Zoom)
  // lösen hier KEINEN neuen `setHighlightLines`-Aufruf aus, das Highlight
  // bleibt einfach über den nächsten `render()`-Aufruf hinweg sichtbar.
  useEffect(() => {
    if (!ready) return;
    setHighlightLines(highlightLines ?? new Float32Array(0));
    redrawRef.current();
  }, [ready, highlightLines, setHighlightLines]);

  // Griff-Bildschirmpositionen: solange Wände/2D-Zeichnungen zum Editieren
  // gewählt sind, pollt ein rAF-Loop ihre Griffpunkte durch die aktuelle
  // Kamera auf Bildschirm-Pixel — die DOM-Buttons unten im JSX folgen so
  // Orbit/Pan/Zoom UND Modelländerungen (Drag), ohne dass Kamerabewegungen
  // einen WASM-Push auslösen (reine 2D-Projektionsmathe, kein GPU-Aufruf).
  const [gripScreens, setGripScreens] = useState<{ grip: Grip; x: number; y: number }[]>([]);
  useEffect(() => {
    if (
      !ready ||
      (editWalls.length === 0 &&
        editDrawings.length === 0 &&
        editCeilings.length === 0 &&
        editRoofs.length === 0)
    ) {
      setGripScreens([]);
      return;
    }
    let raf = 0;
    const tick = () => {
      const canvas = canvasRef.current;
      const o = orbitRef.current;
      if (canvas && o) {
        const rect = canvas.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const cam = orbitCamera(o);
          const grips = computeGrips(
            projectRef.current,
            editWallsRef.current,
            editDrawingsRef.current,
            editCeilingsRef.current,
            editRoofsRef.current,
            groundElevationRef.current,
          );
          const next: { grip: Grip; x: number; y: number }[] = [];
          for (const g of grips) {
            const p = worldToScreen(cam, g.pos, rect.width, rect.height);
            if (p) next.push({ grip: g, x: p.x, y: p.y });
          }
          setGripScreens(next);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [ready, editWalls, editDrawings, editCeilings, editRoofs]);

  // Canvas-Größe beobachten: bei Layout-Änderung mit aktueller Kamera neu
  // zeichnen (die Surface-Anpassung übernimmt der Hook im render()).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!ready || !canvas) return;
    const ro = new ResizeObserver(() => redrawRef.current());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [ready]);

  // ── Griff-Drag (DOM-Buttons, s. Datei-Kommentar oben) ─────────────────────
  // Der Drag-Zustand lebt in einem Ref (kein State) — die Pointer-Handler an
  // den Buttons sind normale React-Props, aber der Ref überlebt zwischen
  // Pointer-Move-Events, ohne bei jedem Frame einen Re-Render auszulösen.
  // "vertex"/"move" ziehen auf einer horizontalen Arbeitsebene (Wand-UK bzw.
  // Geschossebene für Zeichnungen) — exakt wie `workplaneModel` im three.js-
  // Pfad; "height" zieht auf einer VERTIKALEN Ebene entlang der Wandachse
  // (analog `heightZAt` dort), damit eine überwiegend vertikale Mausbewegung
  // auf eine Höhenänderung abbildet.
  type GripTarget = { wallId?: string; drawingId?: string; ceilingId?: string; roofId?: string };
  type GripDrag =
    | { kind: "vertex"; target: GripTarget; index: number; planeY: number }
    | { kind: "move"; target: GripTarget; planeY: number; lastModel: Vec2 | null }
    | { kind: "edge"; ceilingId: string; a: number; b: number; planeY: number; lastModel: Vec2 | null }
    | { kind: "height"; wallId: string }
    | { kind: "roofpitch"; roofId: string; apexXZ: readonly [number, number] };
  const gripDragRef = useRef<GripDrag | null>(null);
  // Arbeitsebene (world-Y) eines Griffs: Wand-UK, Decken-OK, Dach-Traufe bzw. Geschossebene.
  const gripPlaneY = (target: GripTarget): number | null => {
    if (target.wallId) {
      const wall = editWallsRef.current.find((w) => w.id === target.wallId);
      return wall ? wallVerticalExtent(projectRef.current, wall).zBottom : null;
    }
    if (target.ceilingId) {
      const c = editCeilingsRef.current.find((x) => x.id === target.ceilingId);
      return c ? ceilingVerticalExtent(projectRef.current, c).zTop : null;
    }
    if (target.roofId) {
      const r = editRoofsRef.current.find((x) => x.id === target.roofId);
      return r ? roofBaseElevation(projectRef.current, r) : null;
    }
    return groundElevationRef.current;
  };
  const startGripDrag = (grip: Grip) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (grip.kind === "height") {
      if (!grip.target.wallId) return;
      gripDragRef.current = { kind: "height", wallId: grip.target.wallId };
    } else if (grip.kind === "roofpitch") {
      if (!grip.target.roofId) return;
      // Vertikaler Drag am First; XZ-Position (world) des Apex als Achse merken.
      gripDragRef.current = { kind: "roofpitch", roofId: grip.target.roofId, apexXZ: [grip.pos[0], grip.pos[2]] };
    } else {
      const planeY = gripPlaneY(grip.target);
      if (planeY == null) return;
      if (grip.kind === "vertex") {
        gripDragRef.current = { kind: "vertex", target: grip.target, index: grip.index, planeY };
      } else if (grip.kind === "edge" && grip.target.ceilingId && grip.index2 != null) {
        gripDragRef.current = {
          kind: "edge",
          ceilingId: grip.target.ceilingId,
          a: grip.index,
          b: grip.index2,
          planeY,
          lastModel: null,
        };
      } else {
        gripDragRef.current = { kind: "move", target: grip.target, planeY, lastModel: null };
      }
    }
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onGripPointerMove = (e: React.PointerEvent) => {
    const drag = gripDragRef.current;
    const o = orbitRef.current;
    const canvas = canvasRef.current;
    if (!drag || !o || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const ndcX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    const ndcY = 1 - ((e.clientY - rect.top) / rect.height) * 2;
    const ray = cameraRay(orbitCamera(o), ndcX, ndcY, rect.width / rect.height);

    if (drag.kind === "height") {
      const wall = editWallsRef.current.find((w) => w.id === drag.wallId);
      if (!wall) return;
      const ux = wall.end.x - wall.start.x;
      const uy = wall.end.y - wall.start.y;
      const len = Math.hypot(ux, uy) || 1;
      const midX = (wall.start.x + wall.end.x) / 2;
      const midY = (wall.start.y + wall.end.y) / 2;
      const hit = rayPlane(ray, [midX, 0, midY], [ux / len, 0, uy / len]);
      if (!hit) return;
      onEditWallTopRef.current?.(drag.wallId, hit[1]);
      return;
    }

    if (drag.kind === "roofpitch") {
      // Vertikaler First-Drag: Strahl auf eine senkrechte Ebene durch die
      // Apex-Achse (world-XZ) projizieren, world-Y = neue First-Höhe abgreifen.
      // Ebenen-Normale horizontal zur Kamera, damit der Drag stabil folgt.
      const cam = orbitCamera(o);
      let nx = cam.eye[0] - drag.apexXZ[0];
      let nz = cam.eye[2] - drag.apexXZ[1];
      const nlen = Math.hypot(nx, nz) || 1;
      nx /= nlen;
      nz /= nlen;
      const hitR = rayPlane(ray, [drag.apexXZ[0], 0, drag.apexXZ[1]], [nx, 0, nz]);
      if (!hitR) return;
      onEditRoofPitchRef.current?.(drag.roofId, hitR[1]);
      return;
    }

    const hit = rayPlaneY(ray, drag.planeY);
    if (!hit) return;
    const model: Vec2 = { x: hit[0], y: hit[2] };
    if (drag.kind === "vertex") {
      onEditVertexRef.current?.(drag.target, drag.index, model);
      return;
    }
    if (drag.kind === "edge") {
      // Kanten-Griff (Decke): inkrementelles Delta auf beide Kanten-Endpunkte.
      if (drag.lastModel) {
        const delta: Vec2 = { x: model.x - drag.lastModel.x, y: model.y - drag.lastModel.y };
        if (delta.x !== 0 || delta.y !== 0)
          onEditEdgeRef.current?.(drag.ceilingId, drag.a, drag.b, delta);
      }
      drag.lastModel = model;
      return;
    }
    // "move": inkrementelles Delta wie im three.js-Pendant (workplaneModel + lastModel).
    if (drag.lastModel) {
      const delta: Vec2 = { x: model.x - drag.lastModel.x, y: model.y - drag.lastModel.y };
      if (delta.x !== 0 || delta.y !== 0) onEditBodyRef.current?.(drag.target, delta);
    }
    drag.lastModel = model;
  };
  const endGripDrag = () => {
    if (!gripDragRef.current) return;
    gripDragRef.current = null;
    onEditEndRef.current?.();
  };

  // Maus-Navigation (LINKS = Orbit, MITTE/RECHTS = Pan, RAD = Zoom, s.
  // Datei-Kommentar MAUS-SCHEMA). Verlässt damit IMMER die Praeset-Kamera und
  // wechselt auf die freie perspektivische Orbit-Kamera (Kontinuität über den
  // in VIEW3D_ORBIT vorbereiteten Start-Blickwinkel) — gleiche Philosophie wie
  // OrbitControls in der three.js-Sicht, nur mit laptop-freundlicher
  // Tastenbelegung ohne Modifier (s. o.).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!ready || !canvas) return;

    const useOrbitRedraw = () => {
      redrawRef.current = () => {
        if (orbitRef.current) render(orbitCamera(orbitRef.current));
      };
    };

    let drag: {
      mode: "orbit" | "pan";
      button: number;
      x: number;
      y: number;
      downX: number;
      downY: number;
      moved: boolean;
    } | null = null;

    const redraw = () => redrawRef.current();

    // Cursor-Pixel (Client) → NDC, relativ zum Canvas-Rechteck. `null`, wenn
    // das Canvas gerade keine Ausdehnung hat (z. B. verstecktes Layout).
    const toNdc = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      return {
        ndcX: ((clientX - rect.left) / rect.width) * 2 - 1,
        ndcY: 1 - ((clientY - rect.top) / rect.height) * 2, // Pixel-Y invertiert
        aspect: rect.width / rect.height,
      };
    };

    // Cursor-Pixel → Kamerastrahl (aktuelle Orbit-Kamera) → nächstes Bauteil.
    // Meldet den Treffer (oder null) an den Aufrufer; `additive` wird vom
    // pointerup-Modifier bestimmt. Frische Pick-Geometrie je Klick (selten genug).
    const doPick = (clientX: number, clientY: number, additive: boolean) => {
      const cb = onPick3dRef.current;
      const o = orbitRef.current;
      const ndc = toNdc(clientX, clientY);
      if (!cb || !o || !ndc) return;
      const ray = cameraRay(orbitCamera(o), ndc.ndcX, ndc.ndcY, ndc.aspect);
      const { walls, slabs, openings, stairs, roofs } = pickGeometry(projectRef.current);
      // Erweiterter Pick inkl. Öffnungen (Fenster/Türen) + Treppen — sonst wären
      // im WASM-Viewport nur Wände/Decken anwählbar.
      const hit = pickNearest(ray, walls, slabs, openings, stairs, roofs);
      cb(hit ? { kind: hit.kind, id: hit.id } : null, additive);
    };

    const onPointerDown = (e: PointerEvent) => {
      const mode = e.button === 0 ? "orbit" : e.button === 1 || e.button === 2 ? "pan" : null;
      if (!mode) return;
      e.preventDefault();
      drag = {
        mode,
        button: e.button,
        x: e.clientX,
        y: e.clientY,
        downX: e.clientX,
        downY: e.clientY,
        moved: false,
      };
      canvas.setPointerCapture(e.pointerId);
      useOrbitRedraw();
    };

    const onPointerMove = (e: PointerEvent) => {
      const o = orbitRef.current;
      if (!drag || !o) return;
      // Bewegung über die Schwelle ⇒ echter Drag (kein Klick beim Loslassen).
      if (
        !drag.moved &&
        Math.hypot(e.clientX - drag.downX, e.clientY - drag.downY) >= CLICK_THRESHOLD_PX
      ) {
        drag.moved = true;
      }
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      const h = canvas.clientHeight || 1;
      if (drag.mode === "orbit") {
        // Winkel je Pixel wie OrbitControls: voller Umlauf über die Viewport-Höhe.
        o.yaw += (2 * Math.PI * dx) / h;
        o.pitch = Math.max(
          -PITCH_LIMIT,
          Math.min(PITCH_LIMIT, o.pitch + (2 * Math.PI * dy) / h),
        );
      } else {
        // Pan in der Bildebene: Welt-Meter je Pixel. In Ortho aus der (dist-
        // unabhaengigen) Bild-Halbhoehe, sonst aus Distanz + Sichtwinkel — sonst
        // driftet die Pan-Geschwindigkeit gegen einen Ortho-Zoom, der `dist` gar
        // nicht mehr anfasst. Ziel entgegen der Mausrichtung (Szene folgt Cursor).
        const worldPerPx = o.ortho
          ? (2 * o.orthoHalfHeight) / h
          : (2 * o.dist * Math.tan(FOV_Y / 2)) / h;
        const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, o.pitch));
        // Kamera-Basis aus dem Orbit: f = Blickrichtung, s = rechts, u = Kamera-oben.
        const f = [
          -Math.cos(pitch) * Math.cos(o.yaw),
          -Math.sin(pitch),
          -Math.cos(pitch) * Math.sin(o.yaw),
        ];
        const s = [Math.sin(o.yaw), 0, -Math.cos(o.yaw)];
        const u = [
          s[1] * f[2] - s[2] * f[1],
          s[2] * f[0] - s[0] * f[2],
          s[0] * f[1] - s[1] * f[0],
        ];
        o.target[0] += (-s[0] * dx + u[0] * dy) * worldPerPx;
        o.target[1] += (-s[1] * dx + u[1] * dy) * worldPerPx;
        o.target[2] += (-s[2] * dx + u[2] * dy) * worldPerPx;
      }
      redraw();
    };

    // Cleanup einer Geste (Capture lösen, Drag-Zustand fallenlassen).
    const releaseDrag = (e: PointerEvent) => {
      drag = null;
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    };

    // Loslassen: war es ein LINKS-Klick ohne nennenswerte Bewegung (kein Orbit),
    // löse einen Pick aus. Sonst nur aufräumen. additive = Shift/Ctrl/Meta.
    const onPointerUp = (e: PointerEvent) => {
      if (!drag) return;
      const wasClick = drag.button === 0 && drag.mode === "orbit" && !drag.moved;
      const additive = e.shiftKey || e.ctrlKey || e.metaKey;
      releaseDrag(e);
      if (wasClick) doPick(e.clientX, e.clientY, additive);
    };

    // Abgebrochene Geste (z. B. Fensterwechsel) — nie als Klick werten.
    const onPointerCancel = (e: PointerEvent) => {
      if (!drag) return;
      releaseDrag(e);
    };

    const onWheel = (e: WheelEvent) => {
      const o = orbitRef.current;
      if (!o) return;
      e.preventDefault();
      useOrbitRedraw();
      // Ortho-Modus („locked iso"): eine echte Ortho-Kamera skaliert ihr Bild ueber
      // die Halbhoehe, NICHT ueber den Augabstand — `dist` zu dollyen haette hier
      // keinen sichtbaren Effekt. Also orthoHalfHeight multiplikativ skalieren und
      // frueh raus (Eye/dist unangetastet). Zoom-to-Cursor bleibt in Ortho zentrisch
      // — die cursor-versetzte Dolly-Logik unten ist perspektiv-only.
      if (o.ortho) {
        o.orthoHalfHeight = Math.max(
          0.05,
          Math.min(500, o.orthoHalfHeight * Math.exp(e.deltaY * 0.0013)),
        );
        redraw();
        return;
      }
      const prevDist = o.dist;
      // Exponentielles Dolly (rad-deltaY ≈ ±100 je Rastung → ~14 % je Schritt).
      o.dist = Math.max(0.2, Math.min(2000, o.dist * Math.exp(e.deltaY * 0.0013)));
      // Zoom-to-Cursor-Näherung (kein Tiefenwert unter dem Cursor verfügbar):
      // das Blickziel anteilig der Distanzänderung in Richtung des Cursor-
      // Strahls IN DER BILDEBENE verschieben (Bildschirm-Basis s/u aus dem
      // Orbit-Winkel, wie beim Pan). Bei Cursor in Bildmitte (ndcX=ndcY=0)
      // bleibt es ein reines Distanz-Dolly (Verschiebung = 0); je weiter der
      // Cursor vom Zentrum, desto mehr wandert das Ziel darauf zu — spürbar
      // besser bedienbar als ein reines Mittendolly, ohne echte Tiefenprojektion.
      const rect = canvas.getBoundingClientRect();
      const ndcX = rect.width > 0 ? ((e.clientX - rect.left) / rect.width) * 2 - 1 : 0;
      const ndcY = rect.height > 0 ? 1 - ((e.clientY - rect.top) / rect.height) * 2 : 0;
      const distDelta = prevDist - o.dist; // > 0 beim Reinzoomen
      if (distDelta !== 0 && (ndcX !== 0 || ndcY !== 0)) {
        const pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, o.pitch));
        const f = [
          -Math.cos(pitch) * Math.cos(o.yaw),
          -Math.sin(pitch),
          -Math.cos(pitch) * Math.sin(o.yaw),
        ];
        const s = [Math.sin(o.yaw), 0, -Math.cos(o.yaw)];
        const u = [
          s[1] * f[2] - s[2] * f[1],
          s[2] * f[0] - s[0] * f[2],
          s[0] * f[1] - s[1] * f[0],
        ];
        // Bildhalbhöhe je Distanz-Einheit (Sichtwinkel) × halbe Distanzänderung
        // (gedämpft — voller Betrag würde den Cursor-Punkt exakt zentrieren,
        // was sich bei wiederholtem Scrollen zu ruckartig anfühlt).
        const shift = distDelta * Math.tan(FOV_Y / 2) * 0.5;
        o.target[0] += (s[0] * ndcX + u[0] * ndcY) * shift;
        o.target[1] += (s[1] * ndcX + u[1] * ndcY) * shift;
        o.target[2] += (s[2] * ndcX + u[2] * ndcY) * shift;
      }
      redraw();
    };

    // Browser-Kontextmenü unterdrücken (RECHTS navigiert jetzt selbst, s. o.;
    // ein eigenes Kontextmenü gibt es im Engine-Pfad noch nicht).
    const onContextMenu = (e: MouseEvent) => e.preventDefault();

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("contextmenu", onContextMenu);
    };
  }, [ready, render]);

  return (
    <div className="viewport">
      {/* Canvas-Anzeigegröße kommt aus `.viewport canvas` (styles.css); die
          Renderauflösung (DPR) gleicht der Hook je Frame ab. Presets +
          Darstellungsart kommen von der Oberleiste (TopBar); das Grid-Overlay
          unten ist der einzige eigene Umschalter hier. */}
      <canvas ref={canvasRef} data-engine="render3d" />
      {/* 3D-Editier-Griffe: echte DOM-Buttons statt In-Szene-Geometrie, s.
          Datei-Kommentar oben. Position folgt der Kamera via `gripScreens`
          (rAF-Loop). Farben wie die three.js-Griffe (`Viewport3D.tsx`,
          gripVertMat/gripHeightMat/gripMoveMat): Vertex orange, Höhe blau,
          Verschieben grün. */}
      {gripScreens.map(({ grip, x, y }) => (
        <div
          key={`${grip.kind}:${grip.target.wallId ?? grip.target.drawingId ?? grip.target.ceilingId ?? grip.target.roofId}:${grip.index}`}
          onPointerDown={startGripDrag(grip)}
          onPointerMove={onGripPointerMove}
          onPointerUp={endGripDrag}
          onPointerCancel={endGripDrag}
          title={t(
            grip.kind === "height"
              ? "viewport3d.grip.height"
              : grip.kind === "roofpitch"
              ? "viewport3d.grip.roofpitch"
              : grip.kind === "move"
              ? "viewport3d.grip.move"
              : grip.kind === "edge"
              ? "viewport3d.grip.edge"
              : "viewport3d.grip.vertex",
          )}
          style={{
            position: "absolute",
            left: x - 8,
            top: y - 8,
            width: 16,
            height: 16,
            // Kanten-Griffe rautenförmig + eigene Farbe, damit sie sich klar von
            // den Eckpunkt-Griffen abheben (Nutzer-Wunsch: „an allen seiten").
            borderRadius: grip.kind === "edge" ? "3px" : "50%",
            transform: grip.kind === "edge" ? "rotate(45deg)" : undefined,
            background:
              grip.kind === "height"
                ? "#2f8fff"
                : grip.kind === "roofpitch"
                ? "#ff4d9d"
                : grip.kind === "move"
                ? "#18b85a"
                : grip.kind === "edge"
                ? "#b06cff"
                : "#ff8c1a",
            border: "2px solid rgba(0,0,0,0.6)",
            boxShadow: "0 0 5px rgba(0,0,0,0.55)",
            cursor:
              grip.kind === "height" || grip.kind === "roofpitch" ? "ns-resize" : "grab",
            touchAction: "none",
          }}
        />
      ))}
      {/* Live-Schnitt-Umschalter (eigener Overlay-Button, MVP): vertikale
          Schnittebene durch die Modellmitte, Blick +Y. Sitzt ueber dem
          Grid-Button (falls vorhanden). Reine Ansichts-Option des Viewports. */}
      <button
        type="button"
        aria-label={t("viewport3d.section.label")}
        onClick={() => setSectionActive((v) => !v)}
        title={t(sectionActive ? "viewport3d.section.hide" : "viewport3d.section.show")}
        aria-pressed={sectionActive}
        style={{
          position: "absolute",
          right: 10,
          bottom: onToggleGrid ? 48 : 10,
          width: 30,
          height: 30,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          borderRadius: 7,
          border: "1px solid rgba(255,255,255,0.14)",
          background: sectionActive ? "rgba(255,255,255,0.14)" : "rgba(20,20,24,0.65)",
          color: sectionActive ? "#f2f2f2" : "#9a9a9a",
          cursor: "pointer",
          backdropFilter: "blur(4px)",
        }}
      >
        <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18 }}>
          content_cut
        </span>
      </button>
      {onToggleGrid && (
        // Dezenter Overlay-Button (eigener DOM-Knoten neben dem Canvas, `.viewport`
        // ist `position: relative` — s. styles.css), stört die Maus-Navigation
        // auf dem Canvas nicht. Keine eigene CSS-Klasse (styles.css ist nicht in
        // dieser Datei-Lane) — Inline-Style im dunklen App-Look.
        <button
          type="button"
          onClick={onToggleGrid}
          title={t(gridVisible ? "viewport3d.grid.hide" : "viewport3d.grid.show")}
          aria-pressed={gridVisible}
          style={{
            position: "absolute",
            right: 10,
            bottom: 10,
            width: 30,
            height: 30,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            borderRadius: 7,
            border: "1px solid rgba(255,255,255,0.14)",
            background: gridVisible ? "rgba(255,255,255,0.14)" : "rgba(20,20,24,0.65)",
            color: gridVisible ? "#f2f2f2" : "#9a9a9a",
            cursor: "pointer",
            backdropFilter: "blur(4px)",
          }}
        >
          <span className="material-symbols-outlined" aria-hidden="true" style={{ fontSize: 18 }}>
            {gridVisible ? "grid_on" : "grid_off"}
          </span>
        </button>
      )}
      {failed && (
        <div className="viewport-fallback">
          <strong>{t("viewport3d.engineUnavailable")}</strong>
          <span>{t("viewport3d.engineUnavailableHint")}</span>
        </div>
      )}
    </div>
  );
}

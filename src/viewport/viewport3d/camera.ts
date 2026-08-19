// Kamera-Helfer der three.js-3D-Ansicht: Ortho-Frustum-Bemessung + die
// kanonischen Blickwinkel-Presets (Vectorworks/DOSSIER-Konvention).

import type { MutableRefObject } from "react";
import * as THREE from "three";
import type { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { Project } from "../../model/types";
import type { View3d } from "../../ui/TopBar";

/** Stabiler Schlüssel der sichtbaren Geschosse (IDs in Dokumentreihenfolge). */
export function visibleFloorKey(project: Project): string {
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
export function updateOrthoFrustum(
  camera: THREE.OrthographicCamera,
  bounds: THREE.Box3,
  aspect: number,
): void {
  const size = bounds.getSize(new THREE.Vector3());
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
export function applyView3d(
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

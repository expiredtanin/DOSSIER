// BCF ↔ 3D-Viewport: reine Umrechnung von Kamera und Schnittebene zwischen der Modell-Sicht der
// Kamera-Brücke (`viewport/cameraBridge.ts`, Meter, z oben, lokale Modell-Koordinaten) und den
// BCF-Koordinaten (IFC-Weltkoordinaten, Meter, Z oben).
//
// BEZUG ZUM IFC: `exportIfcSpf` schreibt mit Standort-Bezug alle Bauteile um den LV95-Ursprung
// verschoben (`projectToWorldCoords`: x += e, y += n; die Höhe bleibt, `geoAnchor.height` ist nur
// `RefElevation`). Ohne Bezug bleibt das Modell lokal. BCF-Viewpoints müssen dazu passen, sonst
// zeigt die Kamera ins Leere: Modell → BCF addiert (e, n, 0), BCF → Modell zieht ab.
//
// Annahmen (BCF 2.1/3.0, Viewpoint):
//  · FieldOfView = vertikaler Öffnungswinkel in Grad (wie die Fassade `io/bcf.ts` führt);
//  · ViewToWorldScale (orthogonal) = sichtbare BREITE in Metern; die Höhe folgt aus dem
//    Seitenverhältnis (`aspectRatio`, fehlt es: das des Viewports);
//  · ClippingPlane.Direction zeigt auf die weggeschnittene Seite — wie `set_section_plane`.
// Der Live-Schnitt kann nur senkrechte Ebenen (render3d); schräge zeigt das Panel nur an.

import { newViewpoint, type BcfCamera, type BcfClippingPlane, type BcfTopic, type BcfViewpoint, type Vec3 } from "../io/bcf";
import { isVerticalSection, type ViewCamera, type ViewSection, type V3 } from "../viewport/cameraBridge";

/** LV95-Ursprung des Projekts (`projectGeoOrigin`) oder null ohne Standort-Bezug. */
export interface GeoOffset {
  e: number;
  n: number;
}

const off = (o: GeoOffset | null): [number, number, number] => [o?.e ?? 0, o?.n ?? 0, 0];
const add = (p: readonly number[], d: readonly number[]): Vec3 => [p[0] + d[0], p[1] + d[1], p[2] + d[2]];
const sub = (p: readonly number[], d: readonly number[]): V3 => [p[0] - d[0], p[1] - d[1], p[2] - d[2]];
const ok3 = (v: readonly number[]): boolean => v.length >= 3 && v.every(Number.isFinite);
const nonzero = (v: readonly number[]): boolean => Math.hypot(v[0], v[1], v[2]) > 1e-12;

/** Modell-Kamera → BCF-Kamera (Weltkoordinaten). */
export function bcfCameraFromView(vc: ViewCamera, origin: GeoOffset | null): BcfCamera {
  const ortho = vc.kind === "orthogonal";
  return {
    kind: vc.kind,
    position: add(vc.position, off(origin)),
    direction: [...vc.direction] as Vec3,
    up: [...vc.up] as Vec3,
    fieldOfView: ortho ? 0 : vc.fovDeg,
    viewToWorldScale: ortho ? vc.orthoHeight * vc.aspect : 0,
    aspectRatio: vc.aspect,
  };
}

/**
 * BCF-Kamera → Modell-Kamera. `viewportAspect` springt ein, wenn die Datei kein Seitenverhältnis
 * trägt (BCF schreibt es nur für perspektivische Kameras). Null bei Unsinn (NaN, Nullrichtung).
 */
export function viewCameraFromBcf(bc: BcfCamera, origin: GeoOffset | null, viewportAspect: number): ViewCamera | null {
  if (!ok3(bc.position) || !ok3(bc.direction) || !ok3(bc.up)) return null;
  if (!nonzero(bc.direction)) return null;
  const aspect = bc.aspectRatio > 0 && Number.isFinite(bc.aspectRatio) ? bc.aspectRatio : viewportAspect > 0 ? viewportAspect : 1;
  const ortho = bc.kind === "orthogonal";
  const scale = Number.isFinite(bc.viewToWorldScale) && bc.viewToWorldScale > 0 ? bc.viewToWorldScale : 0;
  // Zeigt der Up-Vektor entlang der Blickrichtung (oder fehlt er), nimmt die Brücke einen Ersatz.
  const up: V3 = nonzero(bc.up) ? [...bc.up] : [0, 0, 1];
  return {
    kind: bc.kind,
    position: sub(bc.position, off(origin)),
    direction: [...bc.direction] as V3,
    up,
    fovDeg: bc.fieldOfView > 0 && Number.isFinite(bc.fieldOfView) ? bc.fieldOfView : 60,
    // orthogonal: Breite → Höhe über das Seitenverhältnis der Datei, ersatzweise des Viewports
    orthoHeight: ortho ? (scale > 0 ? scale / aspect : 10) : 0,
    aspect: viewportAspect > 0 ? viewportAspect : aspect,
  };
}

/** Schnittebene Modell → BCF. */
export function bcfClippingFromSection(s: ViewSection, origin: GeoOffset | null): BcfClippingPlane {
  return { location: add(s.location, off(origin)), direction: [...s.direction] as Vec3 };
}

/** BCF-Schnittebene → Modell; null, wenn nicht senkrecht (nicht live darstellbar) oder unbrauchbar. */
export function sectionFromBcfClipping(c: BcfClippingPlane, origin: GeoOffset | null): ViewSection | null {
  if (!ok3(c.location) || !ok3(c.direction) || !nonzero(c.direction)) return null;
  const s: ViewSection = { location: sub(c.location, off(origin)), direction: [...c.direction] as V3 };
  return isVerticalSection(s) ? s : null;
}

/** Erster Viewpoint des Themas mit Kamera (das Panel springt dorthin), sonst null. */
export function firstViewpointWithCamera(topic: Pick<BcfTopic, "viewpoints">): BcfViewpoint | null {
  return topic.viewpoints.find((v) => v.camera !== null) ?? null;
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Neuer Viewpoint aus Auswahl + aktueller Kamera (+ Schnitt) + Snapshot; fehlende Teile bleiben leer. */
export function viewpointForTopic(init: {
  guid: string;
  ifcGuids: string[];
  camera: ViewCamera | null;
  snapshotPng: Uint8Array | null;
  origin: GeoOffset | null;
  section?: ViewSection | null;
}): BcfViewpoint {
  const vp = newViewpoint(init.guid, init.ifcGuids, init.camera ? bcfCameraFromView(init.camera, init.origin) : null);
  if (init.snapshotPng && init.snapshotPng.length > 0) vp.snapshot = toBase64(init.snapshotPng);
  if (init.section) vp.clippingPlanes = [bcfClippingFromSection(init.section, init.origin)];
  return vp;
}

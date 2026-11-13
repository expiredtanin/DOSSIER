/**
 * React-Hook für den nativen render3d-Renderer als WASM/WebGPU-Viewport.
 *
 * Gegenstück zu {@link useWasmPlanRenderer} (2D): lädt das WASM-Modul aus
 * src/engine/pkg3d (`npm run build:engine3d`), bindet den Renderer an ein
 * Canvas und reicht Modell + Kamera durch. Die eigentliche Zeichenlogik lebt
 * in Rust (src-tauri/render3d, Feature `web`) — dieselbe Extrusion/Pipeline
 * wie das native wgpu-Fenster.
 *
 * Modell-Sync: `updateModel(project)` holt das Modell in Teilen
 * ({@link projectToModel3dParts}, je Wand-/Öffnungs-Eintrag des Kern-Caches plus Rest-Gruppen) und
 * schickt nur Geändertes an `set_parts` ([58]); mit Explosion das ganze Modell
 * ({@link projectToModel3d}) als JSON an `set_model` — dasselbe Format wie der
 * native Tauri-Push (nativeSync.ts).
 *
 * Fällt bei fehlendem WebGPU oder Init-Fehler auf `ready:false` + `failed:true`
 * zurück; der Aufrufer (Wasm3DViewport) zeigt dann den Hinweis-Fallback.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextImage, Project } from "../model/types";
import { GhostLayerSync } from "./ghostSync";
import { emitDrawingLineVerts, emitSurfacePatternLines, filter3d, ghostFilter3d, hiddenClassCodes, pathtraceMaterials, projectToModel3d, projectToModel3dParts, siteEnvelope3d } from "../core";
import type { Hide3d } from "../core";
import { Model3dPartsSync } from "./model3dPartsSync";
import type { DetailLevel } from "../model/viewTypes";
import { loadEngine3d } from "../engine/engine3d";
import { decodeMaterialTextures } from "./materialTextures";
import { decodeImageToRgba } from "../io/swissImage";
import { planPointCloudSync } from "./pointCloudSync";
import { PT_EXPORT_MAX_PIXELS, clampImageSize, exportSamples, isBlankImage, matteFromBlackWhite, renderPathtraceChunks, type ExportProgress } from "./imageExport";
import type { PointCloudSyncItem, UploadedPointCloud } from "./pointCloudSync";

/** Fertige Kamera für einen Frame (world-Meter, Y-up — wie render3d::types::Camera). */
export interface Camera3d {
  eye: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  /** true = perspektivisch (fovY), false = orthografisch (orthoHalfHeight). */
  perspective: boolean;
  /** Vertikaler Öffnungswinkel in RADIANT (nur perspektivisch). */
  fovY: number;
  /** Halbe Sichthöhe in Metern (nur orthografisch). */
  orthoHalfHeight: number;
}

/** Minimal-Typ des WASM-Exports (das echte .d.ts entsteht erst mit `build:engine3d`). */
interface WebModelRendererLike {
  set_model(json: string): void;
  /** Teil-Update ([58], `web::set_parts`): `{ reset?, remove?, upsert? }`, s. `model3dPartsSync.ts`.
   *  Optional — ältere WASM-Builds. */
  set_parts?(json: string): number;
  /** Darstellungsart setzen — `style` ∈ "shaded"|"white"|"wireframe"|"hidden"|
   * "textured" (deckt die volle `RenderMode`-Union der Oberleiste ab;
   * "textured" faellt engine-seitig vorerst auf "shaded" zurueck). */
  set_render_style(style: string): void;
  /** [212] Pathtracing (Stil "pathtrace"): Samples je Pixel des laufenden Bildes und ob die Obergrenze erreicht ist.
   *  Optional — ältere WASM-Builds. */
  pathtrace_samples?(): number;
  pathtrace_done?(): boolean;
  /** [212] Etappe 5: Modell zu gross für die Puffergrenzen des Geräts (Pathtracer zeigt nur den Himmel). */
  pathtrace_too_big?(): boolean;
  /** [212] Etappe 5: Belichtungskorrektur (EV) und Belichtungsautomatik; Raumlicht bei Nacht. */
  set_pathtrace_exposure?(ev: number, auto: boolean): void;
  set_pathtrace_room_light?(on: boolean): void;
  set_view_preset(preset: string): void;
  /** [223] Hintergrundfarbe (0..1) für den Bild-Export mit transparentem Hintergrund. Optional — ältere WASM-Builds. */
  set_clear_color?(r: number, g: number, b: number): void;
  /** Sonne der Sonnenstudie ([64], `web::set_sun`): Azimut/Höhe in Grad, `shadows` = Schatten im 3D.
   *  `active=false` oder Sonne unter dem Horizont: Standardlicht, keine Schatten. Optional — ältere WASM-Builds. */
  set_sun?(active: boolean, azimuthDeg: number, elevationDeg: number, shadows: boolean): void;
  /** Formatfüllendes Ziel + Abstand für Modell UND sichtbare Punktwolken: `[tx, ty, tz, dist]`
   *  (world, Y-oben; `web::view_fit`). Optional — ältere WASM-Builds. */
  view_fit?(): Float32Array | number[];
  /** Aktuelle Rust-Kamera: `[eye(3), target(3), up(3), perspektivisch 1/0, fovY rad, orthoHalbhöhe]`
   *  (`web::camera_state`). Optional — ältere WASM-Builds. */
  camera_state?(): Float32Array | number[];
  /** Boden-Referenzraster in der Welt-XZ-Ebene ein-/ausblenden (Rust-seitig,
   * `web::set_ground_grid`). `visible=false` zeichnet kein Raster; sonst ein
   * Quadrat der Kantenlaenge `extent_m` (zentriert um den Ursprung, XZ) auf
   * Hoehe `elevation_m` (world-Y) mit Linienabstand `spacing_m`. Wirkt erst
   * beim naechsten `render`. */
  set_ground_grid(
    visible: boolean,
    elevation_m: number,
    extent_m: number,
    spacing_m: number,
  ): void;
  /** Live-Schnitt ein-/ausschalten (Rust-seitig, `web::set_section_plane`).
   * `active=false` hebt den Schnitt auf. `p*` = Punkt auf der Ebene, `n*` =
   * Ebenennormale = Blickrichtung (world-Meter, Y-up; nur vertikale Ebenen).
   * Kappt das Modell per Shader-`discard` und fuellt die Schnittflaeche mit der
   * Diagonalschraffur (Caps). Wirkt erst beim naechsten `render`. */
  set_section_plane(
    active: boolean,
    px: number,
    py: number,
    pz: number,
    nx: number,
    ny: number,
    nz: number,
  ): void;
  /**
   * Auswahl-Hervorhebung setzen: ein LineList-Vertex-Array (interleaved
   * `[px,py,pz, r,g,b, ...]`, world-Meter, je 2 Vertices = 1 Linie), das die
   * Engine OHNE Tiefentest zeichnet (immer sichtbar obenauf) — der Umriss des
   * aktuell gewählten Bauteils. Leeres Array löscht das Highlight. Wirkt erst
   * beim nächsten `render`. */
  set_highlight_lines(vertices: Float32Array): void;
  /**
   * 2D-Zeichnungs-Unterlage setzen (`web::set_drawing_lines`): dasselbe
   * LineList-Format wie `set_highlight_lines`, aber tiefengetestet gezeichnet
   * (Bauteile verdecken die Unterlage korrekt). Leeres Array löscht sie.
   * BINÄRER Kanal statt Teil von `set_model`, weil ein Kataster-Import (Mio.
   * Segmente) als JSON weder serialisierbar noch speicherbar wäre — s.
   * `toWalls3d/drawing2d.ts::emitDrawingLineVerts`. Optional — ältere
   * WASM-Builds ohne diesen Export lassen den Aufrufer still zurückfallen. */
  set_drawing_lines?(vertices: Float32Array): void;
  /** Ansichtsschraffur auf den Flächen (`web::set_pattern_lines`), in den Kanten-Stilen gezeichnet. */
  set_pattern_lines?(data: Float32Array): void;
  /** Durchscheinende Körper ([63] zulässige Hülle, `web::set_ghost`): Format von `siteEnvelope3d`; leer löscht. */
  set_ghost?(data: Float32Array): void;
  /** Material-Farbkarten (Stil „textured") als Textur-Array hochladen
   * (`web::set_material_textures`). `rgba` = gepackte RGBA8-Bytes von
   * `layerCount` 256×256-Ebenen; Ebene 0 bleibt intern das Fallback-Schachbrett,
   * die Karten belegen Ebenen 1..N (siehe `WallInput.materialIndex`). Optional —
   * ältere WASM-Builds ohne diesen Export lassen den Aufrufer still zurückfallen. */
  set_material_textures?(rgba: Uint8Array, layerCount: number): void;
  /** [212] Materialtabelle des Pathtracers (`web::set_pathtrace_materials`): JSON `[{ name, map }]` je Textur-Ebene
   *  (gleiche Reihenfolge wie `set_material_textures`). Optional — ältere WASM-Builds. */
  set_pathtrace_materials?(json: string): void;
  /** [212] Etappe 4: Normalen- und Rauigkeitskarten des Pathtracers (`web::set_material_detail_textures`), Ebenen wie
   *  `set_material_textures` (leere Puffer = keine Karten). Optional — ältere WASM-Builds. */
  set_material_detail_textures?(normal: Uint8Array, rough: Uint8Array, layerCount: number): void;
  /** [212] Samples je `render` (Bild-Export rechnet N auf einmal), Entrauscher an/aus, Pixel je Sample (0 = Standard). */
  set_pathtrace_batch?(n: number): void;
  set_pathtrace_denoise?(on: boolean): void;
  set_pathtrace_max_pixels?(n: number): void;
  /** [212] Etappe 3: erfüllt sich, wenn die GPU die abgeschickte Arbeit erledigt hat (Export in Häppchen). */
  gpu_idle?(): Promise<unknown>;
  /** Luftbild aufs Gelände drapieren (`web::set_aerial_texture`): `rgba` =
   *  gepackte RGBA8-Bytes (`width*height*4`, zeilenweise von oben = Nord), plus
   *  Modell-Meter-Bbox (min/max, x=Ost/y=Nord). render3d legt es pixelscharf als
   *  Textur über das Terrain-TIN. Optional — ältere WASM-Builds ohne diesen
   *  Export lassen den Aufrufer still zurückfallen. */
  set_aerial_texture?(
    rgba: Uint8Array,
    width: number,
    height: number,
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): void;
  /** Drapiertes Luftbild löschen (Gelände wieder einfarbig/shaded). Optional. */
  clear_aerial?(): void;
  /** Punktwolke setzen ([27], `web::set_point_cloud`): `xyz` relativ zum Ursprung, `ox/oy/oz` =
   *  Modell-Meter des Ursprungs (f64, Rust addiert in f64). Leere Attribut-Arrays = fehlt.
   *  Liefert die gezeichnete Punktzahl (0 = verworfen). Optional — ältere WASM-Builds. */
  set_point_cloud?(
    id: number,
    xyz: Float32Array,
    rgb: Uint8Array,
    intensity: Uint16Array,
    classification: Uint8Array,
    ox: number,
    oy: number,
    oz: number,
    colorMode: string,
    pointSize: number,
    visible: boolean,
  ): number;
  /** Nur Darstellung ändern; `false` = Wolke unbekannt. */
  set_point_cloud_style?(id: number, colorMode: string, pointSize: number, visible: boolean): boolean;
  remove_point_cloud?(id: number): void;
  /** [180] Geisterschicht der grauen Klassen (Modell-JSON wie `set_model`; leer löscht). */
  set_ghost_model?(json: string): void;
  /** [214] Teil-Update der Geisterschicht (Format wie `set_parts`), `GhostLayerSync`. */
  set_ghost_parts?(json: string): number;
  /** [180] 2D-Spuren und Flächenmuster der Geisterschicht (gedämpft gezeichnet); leer löscht. */
  set_ghost_lines?(drawing: Float32Array, pattern: Float32Array): void;
  set_camera(
    eyeX: number,
    eyeY: number,
    eyeZ: number,
    targetX: number,
    targetY: number,
    targetZ: number,
    upX: number,
    upY: number,
    upZ: number,
    perspective: boolean,
    fovY: number,
    orthoHalfHeight: number,
  ): void;
  resize(w: number, h: number): void;
  render(): void;
}

/**
 * Renderer je Canvas EINMAL erzeugen (memoisiert). Ein Canvas kann nur EINEN
 * WebGPU-Kontext tragen; ein zweiter `WebModelRenderer.new` auf demselben
 * Canvas (StrictMode-Remount) würde kollidieren — die gecachte Promise lässt
 * den Doppelmount denselben Renderer teilen.
 */
const rendererCache = new WeakMap<HTMLCanvasElement, Promise<WebModelRendererLike>>();
function getRenderer(canvas: HTMLCanvasElement): Promise<WebModelRendererLike> {
  let p = rendererCache.get(canvas);
  if (!p) {
    p = (async () => {
      const mod = await loadEngine3d();
      // Canvas VOR dem Surface-Erzeugen auf die Zielpixel (DPR) bringen.
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      return (await mod.WebModelRenderer.new(canvas)) as WebModelRendererLike;
    })();
    rendererCache.set(canvas, p);
    // Bei Fehlschlag den Cache leeren, damit ein späterer Versuch neu startet.
    p.catch(() => rendererCache.delete(canvas));
  }
  return p;
}

/** Was jeder Renderer schon an Modell-Teilen hat ([58]). */
const partsSyncs = new WeakMap<object, Model3dPartsSync>();

/**
 * Modell an den Renderer: ohne Explosion als Teil-Update (nur geänderte Wände/Öffnungen/Gruppen reisen
 * und werden in render3d neu vernetzt und hochgeladen), sonst bzw. bei älteren WASM-Builds und nach
 * einem Fehler das ganze Modell über `set_model`.
 */
function syncModel3d(r: WebModelRendererLike, project: Project, detail: DetailLevel | undefined, explode: number, hide?: Hide3d): void {
  let sync = partsSyncs.get(r);
  if (!sync) partsSyncs.set(r, (sync = new Model3dPartsSync()));
  try {
    const parts = typeof r.set_parts === "function" ? projectToModel3dParts(project, { detail, voids: true, explode, hide }) : null;
    if (parts) {
      const d = sync.diff(parts);
      if (d) r.set_parts!(d.json);
      return;
    }
  } catch (e) {
    console.warn("render3d set_parts fehlgeschlagen, ganzes Modell:", e);
  }
  sync.reset();
  try {
    r.set_model(JSON.stringify(projectToModel3d(project, { detail, voids: true, explode, hide })));
  } catch (e) {
    console.warn("render3d set_model fehlgeschlagen:", e);
  }
}

export function useWasm3dRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
) {
  const rendererRef = useRef<WebModelRendererLike | null>(null);
  /** [212] Bild-Export in Häppchen läuft: das Fenster-Zeichnen (`render`) pausiert, sonst setzte es Grösse und Summe zurück. */
  const exportingRef = useRef(false);
  // Was an Punktwolken im Renderer liegt ([27], s. pointCloudSync.ts).
  const pointCloudsRef = useRef<Map<number, UploadedPointCloud>>(new Map());
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  // WASM-Renderer an das Canvas binden (memoisiert, StrictMode-fest).
  useEffect(() => {
    if (!enabled || !canvasRef.current) {
      setReady(false);
      return;
    }
    let disposed = false;
    const canvas = canvasRef.current;
    void (async () => {
      try {
        const renderer = await getRenderer(canvas);
        if (disposed) return;
        rendererRef.current = renderer;
        ghostSyncRef.current.reset();
        // Neuer (oder wiederverwendeter) Renderer: Punktwolken neu abgleichen.
        pointCloudsRef.current = new Map();
        setReady(true);
        setFailed(false);
      } catch (e) {
        console.warn("render3d WASM/WebGPU-Init fehlgeschlagen", e);
        rendererRef.current = null;
        setReady(false);
        if (!disposed) setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      setReady(false);
    };
  }, [enabled, canvasRef]);

  // Signatur der zuletzt hochgeladenen Material-Textur-Menge — verhindert ein
  // erneutes (teures) Dekodieren/Hochladen, wenn sich die Materialien nicht
  // geändert haben (updateModel läuft bei JEDER Projektänderung).
  const materialSigRef = useRef<string | null>(null);
  // [212] Zuletzt gesetzte Materialtabelle des Pathtracers (JSON) und Darstellungsart (Bild-Export).
  const ptMaterialsRef = useRef<string | null>(null);
  const styleRef = useRef<string>("shaded");
  // [180]/[214] Was render3d an Geisterschicht hat (`ghostSync.ts`).
  const ghostSyncRef = useRef(new GhostLayerSync());
  // Signatur des zuletzt hochgeladenen Drape-Luftbilds (src + Bbox) — verhindert
  // ein erneutes (teures) Dekodieren/Hochladen bei unveränderter Lage.
  const aerialSigRef = useRef<string | null>(null);

  /** Modell bei Projektänderung neu setzen (re-extrudiert in Rust). `detail`
   *  steuert den Öffnungs-Detailgrad (grob/mittel/fein) im 3D wie im Grundriss. `hide`: Klassen, die der
   *  Darstellungsmodus nicht zeichnet ([180]; die im Ebenen-Baum ausgeschalteten blendet der Kern selbst aus),
   *  dazu die Element-Auswahl ([185], {@link Hide3d}). */
  const updateModel = useCallback((project: Project, detail?: DetailLevel, explode = 0, hide?: Hide3d) => {
    const r = rendererRef.current;
    if (!r || !project) return;
    syncModel3d(r, project, detail, explode, hide);
    // 2D-Boden-Spuren als eigener BINÄRER LineList-Kanal — bewusst NICHT Teil
    // des JSON-Modells oben: ein Kataster-DXF (Mio. Segmente) sprengt als
    // Ribbon-Meshes im JSON die String-Längengrenze komplett (Nutzer-Report
    // 2026-10-08, s. `emitDrawingLineVerts`). Eigener try/catch, damit ein
    // Fehler hier das bereits gesetzte Modell nicht mit wegreisst.
    if (typeof r.set_drawing_lines === "function") {
      try {
        r.set_drawing_lines(emitDrawingLineVerts(project, explode, hide));
      } catch (e) {
        console.warn("render3d set_drawing_lines fehlgeschlagen:", e);
      }
    }
    if (typeof r.set_ghost === "function") {
      try {
        // Zulässige Hülle (Baurecht) liegt wie im Grundriss auf `01 Vermessung` ([180]).
        // [185] „Auswahl in 3D zeigen": nur die gewählten Elemente, keine Hülle.
        const off = hiddenClassCodes(project, hide).has("01") || !!filter3d(hide).only;
        r.set_ghost(off ? new Float32Array(0) : siteEnvelope3d(project));
      } catch (e) {
        console.warn("render3d set_ghost fehlgeschlagen:", e);
      }
    }
    if (typeof r.set_ghost_model === "function") {
      try {
        // [180] Klassen im Darstellungsmodus „grau": gedämpft und durchscheinend (render3d `ghost.rs`); im
        // Hauptmodell fehlen sie (Kern `ClassFilter`). Ohne graue Klasse leer (löscht eine frühere Schicht).
        // Graue Geschosse (Zeichnungsebenen-Modus) und ihre 2D-Spuren/Flächenmuster gehören dazu und erscheinen gedämpft.
        // Nur bei geänderter Schicht neu setzen (sonst vernetzt render3d sie bei jeder Projektänderung neu).
        // [214] Als Teile wie das Hauptmodell (nur Geändertes reist und wird neu vernetzt, `GhostLayerSync`); mit
        // Explosion oder älterem WASM als ganzes Modell, nur bei geänderter Prüfsumme.
        const ghost = ghostFilter3d(hide);
        const none = new Float32Array(0);
        const g = ghostSyncRef.current;
        const parts = typeof r.set_ghost_parts === "function" ? (ghost ? projectToModel3dParts(project, { detail, voids: true, explode, hide: ghost }) : null) : undefined;
        if (parts !== undefined && (parts || !ghost)) {
          const json = g.partsUpdate(parts);
          if (json) r.set_ghost_parts!(json);
        } else {
          const json = ghost ? JSON.stringify(projectToModel3d(project, { detail, voids: true, explode, hide: ghost })) : "";
          if (g.modelChanged(json)) r.set_ghost_model(json);
        }
        const drawing = ghost ? emitDrawingLineVerts(project, explode, ghost) : none;
        const pattern = ghost ? emitSurfacePatternLines(project, explode, ghost) : none;
        if (g.linesChanged(drawing, pattern)) r.set_ghost_lines?.(drawing, pattern);
      } catch (e) {
        ghostSyncRef.current.reset();
        console.warn("render3d set_ghost_model fehlgeschlagen:", e);
      }
    }
    if (typeof r.set_pattern_lines === "function") {
      try {
        r.set_pattern_lines(emitSurfacePatternLines(project, explode, hide));
      } catch (e) {
        console.warn("render3d set_pattern_lines fehlgeschlagen:", e);
      }
    }
    // [212] Materialtabelle des Pathtracers (Rauigkeit/Metall/Glas je Baustoff), nur bei Änderung (baut den Baum neu).
    if (typeof r.set_pathtrace_materials === "function") {
      try {
        const json = JSON.stringify(pathtraceMaterials(project));
        if (json !== ptMaterialsRef.current) {
          ptMaterialsRef.current = json;
          r.set_pathtrace_materials(json);
        }
      } catch (e) {
        console.warn("render3d set_pathtrace_materials fehlgeschlagen:", e);
      }
    }
    // Material-Farbkarten (Stil „textured") ASYNCHRON dekodieren + hochladen.
    // Fire-and-forget: bis die Texturen ankommen, zeigt render3d für die
    // betroffenen Bänder das Fallback-Schachbrett (graceful). Nur neu laden,
    // wenn sich die Material-Menge geändert hat.
    if (typeof r.set_material_textures !== "function") return;
    void (async () => {
      try {
        const decoded = await decodeMaterialTextures(project);
        const sig = decoded ? decoded.signature : "";
        if (sig === materialSigRef.current) return; // unverändert
        materialSigRef.current = sig;
        // Renderer könnte zwischenzeitlich getauscht worden sein.
        const cur = rendererRef.current;
        if (!cur || typeof cur.set_material_textures !== "function") return;
        if (decoded) cur.set_material_textures(decoded.data, decoded.count);
        else cur.set_material_textures(new Uint8Array(0), 0); // zurück auf Schachbrett
        // [212] Normalen-/Rauigkeitskarten des Pathtracers (gleiche Ebenen; leere Puffer = keine).
        const none = new Uint8Array(0);
        cur.set_material_detail_textures?.(decoded?.normal ?? none, decoded?.rough ?? none, decoded?.count ?? 0);
      } catch (e) {
        console.warn("render3d set_material_textures fehlgeschlagen:", e);
      }
    })();

    // Luftbild aufs Gelände drapieren: ein ContextImage mit `drape:true` wird als
    // GPU-Textur hochgeladen (render3d legt es pixelscharf über das Terrain).
    // Wie die Materialien asynchron + signatur-gecacht (Bild ändert sich selten).
    if (typeof r.set_aerial_texture !== "function") return;
    void (async () => {
      try {
        const drape = project.context?.find(
          (o): o is ContextImage => o.type === "image" && o.drape === true,
        );
        const sig = drape
          ? `${drape.src.length}:${drape.src.slice(0, 64)}:${drape.min.x},${drape.min.y},${drape.max.x},${drape.max.y}`
          : "";
        if (sig === aerialSigRef.current) return; // unverändert
        aerialSigRef.current = sig;
        const cur = rendererRef.current;
        if (!cur || typeof cur.set_aerial_texture !== "function") return;
        if (!drape) {
          cur.clear_aerial?.();
          return;
        }
        const dec = await decodeImageToRgba(drape.src);
        const cur2 = rendererRef.current;
        if (!cur2 || typeof cur2.set_aerial_texture !== "function") return;
        if (dec) {
          cur2.set_aerial_texture(
            dec.data,
            dec.width,
            dec.height,
            drape.min.x,
            drape.min.y,
            drape.max.x,
            drape.max.y,
          );
        } else {
          cur2.clear_aerial?.();
        }
      } catch (e) {
        console.warn("render3d set_aerial_texture fehlgeschlagen:", e);
      }
    })();
  }, []);

  /**
   * Punktwolken abgleichen ([27]): neue/geänderte Daten hochladen, Darstellung umstellen,
   * entfernte löschen. Gibt `true` zurück, wenn sich etwas geändert hat (→ neu zeichnen).
   */
  const syncPointClouds = useCallback((items: readonly PointCloudSyncItem[]): boolean => {
    const r = rendererRef.current;
    if (!r || typeof r.set_point_cloud !== "function") return false;
    const uploaded = pointCloudsRef.current;
    const ops = planPointCloudSync(uploaded, items);
    const empty8 = new Uint8Array(0);
    const upload = (it: PointCloudSyncItem) => {
      const d = it.data;
      r.set_point_cloud!(
        it.id,
        d.xyz,
        d.rgb ?? empty8,
        d.intensity ?? new Uint16Array(0),
        d.classification ?? empty8,
        it.offset[0],
        it.offset[1],
        it.offset[2],
        it.colorMode,
        it.pointSize,
        it.visible,
      );
    };
    for (const op of ops) {
      try {
        if (op.kind === "remove") {
          r.remove_point_cloud?.(op.id);
          uploaded.delete(op.id);
          continue;
        }
        const it = op.item;
        if (op.kind === "style") {
          const ok = r.set_point_cloud_style?.(it.id, it.colorMode, it.pointSize, it.visible) === true;
          if (!ok) upload(it);
        } else {
          upload(it);
        }
        uploaded.set(it.id, {
          data: it.data,
          offset: [...it.offset],
          colorMode: it.colorMode,
          pointSize: it.pointSize,
          visible: it.visible,
        });
      } catch (e) {
        console.warn("render3d Punktwolke fehlgeschlagen:", e);
      }
    }
    return ops.length > 0;
  }, []);

  /**
   * Darstellungsart umschalten — reicht die volle `RenderMode`-Union der
   * Oberleiste ("shaded"/"white"/"textured"/"wireframe"/"hidden") an Rust
   * durch (`web::set_render_style`); die Engine entscheidet je Stil, wie
   * gezeichnet wird ("textured" faellt dort vorerst auf "shaded" zurueck).
   * Wirkt erst beim nächsten `render`.
   */
  const setRenderStyle = useCallback((style: string) => {
    const r = rendererRef.current;
    if (!r) return;
    styleRef.current = style;
    try {
      r.set_render_style(style);
    } catch (e) {
      console.warn("render3d set_render_style fehlgeschlagen:", e);
    }
  }, []);

  /** [212] Stand des Pathtracers: Samples je Pixel und ob das Bild fertig ist; null ohne Renderer/alter Build. */
  const pathtraceStatus = useCallback((): { samples: number; done: boolean; tooBig: boolean } | null => {
    const r = rendererRef.current;
    if (!r?.pathtrace_samples) return null;
    try {
      return { samples: r.pathtrace_samples(), done: r.pathtrace_done?.() ?? false, tooBig: r.pathtrace_too_big?.() ?? false };
    } catch {
      return null;
    }
  }, []);

  /** [212] Etappe 5: Belichtung (EV, Automatik) und Raumlicht des Pathtracers; wirkt beim nächsten `render`. */
  const setPathtraceLook = useCallback((ev: number, autoExposure: boolean, roomLight: boolean) => {
    const r = rendererRef.current;
    if (!r) return;
    try {
      r.set_pathtrace_exposure?.(ev, autoExposure);
      r.set_pathtrace_room_light?.(roomLight);
    } catch (e) {
      console.warn("render3d Pathtracing-Einstellung fehlgeschlagen:", e);
    }
  }, []);

  /** Sonne + Schatten im 3D setzen ([64], s. `sun3d.ts`). Wirkt erst beim nächsten `render`. */
  const setSun = useCallback((active: boolean, azimuthDeg: number, elevationDeg: number) => {
    const r = rendererRef.current;
    if (!r?.set_sun) return;
    try {
      r.set_sun(active, azimuthDeg, elevationDeg, active);
    } catch (e) {
      console.warn("render3d set_sun fehlgeschlagen:", e);
    }
  }, []);

  /**
   * Boden-Referenzraster ein-/ausblenden (Overlay-Umschalter im Viewport,
   * s. Wasm3DViewport.tsx). `elevationM` = OKFF des aktiven Geschosses
   * (`baseElevation`), `extentM`/`spacingM` = Kantenlaenge/Linienabstand des
   * Quadrats in Metern. Wirkt erst beim naechsten `render`.
   */
  const setGroundGrid = useCallback(
    (visible: boolean, elevationM: number, extentM: number, spacingM: number) => {
      const r = rendererRef.current;
      if (!r) return;
      try {
        r.set_ground_grid(visible, elevationM, extentM, spacingM);
      } catch (e) {
        console.warn("render3d set_ground_grid fehlgeschlagen:", e);
      }
    },
    [],
  );

  /**
   * Live-Schnitt setzen/aufheben (Overlay-Umschalter im Viewport, s.
   * Wasm3DViewport.tsx). `active=false` zeigt das Modell wieder komplett.
   * `point` = Punkt auf der Schnittebene, `normal` = Ebenennormale =
   * Blickrichtung (world-Meter, Y-up; nur vertikale Ebenen sinnvoll). Wirkt
   * erst beim nächsten `render`.
   */
  const setSectionPlane = useCallback(
    (
      active: boolean,
      point: [number, number, number],
      normal: [number, number, number],
    ) => {
      const r = rendererRef.current;
      if (!r) return;
      try {
        r.set_section_plane(
          active,
          point[0],
          point[1],
          point[2],
          normal[0],
          normal[1],
          normal[2],
        );
      } catch (e) {
        console.warn("render3d set_section_plane fehlgeschlagen:", e);
      }
    },
    [],
  );

  /**
   * Auswahl-Hervorhebung setzen (Umriss-Linien des gewählten Bauteils, immer
   * obenauf) — reicht das fertige LineList-Vertex-Array 1:1 an
   * `set_highlight_lines` durch (s. WebModelRendererLike). Der Aufrufer
   * (Wasm3DViewport) übergibt ein leeres Float32Array, um das Highlight zu
   * löschen (leere Auswahl). Wirkt erst beim nächsten `render`.
   */
  const setHighlightLines = useCallback((vertices: Float32Array) => {
    const r = rendererRef.current;
    if (!r) return;
    try {
      r.set_highlight_lines(vertices);
    } catch (e) {
      console.warn("render3d set_highlight_lines fehlgeschlagen:", e);
    }
  }, []);

  /**
   * Kamera-Praeset anwenden (`front`/`top`/`side`/`iso`/`perspective`, wie
   * `View3d` in TopBar.tsx). Delegiert die formatfuellende Ziel-/Distanz-
   * Berechnung + Projektionsart (ortho fuer front/top/side) an Rust
   * (`web::set_view_preset` -> `math::preset_camera`) — dieselbe Logik wie das
   * native Fenster, statt einer zweiten Praeset-Tabelle in TS. Wirkt erst beim
   * naechsten `render`.
   */
  const applyViewPreset = useCallback((preset: string) => {
    const r = rendererRef.current;
    if (!r) return;
    try {
      r.set_view_preset(preset);
    } catch (e) {
      console.warn("render3d set_view_preset fehlgeschlagen:", e);
    }
  }, []);

  /** Formatfüllendes Ziel + Abstand (Modell + sichtbare Punktwolken) aus Rust, oder null (alter Build). */
  const viewFit = useCallback((): { target: [number, number, number]; dist: number } | null => {
    const r = rendererRef.current;
    if (!r || typeof r.view_fit !== "function") return null;
    try {
      const v = Array.from(r.view_fit());
      if (v.length < 4 || !v.every(Number.isFinite)) return null;
      return { target: [v[0], v[1], v[2]], dist: v[3] };
    } catch {
      return null;
    }
  }, []);

  /** Die Kamera, die Rust gerade zeichnet (Preset oder zuletzt gesetzt), oder null (alter Build). */
  const readRustCamera = useCallback((): Camera3d | null => {
    const r = rendererRef.current;
    if (!r || typeof r.camera_state !== "function") return null;
    try {
      const v = Array.from(r.camera_state());
      if (v.length < 12 || !v.every(Number.isFinite)) return null;
      return {
        eye: [v[0], v[1], v[2]],
        target: [v[3], v[4], v[5]],
        up: [v[6], v[7], v[8]],
        perspective: v[9] > 0.5,
        fovY: v[10],
        orthoHalfHeight: v[11],
      };
    } catch {
      return null;
    }
  }, []);

  /**
   * Schnappschuss des 3D-Bildes als PNG. `draw` zeichnet den Frame (muss synchron rendern): ein
   * WebGPU-Canvas liefert seinen Inhalt nur im selben Task wie das Zeichnen, danach ist er leer.
   * Das Bild wird sofort auf ein 2D-Canvas kopiert (höchstens `maxEdge` px lange Seite), dann
   * kodiert. Null bei leerem/nicht lesbarem Bild (z. B. Software-WebGPU ohne Präsentation).
   */
  const snapshotPng = useCallback(
    async (draw: () => void, maxEdge: number): Promise<Uint8Array | null> => {
      const canvas = canvasRef.current;
      if (!canvas || !rendererRef.current || canvas.width < 1 || canvas.height < 1) return null;
      draw();
      const k = Math.min(1, Math.max(16, maxEdge) / Math.max(canvas.width, canvas.height));
      const w = Math.max(1, Math.round(canvas.width * k));
      const h = Math.max(1, Math.round(canvas.height * k));
      const out = document.createElement("canvas");
      out.width = w;
      out.height = h;
      const ctx = out.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0, w, h);
      // Leer = alles transparent oder schwarz (Stichprobe über ein Raster).
      const sample = ctx.getImageData(0, 0, w, h).data;
      let seen = false;
      const step = Math.max(1, Math.floor(sample.length / 4 / 400)) * 4;
      for (let i = 0; i < sample.length && !seen; i += step) seen = sample[i + 3] > 0 && (sample[i] | sample[i + 1] | sample[i + 2]) !== 0;
      if (!seen) return null;
      const blob: Blob | null = await new Promise((res) => out.toBlob(res, "image/png"));
      return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    },
    [canvasRef],
  );

  /**
   * [223] Bild für die Abgabe: render3d zeichnet mit `cam` direkt in der Zielgrösse `width` × `height` (nicht das Fenster
   * skaliert), mit der aktuellen Darstellung (Schatten, Kanten, Texturen, Pausen/Graustufen). `transparent`: Hintergrund
   * durchsichtig (zwei Durchgänge auf Schwarz und Weiss, `matteFromBlackWhite`); ohne `set_clear_color` im Build bleibt der
   * Hintergrund deckend (`transparent: false` im Ergebnis). Alles Zeichnen und Auslesen läuft synchron im selben Task (ein
   * WebGPU-Canvas liefert seinen Inhalt nur dort); danach stellt `restore` das Fenster-Bild wieder her. Null bei leerem Bild.
   * [212] Etappe 3: im Stil Pathtracing rechnet er die Samples vorher in Häppchen (`renderPathtraceChunks`: Fortschritt
   * `onProgress`, Abbruch über `signal` → null); nur das letzte Häppchen läuft im selben Task wie das Auslesen.
   */
  const exportImage = useCallback(
    async (opts: { camera: Camera3d; width: number; height: number; transparent: boolean; samples?: number; restore: () => void } & ExportProgress): Promise<{ png: Uint8Array; width: number; height: number; transparent: boolean } | null> => {
      const canvas = canvasRef.current;
      const r = rendererRef.current;
      if (!canvas || !r) return null;
      const { width: W, height: H } = clampImageSize(opts.width, opts.height);
      // [212] Pathtracing: N Samples in einem `render` (statt 1), feiner gerechnet; Hintergrund ist der Himmel (keine Transparenz).
      const pt = styleRef.current === "pathtrace" && typeof r.set_pathtrace_batch === "function";
      const canMatte = !pt && opts.transparent && typeof r.set_clear_color === "function";
      const prevW = canvas.width;
      const prevH = canvas.height;
      const out = document.createElement("canvas");
      out.width = W;
      out.height = H;
      const ctx = out.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      let image: ImageData | null = null;
      try {
        canvas.width = W;
        canvas.height = H;
        r.resize(W, H);
        const c = opts.camera;
        const setCam = () => r.set_camera(c.eye[0], c.eye[1], c.eye[2], c.target[0], c.target[1], c.target[2], c.up[0], c.up[1], c.up[2], c.perspective, c.fovY, c.orthoHalfHeight);
        if (pt) {
          const total = exportSamples(opts.samples);
          r.set_pathtrace_max_pixels?.(PT_EXPORT_MAX_PIXELS);
          r.set_pathtrace_batch?.(total);
          const gpuIdle = r.gpu_idle;
          if (typeof gpuIdle === "function" && typeof r.pathtrace_samples === "function" && total > 1) {
            exportingRef.current = true;
            setCam();
            const samples = r.pathtrace_samples.bind(r);
            const left = await renderPathtraceChunks(
              { render: () => r.render(), pathtrace_samples: samples, set_pathtrace_batch: (n) => r.set_pathtrace_batch?.(n), gpu_idle: () => gpuIdle.call(r) },
              total,
              opts,
            );
            if (left === null) return null;
            r.set_pathtrace_batch?.(left);
            opts.onProgress?.(total, total);
          }
        }
        const shot = (bg: number | null): ImageData => {
          if (bg !== null) r.set_clear_color?.(bg, bg, bg);
          setCam();
          r.render();
          ctx.clearRect(0, 0, W, H);
          ctx.drawImage(canvas, 0, 0);
          return ctx.getImageData(0, 0, W, H);
        };
        if (canMatte) {
          const black = shot(0);
          const white = shot(1);
          matteFromBlackWhite(black.data, white.data);
          image = black;
        } else {
          image = shot(null);
        }
      } catch (e) {
        console.warn("render3d Bild-Export fehlgeschlagen:", e);
        image = null;
      } finally {
        exportingRef.current = false;
        try {
          if (pt) {
            r.set_pathtrace_batch?.(1);
            r.set_pathtrace_max_pixels?.(0);
          }
          r.set_clear_color?.(0.961, 0.961, 0.961);
          canvas.width = prevW;
          canvas.height = prevH;
          r.resize(prevW, prevH);
        } catch {
          /* Renderer weg: nichts zurückzustellen */
        }
        opts.restore();
      }
      if (!image || isBlankImage(image.data)) return null;
      ctx.putImageData(image, 0, 0);
      const blob: Blob | null = await new Promise((res) => out.toBlob(res, "image/png"));
      return blob ? { png: new Uint8Array(await blob.arrayBuffer()), width: W, height: H, transparent: canMatte } : null;
    },
    [canvasRef],
  );

  /**
   * Einen Frame zeichnen (Canvas-Größe + DPR abgleichen). `cam` = null lässt
   * die zuletzt in Rust gesetzte Kamera unverändert — Fall für `render(null)`
   * direkt nach `applyViewPreset` (die Kamera kommt dann aus `preset_camera`,
   * ein `set_camera` hier würde das freie Orbit-Ergebnis darüberschreiben und
   * die orthografische Projektion der Presets zunichtemachen).
   */
  const render = useCallback(
    (cam: Camera3d | null) => {
      const r = rendererRef.current;
      const canvas = canvasRef.current;
      if (!r || !canvas || exportingRef.current) return;
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      try {
        r.resize(w, h);
        if (cam) {
          r.set_camera(
            cam.eye[0],
            cam.eye[1],
            cam.eye[2],
            cam.target[0],
            cam.target[1],
            cam.target[2],
            cam.up[0],
            cam.up[1],
            cam.up[2],
            cam.perspective,
            cam.fovY,
            cam.orthoHalfHeight,
          );
        }
        r.render();
      } catch (e) {
        console.warn("render3d render fehlgeschlagen:", e);
      }
    },
    [canvasRef],
  );

  return {
    render,
    updateModel,
    setRenderStyle,
    pathtraceStatus,
    setPathtraceLook,
    setSun,
    applyViewPreset,
    viewFit,
    readRustCamera,
    snapshotPng,
    exportImage,
    setGroundGrid,
    setSectionPlane,
    setHighlightLines,
    syncPointClouds,
    ready,
    failed,
  };
}

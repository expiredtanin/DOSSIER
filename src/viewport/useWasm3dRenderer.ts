/**
 * React-Hook für den nativen render3d-Renderer als WASM/WebGPU-Viewport.
 *
 * Gegenstück zu {@link useWasmPlanRenderer} (2D): lädt das WASM-Modul aus
 * src/engine/pkg3d (`npm run build:engine3d`), bindet den Renderer an ein
 * Canvas und reicht Modell + Kamera durch. Die eigentliche Zeichenlogik lebt
 * in Rust (src-tauri/render3d, Feature `web`) — dieselbe Extrusion/Pipeline
 * wie das native wgpu-Fenster.
 *
 * Modell-Sync: `updateModel(project)` flacht das Projekt über
 * {@link projectToModel3d} (Wände mit Öffnungs-Teilquadern + Deckenplatten)
 * und schiebt es als JSON an `set_model` — exakt dasselbe Format wie der
 * native Tauri-Push (nativeSync.ts).
 *
 * Fällt bei fehlendem WebGPU oder Init-Fehler auf `ready:false` + `failed:true`
 * zurück; der Aufrufer (Wasm3DViewport) zeigt dann den Hinweis-Fallback.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { ContextImage, Project } from "../model/types";
import { emitDrawingLineVerts, projectToModel3d } from "../core";
import type { DetailLevel } from "../model/viewTypes";
import { loadEngine3d } from "../engine/engine3d";
import { decodeMaterialTextures } from "./materialTextures";
import { decodeImageToRgba } from "../io/swissImage";
import { planPointCloudSync } from "./pointCloudSync";
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
  /** Darstellungsart setzen — `style` ∈ "shaded"|"white"|"wireframe"|"hidden"|
   * "textured" (deckt die volle `RenderMode`-Union der Oberleiste ab;
   * "textured" faellt engine-seitig vorerst auf "shaded" zurueck). */
  set_render_style(style: string): void;
  set_view_preset(preset: string): void;
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
  /** Material-Farbkarten (Stil „textured") als Textur-Array hochladen
   * (`web::set_material_textures`). `rgba` = gepackte RGBA8-Bytes von
   * `layerCount` 256×256-Ebenen; Ebene 0 bleibt intern das Fallback-Schachbrett,
   * die Karten belegen Ebenen 1..N (siehe `WallInput.materialIndex`). Optional —
   * ältere WASM-Builds ohne diesen Export lassen den Aufrufer still zurückfallen. */
  set_material_textures?(rgba: Uint8Array, layerCount: number): void;
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

export function useWasm3dRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  enabled: boolean,
) {
  const rendererRef = useRef<WebModelRendererLike | null>(null);
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
  // Signatur des zuletzt hochgeladenen Drape-Luftbilds (src + Bbox) — verhindert
  // ein erneutes (teures) Dekodieren/Hochladen bei unveränderter Lage.
  const aerialSigRef = useRef<string | null>(null);

  /** Modell bei Projektänderung neu setzen (re-extrudiert in Rust). `detail`
   *  steuert den Öffnungs-Detailgrad (grob/mittel/fein) im 3D wie im Grundriss. */
  const updateModel = useCallback((project: Project, detail?: DetailLevel) => {
    const r = rendererRef.current;
    if (!r || !project) return;
    try {
      r.set_model(JSON.stringify(projectToModel3d(project, { detail, voids: true })));
    } catch (e) {
      console.warn("render3d set_model fehlgeschlagen:", e);
    }
    // 2D-Boden-Spuren als eigener BINÄRER LineList-Kanal — bewusst NICHT Teil
    // des JSON-Modells oben: ein Kataster-DXF (Mio. Segmente) sprengt als
    // Ribbon-Meshes im JSON die String-Längengrenze komplett (Nutzer-Report
    // 2026-10-08, s. `emitDrawingLineVerts`). Eigener try/catch, damit ein
    // Fehler hier das bereits gesetzte Modell nicht mit wegreisst.
    if (typeof r.set_drawing_lines === "function") {
      try {
        r.set_drawing_lines(emitDrawingLineVerts(project));
      } catch (e) {
        console.warn("render3d set_drawing_lines fehlgeschlagen:", e);
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
    try {
      r.set_render_style(style);
    } catch (e) {
      console.warn("render3d set_render_style fehlgeschlagen:", e);
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
      if (!r || !canvas) return;
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
    applyViewPreset,
    setGroundGrid,
    setSectionPlane,
    setHighlightLines,
    syncPointClouds,
    ready,
    failed,
  };
}

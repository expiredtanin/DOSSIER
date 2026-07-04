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

import { useEffect, useRef } from "react";
import type { Project } from "../model/types";
import { projectToModel3d } from "../plan/toWalls3d";
import type { RenderMode, View3d } from "../ui/TopBar";
import { t } from "../i18n";
import { useWasm3dRenderer } from "./useWasm3dRenderer";
import type { Camera3d } from "./useWasm3dRenderer";

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
    perspective: true,
    fovY: FOV_Y,
    orthoHalfHeight: o.dist * 0.5,
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
  side: { yaw: 0, pitch: 0 },
  top: { yaw: Math.PI / 2, pitch: PITCH_LIMIT },
  iso: { yaw: Math.PI / 4, pitch: ISO_PITCH },
  perspective: { yaw: Math.PI / 4, pitch: 0.5 },
};

export function Wasm3DViewport({
  project,
  view3d = "perspective",
  renderMode = "shaded",
  gridVisible = true,
  groundElevation = 0,
  onToggleGrid,
}: {
  project: Project;
  /** Kanonischer Blickwinkel (Oberleiste) — s. Datei-Kommentar. */
  view3d?: View3d;
  /** Darstellungsart (Oberleiste) — alle fünf Werte wirken hier, s.
   * Datei-Kommentar. */
  renderMode?: RenderMode;
  /** Boden-Referenzraster sichtbar? Umgeschaltet über den Overlay-Button unten
   * rechts im Viewport (`onToggleGrid`) — Single Source of Truth ist der
   * Aufrufer (App/viewSlice `grid3dVisible`), diese Komponente spiegelt nur. */
  gridVisible?: boolean;
  /** Hoehe (world-Y, Meter) des Bodenrasters = OKFF/`baseElevation` des
   * aktiven Geschosses (vom Aufrufer berechnet, s. App.tsx). */
  groundElevation?: number;
  /** Klick auf den Grid-Umschalter-Button; ohne Angabe kein Button. */
  onToggleGrid?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const {
    render,
    updateModel,
    setRenderStyle,
    applyViewPreset,
    setGroundGrid,
    ready,
    failed,
  } = useWasm3dRenderer(canvasRef, true);
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
    updateModel(project);
    redrawRef.current();
  }, [ready, project, updateModel]);

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
    orbitRef.current = { yaw, pitch, dist, target };
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

  // Canvas-Größe beobachten: bei Layout-Änderung mit aktueller Kamera neu
  // zeichnen (die Surface-Anpassung übernimmt der Hook im render()).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!ready || !canvas) return;
    const ro = new ResizeObserver(() => redrawRef.current());
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [ready]);

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

    let drag: { mode: "orbit" | "pan"; x: number; y: number } | null = null;

    const redraw = () => redrawRef.current();

    const onPointerDown = (e: PointerEvent) => {
      // LINKS (0) = Orbit, MITTE (1)/RECHTS (2) = Pan (s. MAUS-SCHEMA oben).
      const mode = e.button === 0 ? "orbit" : e.button === 1 || e.button === 2 ? "pan" : null;
      if (!mode) return;
      e.preventDefault();
      drag = { mode, x: e.clientX, y: e.clientY };
      canvas.setPointerCapture(e.pointerId);
      useOrbitRedraw();
    };

    const onPointerMove = (e: PointerEvent) => {
      const o = orbitRef.current;
      if (!drag || !o) return;
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
        // Pan in der Bildebene: Welt-Meter je Pixel aus Distanz + Sichtwinkel;
        // Ziel entgegen der Mausrichtung verschieben (Szene folgt dem Cursor).
        const worldPerPx = (2 * o.dist * Math.tan(FOV_Y / 2)) / h;
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

    const endDrag = (e: PointerEvent) => {
      if (!drag) return;
      drag = null;
      if (canvas.hasPointerCapture(e.pointerId)) {
        canvas.releasePointerCapture(e.pointerId);
      }
    };

    const onWheel = (e: WheelEvent) => {
      const o = orbitRef.current;
      if (!o) return;
      e.preventDefault();
      useOrbitRedraw();
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
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("contextmenu", onContextMenu);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
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

// Rad-Zoom, Doppelklick und Kontextmenü der Plan-Ansicht ([165] aus `PlanView.tsx`). Im GPU-Pfad zoomt
// das Rad imperativ und schreibt den Ausschnitt nach kurzer Ruhe fest. Aufgerufen einmal von `PlanView`.

import { openCamera } from "../../../state/cameraActions";
import type { ViewBox__plan_planView_geometry as ViewBox } from "../../../core";
import type { Vec2 } from "../../../model/types";
import { clamp } from "../../../core";
import { WHEEL_MAX_DELTA, WHEEL_STEP, ZOOM_MAX, ZOOM_MIN } from "./constants";
import { useRef, useEffect } from "react";
import type { ToolHandlers } from "../../../tools/types";
import type { GroupableHit } from "./types";

/** Werte aus `PlanView`, die dieser Hook liest (unverändert, ohne Kopie). */
export interface UsePlanZoomInputArgs {
  clientToView: (clientX: number, clientY: number, vb: ViewBox) => Vec2;
  defaultView: ViewBox;
  svgRef: React.MutableRefObject<SVGSVGElement | null>;
  useGpuRenderer: boolean;
  panPending: React.MutableRefObject<ViewBox | null>;
  viewRef: React.MutableRefObject<ViewBox>;
  canvasRef: React.MutableRefObject<HTMLCanvasElement | null>;
  enqueuePan: (v: ViewBox) => void;
  commitPan: () => void;
  setView: React.Dispatch<React.SetStateAction<ViewBox>>;
  toolActive: boolean;
  toolHandlers: ToolHandlers | undefined;
  onEnterGroup: ((hit: GroupableHit) => boolean) | undefined;
  anyGroupableHit: (clientX: number, clientY: number) => GroupableHit | null;
  onEditDrawingText: ((drawingId: string) => void) | undefined;
  pickDrawingText: (clientX: number, clientY: number) => string | null;
  onStampEdit: ((roomId: string) => void) | undefined;
  stampHandleAt: (clientX: number, clientY: number) => string | null;
  pickRoom: (clientX: number, clientY: number) => string | null;
  onOpenSectionLevel: ((levelId: string) => void) | undefined;
  pickSectionLine: (clientX: number, clientY: number) => string | null;
  pickCamera: (clientX: number, clientY: number) => string | null;
  onContextMenu: ((info: { clientX: number; clientY: number; model: Vec2; }) => void) | undefined;
  view: ViewBox;
  viewToModel: (vbX: number, vbY: number) => Vec2;
}

export function usePlanZoomInput(inp: UsePlanZoomInputArgs) {
  const {
    clientToView,
    defaultView,
    svgRef,
    useGpuRenderer,
    panPending,
    viewRef,
    canvasRef,
    enqueuePan,
    commitPan,
    setView,
    toolActive,
    toolHandlers,
    onEnterGroup,
    anyGroupableHit,
    onEditDrawingText,
    pickDrawingText,
    onStampEdit,
    stampHandleAt,
    pickRoom,
    onOpenSectionLevel,
    pickSectionLine,
    pickCamera,
    onContextMenu,
    view,
    viewToModel,
  } = inp;

  /**
   * Rechnet aus einem Ausschnitt + Rad-Delta den neuen (geklemmten) Ausschnitt.
   * `anchorOverride`: Ankerpunkt in viewBox-Koordinaten (sonst aus clientX/Y über
   * die gemessene SVG-Box — die während eines imperativen Zooms transformiert ist).
   */
  const zoomedView = (prev: ViewBox, clientX: number, clientY: number, deltaY: number, anchorOverride?: Vec2): ViewBox => {
    // Punkt unter dem Cursor (bleibt nach dem Zoom ortsfest).
    const anchor = anchorOverride ?? clientToView(clientX, clientY, prev);
    // Hochrollen (deltaY < 0) → hinein → kleinere viewBox.
    let factor = Math.exp(clamp(deltaY, -WHEEL_MAX_DELTA, WHEEL_MAX_DELTA) * WHEEL_STEP);
    // Zoom relativ zur Default-Breite begrenzen.
    const minW = defaultView.w / ZOOM_MAX;
    const maxW = defaultView.w / ZOOM_MIN;
    const targetW = clamp(prev.w * factor, minW, maxW);
    // Tatsächlich angewandter Faktor nach Klemmung (hält Seitenverhältnis).
    factor = targetW / prev.w;
    return {
      x: anchor.x - (anchor.x - prev.x) * factor,
      y: anchor.y - (anchor.y - prev.y) * factor,
      w: prev.w * factor,
      h: prev.h * factor,
    };
  };

  // Zoom-Geste im GPU-Pfad: wie der Pan imperativ (kein React-Render pro Rad-
  // Schritt). Der Ausschnitt wird erst nach einer kurzen Ruhepause festgeschrieben.
  const wheelCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const WHEEL_COMMIT_MS = 70;

  // Seiten-Scroll/-Zoom des Browsers beim Rad über dem Plan unterdrücken: React hängt `onWheel`
  // passiv an (dort `preventDefault` wirkungslos, Chromium meldet einen Konsolenfehler) — daher
  // ein eigener, nicht-passiver Listener am SVG.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const stop = (e: WheelEvent) => e.preventDefault();
    el.addEventListener("wheel", stop, { passive: false });
    return () => el.removeEventListener("wheel", stop);
  }, []);
  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    if (useGpuRenderer) {
      // Aktueller (logischer) Ausschnitt: ein laufender imperativer Zoom/Pan gewinnt.
      const base = panPending.current ?? viewRef.current;
      // Während der Geste trägt das SVG einen CSS-Transform → seine Box ist
      // verzerrt; die (untransformierte) GPU-Fläche liefert die echte Elementbox.
      const rect = (canvasRef.current ?? svgRef.current)?.getBoundingClientRect();
      let anchor: Vec2 | undefined;
      if (rect && rect.width > 0 && rect.height > 0) {
        const scale = Math.min(rect.width / base.w, rect.height / base.h);
        const offX = (rect.width - base.w * scale) / 2;
        const offY = (rect.height - base.h * scale) / 2;
        anchor = {
          x: base.x + (e.clientX - rect.left - offX) / scale,
          y: base.y + (e.clientY - rect.top - offY) / scale,
        };
      }
      enqueuePan(zoomedView(base, e.clientX, e.clientY, e.deltaY, anchor));
      if (wheelCommitTimer.current !== null) clearTimeout(wheelCommitTimer.current);
      wheelCommitTimer.current = setTimeout(() => {
        wheelCommitTimer.current = null;
        commitPan();
      }, WHEEL_COMMIT_MS);
      return;
    }
    setView((prev) => zoomedView(prev, e.clientX, e.clientY, e.deltaY));
  };

  // Doppelklick → bei aktivem Werkzeug den mehrteiligen Entwurf abschließen,
  // sonst wieder auf die eingepasste Standard-Ansicht.
  const onDoubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (toolActive) {
      toolHandlers!.onToolCommit();
      return;
    }
    // Gruppen betreten hat VORRANG vor allen anderen Doppelklick-Aktionen
    // (Vectorworks: ein gruppiertes Element öffnet zuerst die Gruppe — erst
    // ein weiterer Doppelklick INNERHALB träfe dann z. B. den Text-Editor).
    if (onEnterGroup) {
      const hit = anyGroupableHit(e.clientX, e.clientY);
      if (hit && onEnterGroup(hit)) return;
    }
    // Doppelklick auf ein Text-2D-Element → Inhalt bearbeiten (Vorrang vor Raum).
    if (onEditDrawingText) {
      const tid = pickDrawingText(e.clientX, e.clientY);
      if (tid) {
        onEditDrawingText(tid);
        return;
      }
    }
    // Doppelklick auf einen Raum (Stempel-Griff ODER Fläche) → Stempel-Editor.
    if (onStampEdit) {
      const rid =
        stampHandleAt(e.clientX, e.clientY) ?? pickRoom(e.clientX, e.clientY);
      if (rid) {
        onStampEdit(rid);
        return;
      }
    }
    // [213] Doppelklick auf das Symbol einer Kamera → die Kamera im 3D öffnen (Reiter wechseln, Ansicht exakt setzen).
    const cid = pickCamera(e.clientX, e.clientY);
    if (cid) {
      void openCamera(cid);
      return;
    }
    // Doppelklick auf eine Schnittlinie → in deren 2D-Schnittansicht springen.
    if (onOpenSectionLevel) {
      const sid = pickSectionLine(e.clientX, e.clientY);
      if (sid) {
        onOpenSectionLevel(sid);
        return;
      }
    }
    setView(defaultView);
  };

  // Rechtsklick: Browser-Menü unterdrücken. Bei aktivem Werkzeug mit laufendem
  // Entwurf = abschließen (CAD-üblich, KEIN Kontextmenü); sonst Kontextmenü.
  const onContextMenuHandler = (e: React.MouseEvent<SVGSVGElement>) => {
    e.preventDefault();
    // Bei aktivem Werkzeug/Befehl ist Rechtsklick = Enter (abschließen/wiederholen,
    // §2.3) — KEIN Kontextmenü, auch ohne laufenden Entwurf.
    if (toolActive) {
      toolHandlers!.onToolCommit();
      return;
    }
    if (!onContextMenu) return;
    const v = clientToView(e.clientX, e.clientY, view);
    onContextMenu({
      clientX: e.clientX,
      clientY: e.clientY,
      model: viewToModel(v.x, v.y),
    });
  };

  return {
    onWheel,
    onDoubleClick,
    onContextMenuHandler,
  };
}

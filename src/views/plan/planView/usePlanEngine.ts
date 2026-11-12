// Renderer-Anbindung der Plan-Ansicht ([165] aus `PlanView.tsx`): Pick-Index im Kern, Wahl der Engine
// (native Metal-Fläche, render2d als WASM/WebGPU oder SVG-Rückfall), aufbereiteter Plan, Unterlage,
// SVG-Kandidaten samt Culling, Papier-Massstab, Overlay-Ursprung und die GL-Effekte. Aufgerufen einmal von
// `PlanView`; die Reihenfolge der Hooks und Effekte ist wie vor der Aufteilung.

import { useRef, useEffect, useMemo, useState, useLayoutEffect } from "react";
import { PlanPickIndex, planTextEntries, materializeGreyed, materializeUnderlay, roomStampAt, buildDrawingIndex, isGpuText, isSceneText, meetScale, PLAN_DASH_VAR, toScreen, scaleFromView, PX_PER_M } from "../../../core";
import { useNativeAvailable, useNativePlanRenderer } from "../useNativePlanRenderer";
import { useWasmPlanRenderer } from "../useWasmPlanRenderer";
import type { UnderlayGroup, DrawingIndex, Primitive, ViewBox__plan_planView_geometry as ViewBox } from "../../../core";
import type { Drawing2D, Vec2 } from "../../../model/types";
import { CULL_THRESHOLD, computeCullState, cullStateStale } from "./constants";
import type { CullState } from "./constants";
import { pickOverlayOrigin, makeToLocal } from "./overlayOrigin";
import { createMeetStore, createValueStore } from "./liveMeet";
import { endBusyAfterPaint } from "../../../state/busyStore";
import type { Plan } from "../../../core";
import type { ReactNode } from "react";

/** Werte aus `PlanView`, die dieser Hook liest (unverändert, ohne Kopie). */
export interface UsePlanEngineArgs {
  editTextId: string | null | undefined;
  planRaw: Plan;
  backdrop: ((origin: Vec2, pxPerMeter: number) => ReactNode) | undefined;
  roomStamp: { roomId: string; anchor: Vec2; } | null | undefined;
  defaultView: ViewBox;
  /** [204] Startansicht (aufs Gebäude eingepasst); Referenz des Papier-Massstabs beim Öffnen/Wechsel. */
  startViewRef?: React.MutableRefObject<ViewBox>;
  view: ViewBox;
  hairline: boolean | undefined;
  onScale: ((n: number) => void) | undefined;
  resetKey: string | undefined;
}

export function usePlanEngine(inp: UsePlanEngineArgs) {
  const {
    editTextId,
    planRaw,
    backdrop,
    roomStamp,
    defaultView,
    startViewRef,
    view,
    hairline,
    onScale,
    resetKey,
  } = inp;

  // Viewport-/LOD-Culling für `primitiveEls` (s. cullPrimitives.ts) — NUR
  // aktiv bei sehr vielen Primitiven (Kataster-DXF-Import, Nutzer-Report
  // 2026-10-09: 59'391 Einzel-Textbeschriftungen liessen die App nach dem
  // Import hängen, weil React/SVG ALLE auf einmal als DOM-Knoten erzeugte,
  // egal ob sichtbar oder lesbar) — bei normalen Projekten bleibt das
  // Verhalten exakt wie zuvor (kein Overhead, `cullState` bleibt `null`).
  //
  // ZWEI Kriterien, nicht nur Position: direkt nach einem Import zeigt die
  // "eingepasste" Übersicht den GESAMTEN Umriss (bei Luzern: 2158×2583 m) —
  // technisch liegen dann ALLE 59'391 Labels "im Bild", wären aber jedes nur
  // ein paar Pixel gross und unleserlich. `minTextHeightVb` filtert zusätzlich
  // nach Lesbarkeit bei der aktuellen Zoomstufe (unabhängig von der Position) —
  // erst damit bleibt auch der ALLERERSTE Blick nach dem Import schnell.
  //
  // Puffer+Hysterese (CULL_MARGIN_FACTOR, `cullStateStale`), damit kleine
  // Schwenks/Zoom-Schritte KEINE Neuberechnung auslösen — dieselbe Überlegung
  // wie beim bestehenden `primitiveEls`-Memo weiter unten, das bewusst NICHT
  // an `view` hängt (sonst Ruckler auf WebKitGTK bei jedem Pan/Zoom, s.
  // Kommentar dort): nur bei einem GRÖSSEREN Schwenk ODER spürbarem Hinein-
  // zoomen (view schrumpft stark — reines "liegt noch drin" reicht hier
  // NICHT, ein View, der nur kleiner wird, bleibt sonst fälschlich innerhalb
  // der alten, zu grosszügigen Region) wird neu gerechnet.
  // Auswahl-Index im Kern (s. planView/planPick.ts): 2D-Zeichenlinien, Polygone, Symbol-Linien,
  // Kreise/Bögen und Besitzer über `plan.primitives` (dieselben Indizes). LAZY: der Kern baut ihn
  // erst bei der ersten Abfrage je Plan; der vorige wird dann freigegeben.
  const pickIndexRef = useRef<PlanPickIndex | null>(null);
  const getPick = (): PlanPickIndex => {
    const cached = pickIndexRef.current;
    if (cached && cached.plan === plan) return cached;
    cached?.release();
    const ix = new PlanPickIndex(plan);
    pickIndexRef.current = ix;
    return ix;
  };
  useEffect(() => () => pickIndexRef.current?.release(), []);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Engine-Auswahl. Zwei GPU-Pfade, kein WebGL2 mehr:
  //  • NATIVE Metal-Fläche hinter der Webview (macOS-Tauri mit Feature native2d, s.
  //    useNativePlanRenderer.ts): STANDARD, wo verfügbar; `?native=0` schaltet sie ab.
  //  • render2d als WASM/WebGPU (useWasmPlanRenderer): überall sonst (Linux/Electron).
  // Der SVG-Renderer bleibt die Interaktions-Ebene (Text/Griffe/Auswahl) und der Rückfall,
  // wenn kein GPU-Pfad läuft (`?gl=0` erzwingt ihn). Solange die Verfügbarkeit des nativen
  // Pfads noch erfragt wird (null), startet KEINE Engine.
  const hasWebGpu = typeof navigator !== "undefined" && "gpu" in navigator;
  const nativeAvail = useNativeAvailable();
  const glParam = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("gl");
  const nativeOptOut = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("native") === "0";
  const wantNative = nativeAvail === true && !nativeOptOut && glParam !== "0";
  const wantWasm = !wantNative && nativeAvail !== null && hasWebGpu && glParam !== "0";
  // Alle Hooks unbedingt aufrufen (Hook-Regeln); je nach Flag ist genau einer aktiv.
  const wasmHook = useWasmPlanRenderer(canvasRef, wantWasm);
  const nativeHook = useNativePlanRenderer(canvasRef, wantNative);
  const activeEngine = wantWasm ? wasmHook : nativeHook;
  // Text im Inline-Editor nicht zusätzlich nativ zeichnen.
  const setNativeExcludedText = nativeHook.setExcludedText;
  useEffect(() => {
    setNativeExcludedText(editTextId ?? null);
  }, [editTextId, setNativeExcludedText]);
  const { render: renderGl, updateGeometry, ready: glReady } = activeEngine;
  // „GPU-Canvas montieren?" — beide GPU-Pfade brauchen das Canvas (an der ABSICHT
  // montiert, nicht am ready, sonst könnte die Engine mangels Canvas nie starten).
  const wantGpu = wantWasm || wantNative;
  // Georeferenzierte Hintergrund-Rasterbilder (Luftbild) vorhanden? Der GPU-
  // Canvas löscht das Blatt UNDURCHSICHTIG (clearColor …,1) und würde ein
  // dahinterliegendes Bild verdecken. Daher bei aktivem Luftbild bewusst den
  // vollen SVG-Pfad nutzen — dort liegt das Bild als eigene Ebene ZWISCHEN
  // Blatt-Hintergrund und Geometrie (sichtbar, ohne den GL-Renderer zu ändern).
  const hasBgImages = (planRaw.backgroundImages?.length ?? 0) > 0;
  // Eingebettete Bild-Zeichenelemente (Drawing2D `{shape:"image"}`, Foto/Logo/
  // PDF-Seite) kann das GPU-Backend ebenfalls nicht texturieren (kein Bild-
  // Primitiv in render2d, s. toRenderScene.ts `RImage`-Kommentar) — dieselbe
  // SVG-Fallback-Regel wie bei georeferenzierten Luftbildern.
  // useMemo: lief sonst bei JEDEM Render über alle Primitive (3,7 Mio. bei Kataster).
  // Texte/Bilder aus den Typ-Kennungen des Plan-Puffers (`planTextEntries`), ohne alle Primitive zu lesen.
  const hasDrawingImages = useMemo(
    () => planTextEntries(planRaw).some((e) => e.p.kind === "drawingImage"),
    [planRaw],
  );
  // Engine WIRKLICH aktiv? Steuert das Umschalten SVG↔GPU: bei false rendert der
  // volle SVG-Pfad (Fallback), bei true übernimmt die GPU-Ebene + Text-Overlay.
  const useGpuRenderer = wantGpu && glReady && !hasBgImages && !hasDrawingImages && !backdrop;

  // `planRaw.greyedRanges` (andere Ebenen als gedimmte Referenz) ohne Klonen der
  // Primitive: der WebGL-Pfad dimmt selbst beim Zeichnen (nur planRaw), alle
  // übrigen Verbraucher (SVG-Overlay, Schraffur-Muster, WASM) lesen `greyed`
  // direkt am Primitiv und bekommen deshalb diese materialisierte Variante.
  // Linien werden nur geklont, wenn sie NICHT der WebGL-Pfad zeichnet.
  const plan = useMemo(() => {
    // Die kompakte Linien-Unterlage (planRaw.underlay) zeichnet nur der WebGL-Pfad
    // selbst; alle anderen Wege brauchen echte 'line'-Primitive.
    const lines = !useGpuRenderer || wantWasm;
    return materializeGreyed(lines ? materializeUnderlay(planRaw) : planRaw, lines);
  }, [planRaw, useGpuRenderer, wantWasm]);
  // [140] Stempel-Griff an der tatsächlichen Lage des Stempels im Plan (ohne eigenen Anker rückt der Kern
  // ihn vom Pol weg: L-Raum, Hindernisse); sonst am Anker.
  const stampAt = useMemo(
    () => (roomStamp ? (roomStampAt(planRaw, roomStamp.roomId) ?? roomStamp.anchor) : null),
    [planRaw, roomStamp],
  );
  // Kompakte Linien-Unterlage (nur im reinen WebGL-Modus noch als `plan.underlay`
  // vorhanden): Hover/Pick/Marquee/Hervorhebung greifen direkt auf die Zeichnungen
  // zu, Strukturen entstehen LAZY je Plan (s. planView/underlayAccess.ts).
  const underlayRef = useRef<{
    key: UnderlayGroup[];
    drawings: Drawing2D[];
    index?: DrawingIndex | null;
    ids?: Map<string, UnderlayGroup>;
  } | null>(null);
  const getUnderlay = () => {
    const groups = plan.underlay;
    if (!groups || groups.length === 0) return null;
    let c = underlayRef.current;
    if (!c || c.key !== groups) {
      c = { key: groups, drawings: groups.flatMap((g) => g.drawings) };
      underlayRef.current = c;
    }
    return c;
  };
  const getUnderlayIndex = (): DrawingIndex | null => {
    const c = getUnderlay();
    if (!c) return null;
    if (c.index === undefined) c.index = buildDrawingIndex(c.drawings);
    return c.index;
  };
  const getUnderlayIds = (): Map<string, UnderlayGroup> | null => {
    const c = getUnderlay();
    if (!c) return null;
    if (!c.ids) {
      c.ids = new Map();
      for (const g of c.key) for (const d of g.drawings) c.ids.set(d.id, g);
    }
    return c.ids;
  };

  // Nur die Primitive, die das SVG überhaupt selbst zeichnet (der Rest kommt aus
  // WebGL/WASM bzw. — ohne GPU — aus `drawingRuns`), einmal je Plan/Modus
  // vorgefiltert. Sonst liefen Culling UND der React-Abgleich der Kinderliste
  // bei jedem Render über ALLE Primitive — bei einem Kataster-Import 3,7 Mio.
  // GL-Linien, von denen das SVG keine einzige zeichnet (gemessen: 120–170 ms
  // je Zoom-Schritt allein fürs Culling, für am Ende ~500 sichtbare Texte).
  // Mit GPU zeichnet das SVG nur Texte: dann kommen die Kandidaten aus den Text-Einträgen des
  // Plan-Puffers (`planTextEntries`, [K3d]) — die übrigen Primitive werden nicht gelesen.
  const svgCandidates = useMemo(() => {
    const out: Array<{ p: Primitive; i: number }> = [];
    const items: ReadonlyArray<{ p: Primitive; i: number }> = useGpuRenderer ? planTextEntries(plan) : plan.primitives.map((p, i) => ({ p, i }));
    for (const { p, i } of items) {
      const drawnElsewhere = useGpuRenderer
        ? wantWasm
          ? p.kind !== "drawingText"
          : p.kind !== "text" && p.kind !== "drawingText"
        : p.kind === "line" && !!p.drawingId;
      // Texte zeichnet die native Fläche selbst, im selben Frame wie die Linien ([194]): Raumstempel und
      // waagrechte Textfelder über den Glyphen-Pass, gedrehte Einzeiler als Vektor-Glyphen.
      if (useGpuRenderer && wantNative && nativeHook.sceneTexts && isSceneText(p)) continue;
      if (useGpuRenderer && wantNative && nativeHook.gpuTexts && isGpuText(p)) continue;
      if (!drawnElsewhere) out.push({ p, i });
    }
    return out;
  }, [plan, useGpuRenderer, wantWasm, wantNative, nativeHook.gpuTexts, nativeHook.sceneTexts]);
  const needsCull = svgCandidates.length > CULL_THRESHOLD;
  const [cullState, setCullState] = useState<CullState | null>(() => {
    if (!needsCull) return null;
    return computeCullState(defaultView);
  });
  useEffect(() => {
    if (!needsCull) {
      if (cullState !== null) setCullState(null);
      return;
    }
    if (!cullState || cullStateStale(cullState, view)) {
      setCullState(computeCullState(view));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, needsCull, plan]);

  // Stabiler Papier-Massstab-Nenner N (1:N) als REFERENZ für die Print-Strich-
  // breiten. BEWUSST NICHT der live aus dem Zoom abgeleitete N (der sich beim
  // Rad-Zoom ändert): Print-Strichbreiten sind echte Papier-mm, die beim Zoomen
  // MIT der Geometrie skalieren (reinzoomen = dicker). Damit das funktioniert,
  // muss die mm→Welt-Umrechnung an einem beim Rad-Zoom KONSTANTEN N hängen; er
  // ändert sich nur, wenn die Oberleiste explizit einen Massstab setzt
  // (applyScale) bzw. beim ersten Messen/Einpassen. So gilt: 1:10→1:100 = ×10
  // dicker (halber Sprung des Nenners → 10× mehr Welt-Meter je Papier-mm).
  const [paperScale, setPaperScale] = useState<number | null>(null);
  const paperScaleRef = useRef(paperScale);
  paperScaleRef.current = paperScale;
  // Strichmuster (Linientypen) im PLOT-Massstab: fest im Modell-Raum, auch im Anzeigemodus, wo der
  // Strich-Massstab dem Zoom folgt — so gleicht der Rhythmus bei jedem Zoom der Druckansicht.
  activeEngine.setDashScale(paperScale ?? 0);
  // SVG-Pfad: Strichmuster unter non-scaling-stroke über die meet-Variable im Modell-Raum halten
  // (`dashArrayCss`); bei jedem festgeschriebenen Ausschnitt nachgeführt, ohne React-Neuaufbau.
  const syncDashVar = (v: ViewBox) => {
    const el = svgRef.current;
    const m = meetScale(v, canvasRef.current ?? el);
    if (el && m != null && m > 0) el.style.setProperty(PLAN_DASH_VAR, String(m));
  };
  useLayoutEffect(() => syncDashVar(view));
  // Frische Werte in Refs spiegeln, damit das (stabile) imperative Handle und
  // der Resize-Beobachter stets den aktuellen Stand lesen (Handle hat leere Deps).
  const viewRef = useRef(view);
  viewRef.current = view;
  // Lokaler Ursprung des SVG-Overlays (viewBox-Einheiten, s. planView/overlayOrigin.ts): alles, was
  // ins DOM geht, ist relativ dazu (f32-sicher auch bei LV95); `view`, Treffer und Fang bleiben
  // absolut. Bleibt dasselbe Objekt, solange der Ausschnitt in der Nähe bleibt (Memos unten).
  const overlayOriginRef = useRef<Vec2 | null>(null);
  const overlayOrigin = pickOverlayOrigin(view, overlayOriginRef.current);
  overlayOriginRef.current = overlayOrigin;
  const toLocal = useMemo(() => makeToLocal(overlayOrigin), [overlayOrigin]);
  // Live-Massstab für bildschirmkonstante Overlays während Pan/Zoom (s. liveMeet.tsx).
  const meetStore = useMemo(() => createMeetStore(), []);
  // Live-Ausschnitt (Lineal) während Pan/Zoom.
  const viewStore = useMemo(() => createValueStore<ViewBox>(), []);
  const defaultViewRef = useRef(defaultView);
  defaultViewRef.current = defaultView;
  const toScreenRef = useRef(toScreen);
  toScreenRef.current = toScreen;
  const planRef = useRef(plan);
  planRef.current = plan;
  // Zuletzt tessellierter LOD-Bucket (quantisierter Zoom). Nur bei Bucket-Wechsel
  // wird die Bogen-Geometrie neu aufgebaut — sonst bliebe Pan/Zoom reines
  // Matrix-Update. −Infinity = „noch nie tesselliert".
  const lodBucketRef = useRef<number>(-Infinity);

  // Papier-Massstab-Nenner (1:N) für die GL-Strichbreiten — ECHTE mm im Massstab
  // (0.35 mm bei 1:100). Bevorzugt der stabile `paperScale` (wie beim SVG-Print);
  // solange der noch nicht gemessen ist, der live aus dem Ausschnitt abgeleitete N.
  // Im Haarlinien-Modus (Display, wie `textScaleForGl` daneben) NICHT den
  // stabilen `paperScale`: der bliebe beim Rad-Zoom konstant, während die GPU-
  // Strichbreite (`mm_to_device_px` = N/1000·PX_PER_M·meet) über `meet` trotzdem
  // mit dem Zoom wächst — genau der Haarlinien-Bug (Finding 1). Der LIVE aus dem
  // Ausschnitt abgeleitete `scaleFromView` ist hingegen exakt der reziproke Wert
  // von `meet` (siehe dessen Formel), sodass N·meet — und damit die GL-Strich-
  // breite in Geräte-px — unabhängig vom Zoom konstant bleibt: dieselbe Wirkung
  // wie `non-scaling-stroke` im SVG-Pfad, nur über den Massstab-Nenner erzielt.
  // Display-Modus (Haarlinien): Die Strichbreite bleibt NICHT konstant in Pixeln,
  // sondern wächst mit dem Zoom — sanft (Exponent 0.4) relativ zur Ansicht 1:100:
  // weit weg bleiben die Striche fein (mind. 1 px im Shader), nah dran werden sie
  // sichtbar kräftiger statt auf Haarlinien-Breite zu kleben. Bewusst nur MILD (Exponent 0.4, höchstens ×3): bei 0.8/×12 wirkten alle Elemente beim Hineinzoomen klobig dick.
  const paperScaleForGl = (v: ViewBox): number => {
    // Elementbox der GPU-Fläche (NIE transformiert): das SVG trägt während einer
    // imperativen Zoom-Geste einen CSS-Transform, seine Box wäre verzerrt (Striche
    // wurden dadurch beim Herauszoomen kurz riesig).
    const box = canvasRef.current ?? svgRef.current;
    if (!hairline) return paperScaleRef.current ?? scaleFromView(v, box) ?? 100;
    const live = scaleFromView(v, box) ?? 100;
    // Hineinzoomen (live < 100) mild wachsen, Herauszoomen (live > 100) deutlich dünner.
    const grow = Math.min(3, Math.max(0.1, Math.pow(100 / live, live < 100 ? 0.4 : 0.75)));
    return live * grow;
  };

  // Referenz-Nenner (1:N) NUR für die Text-Schriftgröße der Engine — spiegelt
  // EXAKT die SVG-Formel (case "text" unten, gleiche `print`-Bedingung): im
  // normalen Anzeigemodus fest auf die Referenzskala 1:100 (Raumstempel bleibt
  // lesbar, unabhängig vom zufälligen Einpass-Massstab der Ansicht), erst im
  // Druck-Modus der echte gemessene `paperScale`. BEWUSST NICHT `paperScaleForGl`
  // (das dort verwendete live abgeleitete N wäre für Text willkürlich/unlesbar
  // und würde vom SVG-Referenzpfad abweichen — siehe Doku in `gpu::Renderer`).
  const textScaleForGl = (): number => {
    const print = !hairline && paperScale != null && paperScale > 0;
    return print ? paperScale! : 100;
  };

  // Bildschirm-Massstab (Geräte-px je Modell-Meter) beim aktuellen Ausschnitt:
  // meet-Skala (CSS-px je viewBox-Einheit) · PX_PER_M (viewBox-Einheiten je Meter)
  // · dpr (Geräte-px je CSS-px). Steuert die adaptive Bogen-Tessellierung.
  const pxPerMeterForView = (v: ViewBox): number => {
    const meet = meetScale(v, canvasRef.current ?? svgRef.current);
    if (!meet || meet <= 0) return 0;
    return meet * PX_PER_M * (window.devicePixelRatio || 1);
  };
  // LOD-Bucket = quantisierter Zoom (log2 des Bildschirm-Massstabs, auf Ganzzahl
  // gerundet → Schritte von ×2). Nur ein Bucket-Wechsel löst eine Neu-Tessellierung
  // aus; innerhalb eines Buckets bleibt Pan/Zoom reines Matrix-Uniform-Update.
  const lodBucketForView = (v: ViewBox): number => {
    const s = pxPerMeterForView(v);
    return s > 0 ? Math.round(Math.log2(s)) : -Infinity;
  };

  // GL-Geometrie beim Plan-Wechsel neu tessellieren + sofort neu zeichnen. Der
  // aktuelle LOD-Bucket wird mitgeschrieben, damit der Pan/Zoom-Effekt weiss, ab
  // wann sich der Zoom weit genug bewegt hat, um Bögen neu aufzulösen.
  useEffect(() => {
    if (!useGpuRenderer) return;
    const v = viewRef.current;
    updateGeometry(wantWasm ? plan : planRaw, pxPerMeterForView(v));
    lodBucketRef.current = lodBucketForView(v);
    renderGl(v, paperScaleForGl(v), textScaleForGl());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useGpuRenderer, planRaw, wantWasm ? plan : null, updateGeometry, renderGl]);

  // Import-Hinweis (busyStore) beenden, sobald der neue Plan aufgebaut UND
  // gezeichnet ist — deklariert NACH dem Geometrie-Effekt oben, läuft also
  // danach; das Beenden wartet zusätzlich auf den nächsten gemalten Frame.
  useEffect(() => {
    endBusyAfterPaint();
  }, [planRaw]);

  // GL bei jeder Ausschnittsänderung (Pan/Zoom) neu zeichnen. Normalfall: NUR
  // Matrix-Uniform (keine Re-Tessellierung → flüssig). Ausnahme: hat der Zoom
  // einen neuen LOD-Bucket erreicht, werden die Bögen einmalig mit dem neuen
  // Bildschirm-Massstab neu tesselliert (rund beim Hineinzoomen, billig weit weg).
  // Kostennotiz: `updateGeometry` baut die GESAMTE Linien-/Füll-Geometrie neu auf,
  // nicht nur die Bögen — Bucket-Wechsel sind aber selten (Zoom-Faktor ×2).
  useEffect(() => {
    if (!useGpuRenderer) return;
    const bucket = lodBucketForView(view);
    if (bucket !== lodBucketRef.current) {
      lodBucketRef.current = bucket;
      updateGeometry(wantWasm ? plan : planRaw, pxPerMeterForView(view));
    }
    renderGl(view, paperScaleForGl(view), textScaleForGl());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useGpuRenderer, renderGl, view, paperScale]);


  // LIVE Papier-Massstab (1:N) nach oben melden. Berechnung aus der effektiven
  // meet-Skala (Bildschirm-px je viewBox-Einheit) → px je Meter → mm je Meter,
  // verglichen mit der Papier-Abbildung. Aktualisiert bei Ausschnitts-/Größen-
  // änderung; ein ResizeObserver fängt reine Größenänderungen ab.
  const reportScale = () => {
    if (!onScale) return;
    const n = scaleFromView(viewRef.current, svgRef.current);
    if (n != null && isFinite(n)) onScale(n);
  };
  useEffect(() => {
    reportScale();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScale, view, plan]);
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => reportScale());
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onScale]);

  // Referenz-Papier-Massstab initialisieren, sobald das SVG messbar ist (bzw. der
  // Plan/das Geschoss wechselt): aus dem AKTUELLEN Ausschnitt (der beim Wechsel
  // eingepasst wird). Danach bleibt er beim Rad-Zoom stehen; applyScale setzt ihn
  // explizit neu. Ohne Messung (SSR/erste Runde) bleibt er null → Fallback im
  // Renderer auf live-N, damit Print nie „unsichtbar" wird.
  useEffect(() => {
    if (paperScaleRef.current != null) return;
    const n = scaleFromView(viewRef.current, svgRef.current);
    if (n != null && isFinite(n) && n > 0) setPaperScale(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);
  // Beim Plan-/Geschoss-Wechsel den Referenz-Massstab an den (frisch eingepassten)
  // Ausschnitt angleichen.
  useEffect(() => {
    const n = scaleFromView((startViewRef ?? defaultViewRef).current, svgRef.current);
    if (n != null && isFinite(n) && n > 0) setPaperScale(n);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  return {
    getPick,
    svgRef,
    canvasRef,
    wantNative,
    wantWasm,
    nativeHook,
    renderGl,
    wantGpu,
    hasBgImages,
    useGpuRenderer,
    plan,
    stampAt,
    getUnderlay,
    getUnderlayIndex,
    getUnderlayIds,
    svgCandidates,
    cullState,
    paperScale,
    setPaperScale,
    syncDashVar,
    viewRef,
    overlayOriginRef,
    overlayOrigin,
    toLocal,
    meetStore,
    viewStore,
    defaultViewRef,
    toScreenRef,
    planRef,
    paperScaleForGl,
    textScaleForGl,
  };
}

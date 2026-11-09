# src/views

Die Haupt-Ansichten der Hülle: der Inhalt der Bildschirmmitte und die Plan-Ansicht samt ihren Renderer-Hooks.
Gerechnet wird hier nichts; Pläne und Szenen kommen aus `src/plan` (Fassaden über den Kern). Wie ein
Grundriss auf den Bildschirm kommt: `doc/ARCHITEKTUR.md`, Abschnitt 3.4.

## Oberste Ebene

| Datei | Inhalt |
|---|---|
| `viewportContent.tsx` | `Content`: Router der Bildschirmmitte. Geschoss zeigt Grundriss oder 3D, Schnitt und Ansicht zeigen die Schnitt-/Ansichts-Plan-Ansicht, freie Zeichnung die Ebenen-Ansicht, ein Layout das Blatt (`src/ui/LayoutSheet.tsx`) |
| `ViewportCenter.tsx` | Bildschirmmitte samt Befehlszeile: abonniert das Projekt und rechnet Griff-Eingaben, 2D-/3D-Griffe, Zifferntasten der Werkzeuge und die Bindung von Befehlszeile und HUD, damit `App` das Projekt nicht abonniert ([121]) |
| `InlineEditor.tsx` | kleiner schwebender Editor am Anker (Ebenen- und Geschoss-Eigenschaften); rein darstellend, die Felder rufen die übergebenen Patch-Handler |

## plan/

| Datei | Inhalt |
|---|---|
| `plan/PlanView.tsx` | die Plan-Ansicht: Kamera, Picken, Marquee, Werkzeug-Eingaben. Legt über die GPU-Fläche eine SVG-Ebene für Auswahl, Griffe, Fang und Text; ohne GPU-Weg zeichnet diese Ebene den ganzen Plan (`?gl=0`) |
| `plan/useWasmPlanRenderer.ts` | Hook für render2d als WASM/WebGPU (Browser, Electron): verbindet Canvas, Plan und Ausschnitt mit der Renderer-Sitzung |
| `plan/wasmRendererSession.ts` | Besitzer des WASM-Renderers eines Canvas: der eine Ort, der render2d aufruft (Bild, Grösse, Verlust des GPU-Geräts) |
| `plan/useNativePlanRenderer.ts` | Hook für den nativen Metal-Weg auf macOS (Tauri); dieselbe Schnittstelle, die Pixel entstehen in einer Fläche unter der Webansicht |
| `plan/nativeGl.ts` | Puffer-Attrappe für den nativen Renderer: die Bytes der GPU-Chunks (`src/plan/glPlan`) gehen einmal an Rust, pro Frame nur der Ausschnitt |
| `plan/nativeFrameQueue.ts` | bündelt die Frame-Aufrufe an die native Fläche |
| `plan/nativeSync.ts` | spiegelt die sichtbare 2D-Szene (`planSceneBin()`) und die 3D-Wände in die nativen Fenster (`src-tauri/src/native.rs`) |
| `plan/cssColor.ts` | liest CSS-Variablen als RGB für die GPU-Renderer |
| `plan/pickCycle.ts` | Klick-Zyklus: erneuter Klick an derselben Stelle wählt das nächste Objekt unter dem Cursor (`[137]`) |

## plan/planView/

Teile der Plan-Ansicht, die aus `PlanView.tsx` herausgelöst sind; fast alles reine Darstellung, die `toScreen` und
Massstab als Props bekommt.

| Datei | Inhalt |
|---|---|
| `planView/primitives.tsx` | SVG-Darstellung der Plan-Primitive: Schraffur-`<pattern>`, gebündelte Zeichen-Läufe, Umfärben |
| `planView/overlays.tsx` | Werkzeug-Vorschau, Cursor-HUD, Winkel-Führungslinie, Fangmarken |
| `planView/overlayOrigin.ts` | lokaler Ursprung der SVG-Überlagerung (gegen Zahlenverlust bei grossen Koordinaten) |
| `planView/liveMeet.tsx` | bildschirmkonstanter Massstab für Überlagerungen während einer Pan-/Zoom-Geste |
| `planView/gripCull.ts` | welche Griffe bei sehr vielen Stützpunkten gezeichnet werden (nur im Ausschnitt) |
| `planView/PlanGrid.tsx`, `planView/PlanRulers.tsx` | sichtbares Raster und Lineale am Rand |

Picken, Culling, Marquee und Massstab-Helfer ohne React liegen in `src/plan/planView/`.

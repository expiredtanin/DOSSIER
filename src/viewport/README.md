# src/viewport

Der 3D-Viewport der Hülle: render3d als WASM/WebGPU-Canvas, dazu Kamera, Auswahl und Griffe. Das 3D-Modell
kommt als Teile aus dem Kern (`src/plan/toWalls3d.ts`). Weg eines Modells in den Viewer:
`doc/ARCHITEKTUR.md`, Abschnitt 6.

## Viewport und Renderer

| Datei | Inhalt |
|---|---|
| `Wasm3DViewport.tsx` | die 3D-Ansicht: Canvas, Maus und Tastatur, Auswahl, Griffe, Cursor-HUD, Live-Schnitt |
| `Viewport3D.tsx` | Zugang zur Ansicht (`Viewport3D = Wasm3DViewport`) und die geteilten Typen (`RenderDisplay`, `DisplayResolver`) |
| `useWasm3dRenderer.ts` | Hook: lädt render3d, hält Modell, Kamera und Punktwolken, zeichnet; Typ `Camera3d` |
| `cameraView.ts` | [213] Kamera-Element (`Project.cameras`) ↔ Sicht des Viewports: `cameraToView`, `cameraFromView`, Brennweite, Geschoss zur Höhe |
| `walk.ts` | [213] Begehen (WASD): Bewegung und Umschauen als reine Funktionen auf dem Orbit-Zustand |
| `cameraBridge.ts` | Kamera von aussen lesen und setzen, Bild-Schnappschuss, Live-Schnittebene (für BCF-Viewpoints) |

## Abgleich mit render3d

| Datei | Inhalt |
|---|---|
| `ghostSync.ts` | Prüfsumme der Geisterschicht (graue Klassen/Geschosse): render3d bekommt sie nur bei Änderung neu |
| `model3dPartsSync.ts` | schickt nur neue, geänderte und entfernte Modellteile an render3d (`set_parts`) |
| `pointCloudSync.ts` | Punktwolken-Store gegen render3d abgleichen: neu laden, umstellen oder entfernen (`[27]`) |
| `materialTextures.ts` | dekodiert die Farbkarten der Materialien für den Stil „Textured" |
| `sun3d.ts` | Sonnenrichtung und Schalter für Schatten im 3D aus der Sonnenstudie (`[64]`) |

## Auswahl und Griffe

| Datei | Inhalt |
|---|---|
| `raycast3d.ts` | reine Strahlen-Mathematik auf den Pick-Daten des Kerns, ohne React und Engine |
| `drawingGrips.ts` | Griff-Geometrie eines 2D-Elements im 3D |
| `grip3dHud.ts` | Geometrie-Helfer für die Werteanzeige beim Ziehen eines 3D-Griffs |
| `planHitTest.ts` | Wand-Treffer im Modellraum für das Kontextmenü im Grundriss |

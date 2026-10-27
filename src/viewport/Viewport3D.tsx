// 3D-Viewport: dünner Zugang zur Nordstern-Engine (render3d als WASM/WebGPU, `Wasm3DViewport`).
// Es gibt keinen Zweitrenderer mehr (three.js und der WebGL2-Fallback sind entfernt); fehlt
// WebGPU, meldet `Wasm3DViewport` das im Viewport. Hier leben nur noch die geteilten Typen.

import { Wasm3DViewport } from "./Wasm3DViewport";

/**
 * Render-Entscheidung je Element (Geschoss bzw. Kategorie) im 3D — gespiegelt
 * aus dem Panel-Darstellungsmodus (vgl. ItemDisplay). `render`=false lässt das
 * Element weg, `greyed`=true zeichnet es mit gedämpftem, transparentem Material.
 */
export interface RenderDisplay {
  render: boolean;
  greyed: boolean;
}

/** Resolver: liefert je Geschoss-ID / Kategorie-Code die Render-Entscheidung. */
export type DisplayResolver = (key: string) => RenderDisplay;

/** Öffentliche 3D-Sicht (Props = die der Engine-Komponente). */
export const Viewport3D = Wasm3DViewport;

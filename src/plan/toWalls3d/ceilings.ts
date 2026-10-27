// Decken-Domäne der 3D-Ableitung: extrudiert `project.ceilings` zu geschichteten
// Deckenplatten (eine RSlab je Materiallage, oben→unten gestapelt) — das 3D-
// Pendant zu `generatePlan/ceilings.ts::addCeilingPoche`.
//
// Die Rechnung (Aussparungen über den Brücken-Trick in EINEN einfachen Umriss, derselbe Ring für
// ALLE Schichten; z-Spanne proportional auf die Schichten verteilt) steht in Rust
// (`src-tauri/core/src/ceilings3d.rs`). Hier nur: aus dem `Project` sammeln und je Schicht
// Farbe, Schraffur und Schnitt-Metadaten zuordnen.

import type { Ceiling, Layer, Project } from "../../model/types";
import { getCeilingType, getComponent } from "../../model/types";
import { ceilingVerticalExtent } from "../../model/wall";
import { core } from "../../engine/coreWasm";
import { FlatWriter } from "../../geometry/coreFlat";
import {
  SLAB_RGB,
  hexToRgb,
  resolveComponentHatch,
  resolveCutLineStyle,
  type RCutMeta,
  type RRgb,
  type RSlab,
  type RVec2,
} from "./shared";

/** Emittiert die Deckenplatten eines Projekts (falls vorhanden). */
export function emitSlabs(project: Project): RSlab[] {
  const ceilings: Ceiling[] = [];
  const layersOf: (Layer[] | undefined)[] = [];
  const w = new FlatWriter();
  const count = w.slot();
  for (const c of project.ceilings ?? []) {
    if (!c.outline || c.outline.length < 3) continue;
    // zBottom/zTop (und damit die Deckendicke) berechnet ceilingVerticalExtent
    // bereits über ceilingThickness (respektiert Typ-Dicke + Übersteuerung).
    const { zBottom, zTop } = ceilingVerticalExtent(project, c);
    // Kein auflösbarer Deckentyp ⇒ keine Lagen ⇒ EIN Vollkörper-Slab in SLAB_RGB.
    let layers: Layer[] | undefined;
    try {
      layers = getCeilingType(project, c).layers;
    } catch {
      layers = undefined;
    }
    w.ring(c.outline);
    const openings = c.openings ?? [];
    w.num(openings.length);
    for (const o of openings) w.ring(o);
    w.num(zBottom, zTop, layers?.length ?? 0);
    for (const l of layers ?? []) w.num(l.thickness);
    ceilings.push(c);
    layersOf.push(layers);
  }
  if (ceilings.length === 0) return [];
  w.set(count, ceilings.length);
  const f = core().ceilings3d_flat(w.done());

  const out: RSlab[] = [];
  let i = 1;
  for (let n = f.length ? f[0] : 0; n > 0; n--) {
    const ci = f[i++];
    const c = ceilings[ci];
    const layers = layersOf[ci];
    const nPts = f[i++];
    const outline: RVec2[] = new Array(nPts);
    for (let k = 0; k < nPts; k++, i += 2) outline[k] = [f[i], f[i + 1]];
    for (let s = f[i++]; s > 0; s--, i += 3) {
      const layerIdx = f[i];
      const zBottom = f[i + 1];
      const zTop = f[i + 2];
      if (layerIdx < 0 || !layers) {
        out.push({ outline, zBottom, zTop, color: SLAB_RGB, ceilingId: c.id });
        continue;
      }
      const l = layers[layerIdx];
      let color: RRgb = SLAB_RGB;
      let cut: RCutMeta | undefined;
      try {
        const comp = getComponent(project, l.componentId);
        color = hexToRgb(comp.color);
        // Schnitt-Metadaten der Schicht: joinPriority + Identität (für die
        // Boolean-Dominanz/MERGE) + Schnittkanten-Stil aus jointLineStyleId.
        const lineStyle = resolveCutLineStyle(project, l.jointLineStyleId);
        cut = {
          joinPriority: comp.joinPriority,
          componentId: comp.id,
          ...(lineStyle?.color ? { lineColor: lineStyle.color } : {}),
          ...(lineStyle?.weight != null ? { lineWeight: lineStyle.weight } : {}),
        };
      } catch {
        color = SLAB_RGB;
        cut = undefined;
      }
      const hatch = resolveComponentHatch(project, l.componentId);
      out.push({
        outline,
        zBottom,
        zTop,
        color,
        ceilingId: c.id,
        ...(hatch ? { hatch } : {}),
        ...(cut ? { cut } : {}),
      });
    }
  }
  return out;
}

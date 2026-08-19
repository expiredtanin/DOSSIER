// Decken-Domäne der 3D-Ableitung: extrudiert `project.ceilings` zu geschichteten
// Deckenplatten (eine RSlab je Materiallage, oben→unten gestapelt) — das 3D-
// Pendant zu `generatePlan/ceilings.ts::addCeilingPoche`.

import type { Layer, Project } from "../../model/types";
import { getCeilingType, getComponent } from "../../model/types";
import { ceilingVerticalExtent } from "../../model/wall";
import { mergeHoles } from "../../geometry/polygonHoles";
import {
  EPS,
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
  const out: RSlab[] = [];
  for (const c of project.ceilings ?? []) {
    if (!c.outline || c.outline.length < 3) continue;
    // zBottom/zTop (und damit die Deckendicke) berechnet ceilingVerticalExtent
    // bereits über ceilingThickness (respektiert Typ-Dicke + Übersteuerung).
    const { zBottom, zTop } = ceilingVerticalExtent(project, c);
    if (zTop - zBottom <= EPS) continue;
    // Aussparungen (Treppenauge/Schacht) über den Brücken-Trick in EINEN
    // einfachen Umriss-Ring einfügen — derselbe Ring für ALLE Schichten dieser
    // Decke. Kein `openings` ⇒ unverändertes `c.outline` (exakt heutiges
    // Verhalten). Der Ring ist paritätskorrekt fürs Ear-Clipping (render3d)
    // UND fürs Pick (pickGeometry nutzt denselben emitSlabs-Pfad): ein Klick
    // ins Loch trifft die Decke NICHT — das ist gewollt.
    const openings = c.openings ?? [];
    const mergedOutline = openings.length ? mergeHoles(c.outline, openings).ring : c.outline;
    const outline = mergedOutline.map((p) => [p.x, p.y] as RVec2);

    // Geschichteter Bodenaufbau: je Schicht des Deckentyps EIN eigener Slab,
    // von oben (OK, erste Lage) nach unten (UK, letzte Lage) gestapelt und
    // proportional auf die tatsächliche z-Spanne [zBottom, zTop] verteilt (wie
    // die Lagen-Summe bei den Wänden). Jede Lage trägt ihre Bauteil-Schraffur +
    // -Farbe — so zeigt der 3D-Schnitt den Bodenaufbau GESCHICHTET (Estrich/
    // Dämmung/Beton …), identisch zum 2D-Schnitt, statt eines Einkörpers in der
    // dominanten Schicht. Kein auflösbarer Deckentyp / keine Lagen ⇒ EIN
    // Vollkörper-Slab in SLAB_RGB (bisheriges Fallback-Verhalten).
    let layers: Layer[] | undefined;
    try {
      layers = getCeilingType(project, c).layers;
    } catch {
      layers = undefined;
    }
    const total = layers?.reduce((s, l) => s + l.thickness, 0) ?? 0;
    if (layers && layers.length > 0 && total > EPS) {
      const span = zTop - zBottom;
      let prefixTop = 0; // von OK (zTop) nach unten aufsummiert (Meter)
      for (const l of layers) {
        const t = (l.thickness / total) * span;
        const layerTop = zTop - prefixTop;
        const layerBottom = layerTop - t;
        prefixTop += t;
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
          zBottom: layerBottom,
          zTop: layerTop,
          color,
          ceilingId: c.id,
          ...(hatch ? { hatch } : {}),
          ...(cut ? { cut } : {}),
        });
      }
    } else {
      out.push({ outline, zBottom, zTop, color: SLAB_RGB, ceilingId: c.id });
    }
  }
  return out;
}

// Stiftsatz-Auflösung (ArchiCAD-Stiftsatz-Muster) — reine Funktionen, keine
// Modell-Mutation. Der Trick, der jeden bestehenden Farb-/Strichstärke-Leser
// (2D-Plan, beide 3D-Renderer, DXF-Export, Vorschau-Swatches) UNVERÄNDERT
// lässt: `Component.color`/`.foreground`/`.background`, `LayerCategory.color`/
// `.lw` bzw. die Element-Felder (`color`/`strokeWeight`/`weightMm`) bleiben
// IMMER die eine gültige, aufgelöste Farbe/Strichstärke. Ein Stift-Verweis
// (`xxxPenId`) schreibt diese Felder nur bei Gelegenheit (Stiftsatz-Wechsel,
// Stift-Änderung, neue Zuweisung) per `rebakePenColors` aus dem aktiven
// Stiftsatz NEU — kein Leser muss je einen Stift auflösen.
//
// Ein Stift (`PenStyle`) trägt Farbe UND Strichstärke zusammen (wie ein
// echter ArchiCAD-/AutoCAD-Stift) — beide wandern gemeinsam, wenn ein
// Element/eine Ebene auf „Stift" statt „Frei" gestellt wird.
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import type { ColorPen, Component, LayerCategory, PenSet, PenStyle, Project } from "./types";

/** Farbe eines Stifts, der im aktiven Stiftsatz (noch) keinen Eintrag hat. */
export const PEN_FALLBACK_COLOR = "#9aa0a6";
/** Strichstärke (mm) eines Stifts, der im aktiven Stiftsatz (noch) keinen Eintrag hat. */
export const PEN_FALLBACK_WEIGHT = 0.18;

/** HSL (h in Grad 0..360, s/l in 0..1) → "#rrggbb". Reine Konvertierung, keine Bibliothek nötig. */
export function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = l - c / 2;
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
}

/**
 * Feste Freie-Farbe-Palette für den Palette-Popover (`ui/PenColorField.tsx`):
 * 8 Graustufen (Schwarz→Weiss) + 8 Farbtöne × 5 Helligkeitsstufen = 48
 * Swatches. Rein prozedural (HSL), dieselbe Begründung wie
 * `generateStandardPenPalette` — kein externes Farbschema.
 */
export const FREE_COLOR_PALETTE: string[] = (() => {
  const out: string[] = [];
  for (let i = 0; i < 8; i++) {
    const v = Math.round((i / 7) * 255);
    out.push(`#${v.toString(16).padStart(2, "0").repeat(3)}`);
  }
  for (let hue = 0; hue < 8; hue++) {
    for (let level = 0; level < 5; level++) {
      out.push(hslToHex(hue * 45, 0.75, 0.75 - level * 0.14));
    }
  }
  return out;
})();

/**
 * Generiert 255 Stifte + einen passenden Stiftsatz nach klassischer CAD-
 * Nummerierungs-Konvention (AutoCAD Color Index / ArchiCAD-Stiftsätze): Stifte
 * 1–9 die Grundfarben (Rot/Gelb/Grün/Cyan/Blau/Magenta/Schwarz/zwei Grautöne —
 * dieselben Werte wie die bestehende `ACI_PALETTE` in `export/exportDxf.ts`,
 * damit beide Stellen konsistent bleiben), 10–249 24 Farbtöne × 10 Helligkeits-/
 * Sättigungsstufen (prozedural per HSL erzeugt), 250–255 ein Graustufen-Keil
 * (identische Werte wie `ACI_PALETTE`s 250–255). **Keine externe Bibliothek
 * oder ein konkretes lizenziertes Farbschema** — reine Mathematik (HSL-Kreis),
 * daher lizenzfrei; strukturell an die altbekannte 255-Stift-Konvention aus
 * AutoCAD/ArchiCAD angelehnt, nicht Pixel-für-Pixel identisch mit deren
 * (proprietärer) Originaltabelle. Strichstärke einheitlich `PEN_FALLBACK_WEIGHT`
 * (0.18 mm) — im Stiftsatz-Tab pro Stift frei änderbar.
 */
export function generateStandardPenPalette(): { pens: ColorPen[]; styles: Record<string, PenStyle> } {
  const pens: ColorPen[] = [];
  const styles: Record<string, PenStyle> = {};
  const add = (id: number, name: string, color: string) => {
    pens.push({ id: String(id), name });
    styles[String(id)] = { color, weight: PEN_FALLBACK_WEIGHT };
  };

  // 1–9: Grundfarben (wie ACI_PALETTE in exportDxf.ts).
  add(1, "Rot", "#ff0000");
  add(2, "Gelb", "#ffff00");
  add(3, "Grün", "#00ff00");
  add(4, "Cyan", "#00ffff");
  add(5, "Blau", "#0000ff");
  add(6, "Magenta", "#ff00ff");
  add(7, "Schwarz", "#000000");
  add(8, "Dunkelgrau", "#414141");
  add(9, "Grau", "#808080");

  // 10–249: 24 Farbtöne (15°-Schritte) × 10 Stufen (5 gesättigt hell→dunkel,
  // 5 entsättigt hell→dunkel) — 240 Stifte.
  let id = 10;
  for (let hue = 0; hue < 24; hue++) {
    const h = hue * 15;
    for (let step = 0; step < 10; step++) {
      const saturated = step < 5;
      const level = step % 5; // 0..4
      const l = 0.75 - level * 0.14; // 0.75 → 0.19
      const s = saturated ? 0.85 : 0.4;
      add(id, `Stift ${id}`, hslToHex(h, s, l));
      id++;
    }
  }

  // 250–255: Graustufen-Keil (wie ACI_PALETTE).
  const greys: [number, string][] = [
    [250, "#333333"],
    [251, "#5b5b5b"],
    [252, "#848484"],
    [253, "#adadad"],
    [254, "#d6d6d6"],
    [255, "#ffffff"],
  ];
  for (const [gid, color] of greys) add(gid, `Grau ${gid}`, color);

  return { pens, styles };
}

/**
 * Setzt `Project.pens`/`penSets` auf die generierte 255er-Standardpalette
 * (s. {@link generateStandardPenPalette}) — ERSETZT bestehende `pens`/den neu
 * angelegten Satz vollständig (kein Merge), gedacht für den Erststart, bevor
 * eigene Stifte/Sätze existieren. Der neue Satz wird aktiv, wenn noch KEIN
 * Stiftsatz aktiv war (dieselbe Konvention wie `addPenSet`).
 */
export function seedStandardPenSet(project: Project): Project {
  const { pens, styles } = generateStandardPenPalette();
  const penSet: PenSet = { id: `penset-${Date.now()}`, name: "Standard (CAD-Palette)", pens: styles };
  return rebakePenColors({
    ...project,
    pens,
    penSets: [...(project.penSets ?? []), penSet],
    activePenSetId: project.activePenSetId ?? penSet.id,
  });
}

/** Der aktuell aktive Stiftsatz, oder `undefined` (kein Stiftsatz angelegt/aktiviert). */
export function activePenSet(project: Project) {
  return project.penSets?.find((s) => s.id === project.activePenSetId);
}

/** Der Stil (Farbe+Strichstärke) EINES Stifts im aktiven Stiftsatz, oder `undefined` ohne Eintrag/Satz. */
export function resolvePenStyle(project: Project, penId: string): PenStyle | undefined {
  return activePenSet(project)?.pens[penId];
}

/** Löst einen Stift gegen den aktiven Stiftsatz auf; Fallback bei fehlendem Eintrag. */
export function resolvePenColor(project: Project, penId: string): string {
  return resolvePenStyle(project, penId)?.color ?? PEN_FALLBACK_COLOR;
}

/** Strichstärke (mm) eines Stifts, analog {@link resolvePenColor}. */
export function resolvePenWeight(project: Project, penId: string): number {
  return resolvePenStyle(project, penId)?.weight ?? PEN_FALLBACK_WEIGHT;
}

/** Bäckt die Stift-Farbe(n) EINES Bauteils neu (reine Funktion, unverändert wenn kein Stift gesetzt). */
function bakeComponent(project: Project, c: Component): Component {
  if (!c.colorPenId && !c.foregroundPenId && !c.backgroundPenId) return c;
  return {
    ...c,
    ...(c.colorPenId ? { color: resolvePenColor(project, c.colorPenId) } : {}),
    ...(c.foregroundPenId ? { foreground: resolvePenColor(project, c.foregroundPenId) } : {}),
    ...(c.backgroundPenId ? { background: resolvePenColor(project, c.backgroundPenId) } : {}),
  };
}

/** Bäckt Farbe UND Strichstärke (`.lw`) EINER Ebenen-Kategorie neu (rekursiv über `children`). */
function bakeCategory(project: Project, cat: LayerCategory): LayerCategory {
  const next: LayerCategory = cat.colorPenId
    ? { ...cat, color: resolvePenColor(project, cat.colorPenId), lw: resolvePenWeight(project, cat.colorPenId) }
    : cat;
  if (!cat.children) return next;
  const children = cat.children.map((c) => bakeCategory(project, c));
  return children === cat.children ? next : { ...next, children };
}

/**
 * Bäckt die eigene `color`-Stift-Kopplung EINES Modell-Elements neu (nur
 * Farbe — für Elementarten ohne eigenes Strichstärke-Override-Feld: Dach,
 * Öffnung, Treppe, Raum). Unverändert (referenzgleich), wenn kein Stift
 * gesetzt ist.
 */
function bakeElementColor<T extends { colorPenId?: string; color?: string }>(
  project: Project,
  x: T,
): T {
  return x.colorPenId ? { ...x, color: resolvePenColor(project, x.colorPenId) } : x;
}

/**
 * Wie {@link bakeElementColor}, zusätzlich (a) die Strichstärke unter
 * `weightKey` (Wand/Decke/Stütze: `strokeWeight`; Drawing2D: `weightMm`) —
 * nur über `colorPenId` gekoppelt (ein Stift trägt Farbe UND Strichstärke
 * zusammen; Vordergrund/Hintergrund sind reine Musterfarben ohne
 * Strichstärke-Aspekt) — und (b) die Attribut-Override-Farben `foreground`/
 * `background` DIESER Element-Instanz, unabhängig über `foregroundPenId`/
 * `backgroundPenId` (analog `Component.foregroundPenId`/`backgroundPenId`,
 * nur eben am Element statt am Bauteil). Für Elementarten MIT eigenem
 * Strichstärke- UND Vordergrund/Hintergrund-Override-Feld (Wand/Decke/
 * Stütze/Drawing2D — exakt dieselben vier wie bei der Strichstärke).
 */
function bakeElementColorAndWeight<
  T extends {
    colorPenId?: string;
    color?: string;
    foregroundPenId?: string;
    foreground?: string;
    backgroundPenId?: string;
    background?: string;
  },
  K extends string,
>(project: Project, x: T & Partial<Record<K, number>>, weightKey: K): T {
  if (!x.colorPenId && !x.foregroundPenId && !x.backgroundPenId) return x;
  return {
    ...x,
    ...(x.colorPenId
      ? { color: resolvePenColor(project, x.colorPenId), [weightKey]: resolvePenWeight(project, x.colorPenId) }
      : {}),
    ...(x.foregroundPenId ? { foreground: resolvePenColor(project, x.foregroundPenId) } : {}),
    ...(x.backgroundPenId ? { background: resolvePenColor(project, x.backgroundPenId) } : {}),
  };
}

/**
 * Schreibt für JEDES Bauteil/JEDE Ebenen-Kategorie/JEDES Modell-Element mit
 * gesetztem Stift die Farbe (+ ggf. Strichstärke) des AKTIVEN Stiftsatzes in
 * `color`/`foreground`/`background`/`lw`/`strokeWeight`/`weightMm` — reine
 * Funktion, liefert ein neues `Project` (unveränderte Teile bleiben
 * referenzgleich). Aufzurufen nach: Stiftsatz-Wechsel, Änderung EINES Stifts
 * im aktiven Satz, oder Neuzuweisung eines Stifts an ein Bauteil/eine Ebene
 * (dort reicht meist ein direkter Patch, s. `resolvePenColor`/
 * `resolvePenWeight` — diese Funktion ist für die FLÄCHIGEN Fälle, die viele
 * Objekte auf einmal betreffen).
 *
 * Bewusst NICHT abgedeckt: Layout-Annotationen (`Layout.annotations[]`,
 * verschachtelt in `Project.layouts`) und `Tür`/`ExtrudedSolid`/Kontext-
 * Objekte — kein `colorPenId`-Feld dort (Scope-Entscheid, s. PENDENZEN.md).
 */
export function rebakePenColors(project: Project): Project {
  return {
    ...project,
    components: project.components.map((c) => bakeComponent(project, c)),
    layers: project.layers.map((cat) => bakeCategory(project, cat)),
    walls: project.walls.map((w) => bakeElementColorAndWeight(project, w, "strokeWeight")),
    drawings2d: project.drawings2d.map((d) => bakeElementColorAndWeight(project, d, "weightMm")),
    ceilings: project.ceilings?.map((c) => bakeElementColorAndWeight(project, c, "strokeWeight")),
    columns: project.columns?.map((c) => bakeElementColorAndWeight(project, c, "strokeWeight")),
    roofs: project.roofs?.map((r) => bakeElementColor(project, r)),
    openings: project.openings?.map((o) => bakeElementColor(project, o)),
    stairs: project.stairs?.map((s) => bakeElementColor(project, s)),
    rooms: project.rooms?.map((r) => bakeElementColor(project, r)),
  };
}

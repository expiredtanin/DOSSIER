// [264] Vorgaben eines NEUEN Projekts in der Oberflächensprache: Projektname, Geschosse/Schnitt/Ansicht
// („Erdgeschoss“, „Schnitt A“ …) und die Ebenennamen („20 Wände“). Nur für frisch angelegte Projekte;
// geladene Projekte und deren Namen bleiben unangetastet (Daten werden nie übersetzt). Die Codes und
// Kennungen bleiben gleich, nur `name` ändert sich — Standards (Kern) gleichen Ebenen über den Code ab.

import { t } from "../i18n/translate";
import type { LayerCategory, Project } from "./types";

function localizeLayers(layers: LayerCategory[]): LayerCategory[] {
  return layers.map((l) => {
    const key = `newProject.layer.${l.code}`;
    const name = t(key);
    return {
      ...l,
      name: name === key ? l.name : name,
      ...(l.children ? { children: localizeLayers(l.children) } : {}),
    };
  });
}

/** [264] Ressourcen der Vorlage (Linienstile, Schraffuren, Bauteile, Aufbauten, Typen), die der Kern nicht liefert. */
const RESOURCE_LISTS = ["lineStyles", "hatches", "components", "wallTypes", "ceilingTypes", "roofTypes", "doorTypes", "windowTypes", "stairTypes"] as const;

function localizeResources(project: Project): Partial<Project> {
  const out: Record<string, unknown> = {};
  const src = project as unknown as Record<string, { id: string; name: string }[] | undefined>;
  for (const list of RESOURCE_LISTS) {
    const items = src[list];
    if (!items) continue;
    out[list] = items.map((it) => {
      const key = `newProject.res.${list}.${it.id}`;
      const name = t(key);
      return name === key ? it : { ...it, name };
    });
  }
  return out as Partial<Project>;
}

/** Das Projekt mit Namen von Projekt, Geschossen/Schnitt/Ansicht und Ebenen in der aktuellen UI-Sprache. */
export function withNewProjectNames(project: Project): Project {
  return {
    ...project,
    name: t("newProject.name"),
    drawingLevels: project.drawingLevels.map((l) => {
      const key = `newProject.level.${l.id}`;
      const name = t(key);
      return name === key ? l : { ...l, name };
    }),
    layers: localizeLayers(project.layers),
    ...localizeResources(project),
  };
}

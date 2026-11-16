// [267] Ansichten Nord/Ost/Süd/West in einem Schritt: der Kern (`elevation_set.rs`) legt um das Gebaute vier
// Ansichtslinien an und lässt Seiten mit vorhandener Ansicht aus. Hier nur die Brücke: Namen (t()), Abfrage vorab
// für die Meldung, Mutation. Gebraucht vom Befehl `ansichten` und vom Menü (`state/elevationSet.ts`); ohne Store, damit der Befehl keinen Importzyklus über die Registry bildet.

import { cmdMutation, documentFor } from "../core/document";
import type { ProjectMutation } from "../core";
import type { Project } from "../model/types";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import { uniqueStamp } from "../tools/types";

type Side = "north" | "east" | "south" | "west";

const NAME_KEY: Record<Side, TranslationKey> = {
  north: "elevations.name.north",
  east: "elevations.name.east",
  south: "elevations.name.south",
  west: "elevations.name.west",
};

interface Plan {
  empty: boolean;
  create: Side[];
  existing: Side[];
}

/** Meldung (i18n-Key + Platzhalter + Art) zum Ergebnis. */
export interface ElevationSetNotice {
  key: TranslationKey;
  params?: Record<string, string | number>;
  kind: "info" | "warning";
}

const names = (sides: Side[]): string => sides.map((s) => t(NAME_KEY[s])).join(", ");

/** Mutation (nur wenn etwas entsteht) und Meldung für `project`. */
export function elevationSetFor(project: Project): { commit?: ProjectMutation; notice: ElevationSetNotice } {
  const plan = documentFor(project).createQuery<Plan>({ q: "elevationsPlan" });
  if (plan.empty) return { notice: { key: "elevations.empty", kind: "warning" } };
  if (plan.create.length === 0) return { notice: { key: "elevations.allExist", kind: "info" } };
  const commit = cmdMutation({
    cmd: "elevations",
    names: { north: t(NAME_KEY.north), east: t(NAME_KEY.east), south: t(NAME_KEY.south), west: t(NAME_KEY.west) },
    stamp: uniqueStamp(),
  });
  const done = { n: plan.create.length, names: names(plan.create) };
  const notice: ElevationSetNotice = plan.existing.length
    ? { key: "elevations.doneSkipped", params: { ...done, existing: names(plan.existing) }, kind: "info" }
    : { key: "elevations.done", params: done, kind: "info" };
  return { commit, notice };
}

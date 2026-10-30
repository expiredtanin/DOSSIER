// Publikationssätze ([79]) in der Hülle: Satz anlegen/ändern/löschen als Ops, Satz ausführen = Dateien erzeugen,
// speichern (mehrere als ZIP), Revisionsindex erhöhen und ins Protokoll schreiben (ein Undo-Schritt).

import { fieldOps, type CoreOp } from "../core";
import type { Project, PublishSet } from "../model/types";
import { planPublish, publishOps } from "../export/publishSet";
import { bundlePublished, runPublish } from "../export/publishRun";
import { saveBinaryFile } from "../native/saveFile";
import { getState } from "./appStore";
import { t } from "../i18n";

export function addPublishSetOps(p: Project, id: string): CoreOp[] {
  const set: PublishSet = { id, name: t("publish.defaultName"), layoutIds: (p.layouts ?? []).map((l) => l.id) };
  return fieldOps(p, "publishSets", [...(p.publishSets ?? []), set]);
}

export function patchPublishSetOps(p: Project, id: string, patch: Partial<Omit<PublishSet, "id">>): CoreOp[] {
  return fieldOps(p, "publishSets", (p.publishSets ?? []).map((s) => (s.id === id ? { ...s, ...patch } : s)));
}

export function deletePublishSetOps(p: Project, id: string): CoreOp[] {
  return fieldOps(p, "publishSets", (p.publishSets ?? []).filter((s) => s.id !== id));
}

/** Führt einen Satz aus; liefert die Ops (Index + Protokoll), wenn gespeichert wurde, sonst `null`. */
export async function publishSet(project: Project, setId: string): Promise<CoreOp[] | null> {
  const set = (project.publishSets ?? []).find((s) => s.id === setId);
  if (!set) return null;
  const now = new Date();
  const plan = planPublish(project, set, now.toISOString().slice(0, 10));
  if (plan.files.length === 0) {
    getState().notify(t("publish.empty"), "error");
    return null;
  }
  try {
    const files = await runPublish(project, set, plan);
    const bundle = await bundlePublished(files, `${set.name}.zip`);
    if (!bundle) return null;
    const saved = await saveBinaryFile(bundle.bytes, bundle.fileName, bundle.mime);
    if (!saved) return null;
    getState().notify(`${t("publish.done")}: ${files.length}`, "info");
    return publishOps(project, set, plan, now.toISOString(), `pub-${now.getTime()}`);
  } catch (err) {
    getState().notify(`${t("publish.failed")}: ${err instanceof Error ? err.message : String(err)}`, "error");
    return null;
  }
}

// [66] Präsentationsplan anlegen: Ops aus dem Kern-Fassadenteil (`plan/presentationSheet.ts`), angewendet
// als EIN Undo-Schritt, Meldung über `notify`. Liefert die Id des neuen Blatts (zum Öffnen) oder `null`.

import { presentationSheetOps, type PresentationOptions } from "../core";
import { t } from "../i18n";
import { getState } from "./appStore";

export function createPresentationSheet(o: PresentationOptions): string | null {
  const st = getState();
  try {
    const format = `${o.paper.toUpperCase()} ${o.orientation === "landscape" ? t("layouts.landscape") : t("layouts.portrait")}`;
    const res = presentationSheetOps(
      st.project,
      o,
      { sheetName: t("presentation.sheetName"), masterName: t("presentation.masterName", { format }), north: t("presentation.north") },
      String(Date.now()),
    );
    if (!res) {
      st.notify(t("presentation.empty"), "warning");
      return null;
    }
    st.applyChange(res.ops);
    if (res.plan.fits) st.notify(t("presentation.done", { scale: res.plan.scale, n: res.plan.items.length }), "info");
    else st.notify(t("presentation.tooBig", { scale: res.plan.scale }), "warning");
    return res.layoutId;
  } catch (e) {
    st.notify(`${t("presentation.failed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
    return null;
  }
}

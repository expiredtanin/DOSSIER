// [66] Präsentationsplan anlegen: Ops aus dem Kern-Fassadenteil (`plan/presentationSheet.ts`), angewendet
// als EIN Undo-Schritt, Meldung über `notify`. Liefert die Id des neuen Blatts (zum Öffnen) oder `null`.

import { finerPresentationScale, fittingPresentationScale, presentationSheetOps, type PresentationOptions } from "../core";
import { t } from "../i18n";
import { getState } from "./appStore";

export function createPresentationSheet(o: PresentationOptions): string | null {
  const st = getState();
  try {
    const format = `${o.paper.toUpperCase()} ${o.orientation === "landscape" ? t("layouts.landscape") : t("layouts.portrait")}`;
    const res = presentationSheetOps(
      st.project,
      o,
      { sheetName: t("presentation.sheetName"), masterName: t("presentation.masterName", { format }), north: t("presentation.north"), northGroup: t("presentation.northGroup"), scaleBarGroup: t("presentation.scaleBarGroup"), situation: t("presentation.situation"), tableAreas: t("presentation.table.areas"), tableSiteProof: t("presentation.table.siteProof"), tableUnits: t("presentation.table.units"), imagePlaceholder: t("presentation.image.placeholder"), imageHint: t("presentation.image.hint"), axo: t("presentation.axo") },
      String(Date.now()),
    );
    if (!res) {
      st.notify(t("presentation.empty"), "warning");
      return null;
    }
    // [282] Passt nichts aufs Blatt: kein überlaufendes Blatt anlegen, sondern den grössten passenden Massstab vorschlagen.
    if (!res.plan.fits) {
      const fit = fittingPresentationScale(st.project, o);
      st.notify(fit ? t("presentation.tooBigSuggest", { scale: res.plan.scale, fit }) : t("presentation.tooBig", { scale: res.plan.scale }), "warning");
      return null;
    }
    // [208] Kleines Haus: ein feinerer Massstab füllt das Blatt besser (nur Hinweis, das Blatt entsteht wie gewählt).
    const finer = finerPresentationScale(st.project, o);
    st.applyChange(res.ops);
    const pages = res.plan.pages ?? 1;
    if (pages > 1) st.notify(t("presentation.donePages", { scale: res.plan.scale, pages }), "info");
    else st.notify(t("presentation.done", { scale: res.plan.scale, n: res.plan.items.length }), "info");
    if (finer) st.notify(t("presentation.finerHint", { scale: res.plan.scale, finer }), "info");
    return res.layoutId;
  } catch (e) {
    st.notify(`${t("presentation.failed")}: ${e instanceof Error ? e.message : String(e)}`, "error");
    return null;
  }
}

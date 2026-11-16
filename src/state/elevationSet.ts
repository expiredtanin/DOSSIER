// [267] Menü Ansicht → „Ansichten aller Seiten erzeugen“: dieselbe Rechnung wie der Befehl `ansichten`
// (`commands/elevationSetFor.ts`), angewendet als ein Undo-Schritt, Meldung über `notify`.

import { elevationSetFor } from "../commands/elevationSetFor";
import { t } from "../i18n";
import { getState } from "./appStore";

/** Menü: Ansichten anlegen (ein Undo-Schritt) und melden. */
export function createElevationSet(): void {
  const st = getState();
  const res = elevationSetFor(st.project);
  const commit = res.commit;
  if (commit) st.applyChange((p) => commit.toOps(p));
  st.notify(t(res.notice.key, res.notice.params), res.notice.kind);
}

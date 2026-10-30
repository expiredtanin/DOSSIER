// Kollisionen ([T8]): Liste der Treffer der letzten Prüfung. Klick wählt beide beteiligten Bauteile
// (Auswahl-Umriss im 3D) und fährt die 3D-Kamera auf die Durchdringung; im 3D sind alle Treffer als
// rote Hüllquader markiert (`clashHighlightLines`, `views/viewportContent.tsx`).

import { t } from "../i18n";
import { getState } from "../state/appStore";
import { clashSelection, type Clash } from "../analysis/clash";
import { focusCamera, viewportAvailable } from "../viewport/cameraBridge";
import { runClashAndStore, setClashSession, useClashSession } from "./clashSession";

/** Klick auf einen Treffer: Bauteile wählen, Kamera auf die Durchdringung. */
export function focusClash(c: Clash, index: number): void {
  const s = getState();
  const sel = clashSelection(c);
  s.clearSelection();
  s.setSelectedWallIds(sel.wallIds);
  s.setSelectedCeilingIds(sel.ceilingIds);
  s.setSelectedExtrudedSolidIds(sel.extrudedSolidIds);
  s.setSelectedContextObjectIds(sel.contextObjectIds);
  setClashSession({ selected: index });
  const radius = Math.hypot(c.max[0] - c.min[0], c.max[1] - c.min[1], c.max[2] - c.min[2]) / 2;
  if (viewportAvailable()) focusCamera(c.center, radius);
}

const itemText = (it: Clash["a"]) => `${t(`clash.kind.${it.kind}`)} ${it.id}`;

export function ClashPanel() {
  const session = useClashSession();
  return (
    <div className="bcf-panel">
      <div className="bcf-bar">
        <button type="button" className="bcf-btn" disabled={session.running} onClick={() => void runClashAndStore()}>
          {session.running ? t("clash.running") : t("clash.run")}
        </button>
        <button
          type="button"
          className="bcf-btn"
          disabled={session.clashes.length === 0}
          onClick={() => setClashSession({ clashes: [], selected: null })}
        >
          {t("clash.clear")}
        </button>
      </div>
      {session.clashes.length === 0 && <div className="bcf-empty">{t("clash.empty")}</div>}
      <ul className="bcf-list">
        {session.clashes.map((c, k) => (
          <li key={`${c.a.id}|${c.b.id}`}>
            <button type="button" className={`bcf-topic${k === session.selected ? " is-active" : ""}`} onClick={() => focusClash(c, k)}>
              <span className="bcf-status">{`K${k + 1}`}</span>
              <span className="bcf-topic-title">{`${itemText(c.a)} ↔ ${itemText(c.b)}`}</span>
              {c.volume !== null && <span className="bcf-count">{`${c.volume.toFixed(3)} m³`}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

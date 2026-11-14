// Anonymitäts-Prüfung vor dem Export ([208]): listet identifizierende Angaben im Freitext des Projekts
// (wo, welcher Text, welcher Begriff) und fragt „Trotzdem exportieren" / „Abbrechen". Overlay wie
// `LockConflictDialog` (kein window.confirm: im Tauri-WKWebView stumm). Zustand und Prüfung: `state/anonymityGate.ts`.

import { memo, useEffect, useSyncExternalStore } from "react";
import { t } from "../i18n";
import { getAnonymityRequest, subscribeAnonymityRequest } from "../state/anonymityGate";
import { useModalFocus } from "./modalFocus";

const AREA_KEYS = new Set([
  "rooms", "drawingLevels", "layers", "groups", "blockDefs", "layouts", "masterLayouts", "drawings2d", "walls", "openings",
  "stairs", "columns", "context", "extrudedSolids", "viewSnapshots", "viewSnapshotFolders", "viewTemplates", "layoutFolders",
  "publishSets", "roomProgram", "export", "cameras", "components", "wallTypes", "textStyles", "ceilings", "roofs", "trees",
  "hatches", "lineStyles",
]);

function areaLabel(area: string): string {
  return AREA_KEYS.has(area) ? t(`anonymity.area.${area}`) : area;
}

const DialogBody = memo(function DialogBody() {
  const request = useSyncExternalStore(subscribeAnonymityRequest, getAnonymityRequest);
  const dialogRef = useModalFocus({});
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") request.resolve(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [request]);
  if (!request) return null;
  const { findings } = request;
  return (
    <div className="imp-overlay" onClick={() => request.resolve(false)}>
      <div className="imp-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-label={t("anonymity.title")} data-testid="anonymity-dialog" onClick={(e) => e.stopPropagation()}>
        <header className="imp-head">
          <span className="imp-head-title">{t("anonymity.title")}</span>
          <button className="imp-close" onClick={() => request.resolve(false)} aria-label={t("export.close")}>
            ×
          </button>
        </header>
        <div className="imp-body">
          <section className="imp-section">
            <div className="imp-section-title">{t("anonymity.message", { count: String(findings.length) })}</div>
            <ul data-testid="anonymity-findings" style={{ margin: "6px 0 0", paddingLeft: 18, maxHeight: 280, overflow: "auto", fontSize: 12 }}>
              {findings.map((f, i) => (
                <li key={i} data-kind={f.kind} style={{ marginBottom: 4 }}>
                  <b>{areaLabel(f.area)}</b>
                  {f.place ? <span style={{ color: "var(--muted)" }}> · {f.place}</span> : null}
                  <div>
                    „{f.text}" — {t(`anonymity.kind.${f.kind}`)}: <span className="mono">{f.term}</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <footer className="imp-foot">
          <button className="imp-btn primary" data-testid="anonymity-cancel" onClick={() => request.resolve(false)}>
            {t("export.cancel")}
          </button>
          <button className="imp-btn danger" data-testid="anonymity-proceed" onClick={() => request.resolve(true)}>
            {t("anonymity.proceed")}
          </button>
        </footer>
      </div>
    </div>
  );
});

export function AnonymityDialogHost() {
  return <DialogBody />;
}

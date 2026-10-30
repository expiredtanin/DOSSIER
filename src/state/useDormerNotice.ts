// Hinweis (Toast), sobald eine Gaube durch Anlegen oder Ändern am First gekappt wird ([G5]). Beim Öffnen
// eines Projekts nur merken, nicht melden (der Befund steht in der Objekt-Info des Dachs).

import { useEffect, useRef } from "react";
import type { Project } from "../model/types";
import { affectedKeys, dormerStatus, newlyAffected } from "../analysis/dormerStatus";
import type { DormerStatus } from "../analysis/dormerStatus";
import { t } from "../i18n";

export function useDormerNotice(project: Project, notify: (msg: string, kind?: "info" | "warning" | "error") => void) {
  const seen = useRef<{ id: string; keys: Set<string> } | null>(null);
  useEffect(() => {
    let status: DormerStatus[];
    try {
      status = dormerStatus(project);
    } catch {
      return;
    }
    const prev = seen.current;
    seen.current = { id: project.id, keys: affectedKeys(status) };
    if (!prev || prev.id !== project.id) return;
    for (const s of newlyAffected(prev.keys, status)) {
      notify(s.invalid ? t("dormer.invalid.toast") : t("dormer.clamped.toast", { height: s.effectiveHeight.toFixed(2) }), "warning");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.roofs, project.id, notify]);
}

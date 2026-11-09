// Hinweis (Toast), sobald eine Gaube durch Anlegen oder Ändern am First gekappt wird ([G5]). Beim Öffnen
// eines Projekts nur merken, nicht melden (der Befund steht in der Objekt-Info des Dachs). Abonniert nur
// Dächer und Projekt-Id ([121]); das ganze Projekt liest der Effekt aus dem Store.

import { useEffect, useRef } from "react";
import { affectedKeys, dormerStatus, newlyAffected } from "../analysis/dormerStatus";
import type { DormerStatus } from "../analysis/dormerStatus";
import { t } from "../i18n";
import { getState, useStore } from "./appStore";

export function useDormerNotice(notify: (msg: string, kind?: "info" | "warning" | "error") => void) {
  const roofs = useStore((s) => s.project.roofs);
  const projectId = useStore((s) => s.project.id);
  const seen = useRef<{ id: string; keys: Set<string> } | null>(null);
  useEffect(() => {
    let status: DormerStatus[];
    try {
      status = dormerStatus(getState().project);
    } catch {
      return;
    }
    const prev = seen.current;
    seen.current = { id: projectId, keys: affectedKeys(status) };
    if (!prev || prev.id !== projectId) return;
    for (const s of newlyAffected(prev.keys, status)) {
      notify(s.invalid ? t("dormer.invalid.toast") : t("dormer.clamped.toast", { height: s.effectiveHeight.toFixed(2) }), "warning");
    }
  }, [roofs, projectId, notify]);
}

// [272] Bearbeitungsvariante der Bildschirm-Ansichten (Stift im Panel „Varianten“ + Häkchen „grau einfärben“) als
// Anfrage-Feld `designOptionEdit` für Grundriss, Schnitt, Ansicht und 3D. Nur hier gelesen — Druck, PDF und Exporte
// bekommen es nie, darum bleibt das Grau auf dem Bildschirm (Kern `renovation::View::editing`).
// Bezeichner englisch, Kommentare deutsch.

import { useMemo } from "react";
import { designOptionEditArg } from "../core";
import type { DesignOptionEditArg } from "../core";
import type { Project } from "../model/types";
import { useStore } from "./appStore";

/** Bearbeitungsvariante der Sitzung für Bildschirm-Anfragen; `null` ohne Stift (stabile Referenz für Memos). */
export function useDesignOptionEdit(project: Project): DesignOptionEditArg | null {
  const draw = useStore((s) => s.drawDesignOption);
  const grey = useStore((s) => s.designOptionGrey);
  const sets = project.designOptionSets;
  return useMemo(() => designOptionEditArg(project, draw, grey), [sets, draw, grey]);
}

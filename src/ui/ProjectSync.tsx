// Projekt-Abgleiche ohne eigene Anzeige ([121]): was auf Modelländerungen reagieren muss, aber nichts
// zeichnet, abonniert hier statt in `App` — so rendert eine Op nicht die ganze App. Gerendert von
// `App.tsx` (vor Start- und Editor-Ansicht, gleiche Stelle im Baum), zeichnet nichts.
//
// - Gauben-Hinweis (`useDormerNotice`, abonniert nur Dächer und Projekt-Id),
// - natives Ressourcen-Fenster (`useResourceWindowHost`): braucht das ganze Projekt, aber nur unter
//   Tauri — im Browser wird das Projekt nicht abonniert (die Brücke ist dort ohnehin ein No-op).

import { useStore } from "../state/appStore";
import { useDormerNotice } from "../state/useDormerNotice";
import { isTauriRuntime } from "../native/projectFile";
import { useResourceWindowHost } from "../native/resourceWindow";
import type { ResourceManagerHandlers } from "./ResourceManager";

export function ProjectSync(props: {
  notify: (msg: string, kind?: "info" | "warning" | "error") => void;
  resourceHandlers: ResourceManagerHandlers;
}) {
  useDormerNotice(props.notify);
  const project = useStore((s) => (isTauriRuntime() ? s.project : null));
  useResourceWindowHost(project, props.resourceHandlers);
  return null;
}

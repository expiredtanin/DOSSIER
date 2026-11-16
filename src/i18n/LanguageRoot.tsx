// [264] Wurzel für den Sprachwechsel: ändert sich die Sprache, wird der Baum darunter neu aufgebaut. Viele
// Komponenten sind `memo` und lesen `t()` direkt (ohne `useT`); ohne Neuaufbau blieben Menüleiste und Panels
// in der alten Sprache. Zustand (Projekt, Auswahl, Verlauf, Layout) liegt ausserhalb von React und bleibt.

import { Fragment, type ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { getLanguage, subscribeLanguage } from "./translate";

export function LanguageRoot({ children }: { children: ReactNode }) {
  const lang = useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  return <Fragment key={lang}>{children}</Fragment>;
}

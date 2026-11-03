// i18n-Fassade: React-freier Kern in ./translate (für Kern-Module), dazu der React-Hook `useT`.

import { useSyncExternalStore } from "react";
import { getLanguage, subscribeLanguage, t } from "./translate";

export * from "./translate";

/**
 * Hook-Variante: liefert dieselbe `t`-Funktion, abonniert aber den
 * Sprachzustand, sodass die Komponente beim Sprachwechsel neu rendert.
 */
export function useT(): typeof t {
  useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
  return t;
}

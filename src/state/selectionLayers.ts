// Ebenen (Kategorien) der aktuellen Auswahl: ausblenden bzw. isolieren ("nur diese Ebene(n) zeigen").
// Die Rechnung liegt im Rust-Kern ([K4] S3, `core/src/layers.rs`, Fassade `model/layers.ts`); dieses Modul
// bleibt als Einstieg für die UI. Der Aufrufer (App) legt die Ergebnisse über `applyChange`, also EIN Undo-Schritt.

export {
  categoryNames,
  isolateCategories,
  selectionCategoryCodes,
  setCategoriesVisible,
  type SelectionMembers,
} from "../model/layers";

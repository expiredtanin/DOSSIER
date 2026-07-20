// Hell/Dunkel-Umschalter (Einstellungen → Darstellung). Hell ist Standard
// (siehe styles.css); Dunkel wird per `data-theme="dark"` auf <html> opt-in
// gesetzt und in localStorage persistiert, damit die Wahl einen Neustart
// übersteht. `applyThemeMode` wird SYNCHRON vor dem ersten Render aufgerufen
// (main.tsx), damit es keinen Hell/Dunkel-Flackerer beim Laden gibt.

export type ThemeMode = "light" | "dark";

const THEME_STORAGE_KEY = "cad.themeMode";

export function getStoredThemeMode(): ThemeMode {
  if (typeof window === "undefined") return "light";
  return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
}

export function applyThemeMode(mode: ThemeMode): void {
  if (mode === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

export function setStoredThemeMode(mode: ThemeMode): void {
  window.localStorage.setItem(THEME_STORAGE_KEY, mode);
  applyThemeMode(mode);
}

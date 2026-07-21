// React-State-Wrapper um den Hell/Dunkel-Umschalter (Einstellungen →
// Darstellung). Standard Hell (styles.css); Dunkel ist Opt-in und
// persistiert in localStorage (themeMode.ts).
//
// Extrahiert aus App.tsx. Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

import { useState } from "react";
import { getStoredThemeMode, setStoredThemeMode } from "./themeMode";
import type { ThemeMode } from "./themeMode";

export function useThemeModeState() {
  const [themeMode, setThemeModeState] = useState<ThemeMode>(() => getStoredThemeMode());
  const setThemeMode = (mode: ThemeMode) => {
    setThemeModeState(mode);
    setStoredThemeMode(mode);
  };
  return { themeMode, setThemeMode };
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ResourceWindowApp } from "./native/ResourceWindowApp";
import { SettingsWindowApp } from "./native/SettingsWindowApp";
import { DrawingLevelsWindowApp } from "./native/DrawingLevelsWindowApp";
import { LayerSettingsWindowApp } from "./native/LayerSettingsWindowApp";
import { ContextImportWindowApp } from "./native/ContextImportWindowApp";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { getLanguage, setLanguage } from "./i18n";
import type { Language } from "./i18n";
import { applyThemeMode, getStoredThemeMode } from "./theme/themeMode";
import "./styles.css";
import "./text/fonts.css";

// Hell/Dunkel VOR dem ersten Render setzen (jedes native Fenster ist ein
// eigenes Dokument und mountet über dieselbe main.tsx) — verhindert einen
// Hell/Dunkel-Flackerer beim Laden.
applyThemeMode(getStoredThemeMode());

/** Eigenes natives Nebenfenster statt der Haupt-App? Steuert per URL-Query,
 * welcher Root gemountet wird (siehe native/resourceWindow.ts bzw.
 * native/settingsWindow.ts, die die URL so setzen). `?window=resources`/
 * `?window=settings` → nur der jeweilige Manager/Dialog, ohne den ganzen
 * App-Baum (eigener Prozesskontext, kein gemeinsamer Store). */
const windowKind = new URLSearchParams(window.location.search).get("window");

// Sprach-Naht für Werkzeuge/Tests (und einen späteren Umschalter): die i18n-
// Steuerung am window verfügbar machen. Identifier englisch; Werte übersetzbar.
declare global {
  interface Window {
    __i18n: { getLanguage: () => Language; setLanguage: (lang: Language) => void };
  }
}
window.__i18n = { getLanguage, setLanguage };

// ── Native-App-Verhalten (kein Browser-Standard) ─────────────────────────────
// Die App soll sich wie ein natives Programm anfühlen. Diese globalen Hooks
// laufen einmal beim Start (außerhalb von React, am document) — sie greifen
// app-weit und stören die eigenen React-Handler (z. B. unser ContextMenu) nicht.

/** Prüft, ob ein Element eine echte Texteingabe ist (Input/Textarea/CE). */
const isTextEntry = (el: EventTarget | null): boolean => {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    el.isContentEditable
  );
};

// 1) Browser-Kontextmenü global unterdrücken. Unser eigenes ContextMenu wird
//    über React-onContextMenu-Handler geöffnet (die preventDefault separat
//    aufrufen); auf Flächen ohne eigenes Menü passiert hier nur das Verhindern
//    des Browser-Menüs — sonst nichts.
document.addEventListener("contextmenu", (e) => e.preventDefault());

// 2) Ctrl/Cmd+A („Alles markieren") außerhalb echter Eingaben unterbinden.
//    In Eingaben bleibt es das normale Markieren des Feldinhalts.
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
    if (!isTextEntry(document.activeElement)) e.preventDefault();
  }
});

// 3) Browser-Drag-Gesten unterbinden (Bild-/Element-Drag, Text-Drag). Echte
//    Eingaben bleiben unberührt, damit Auswahl-Drag im Feld weiter funktioniert.
document.addEventListener("dragstart", (e) => {
  if (!isTextEntry(e.target)) e.preventDefault();
});

function RootByWindowKind() {
  if (windowKind === "resources") return <ResourceWindowApp />;
  if (windowKind === "settings") return <SettingsWindowApp />;
  if (windowKind === "drawing-levels") return <DrawingLevelsWindowApp />;
  if (windowKind === "layer-settings") return <LayerSettingsWindowApp />;
  if (windowKind === "context-import") return <ContextImportWindowApp />;
  return <App />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <RootByWindowKind />
    </ErrorBoundary>
  </StrictMode>,
);

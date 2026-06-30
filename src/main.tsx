import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { getLanguage, setLanguage } from "./i18n";
import type { Language } from "./i18n";
import "./styles.css";

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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);

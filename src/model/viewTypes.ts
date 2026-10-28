// Ansichts-Typen (Geschoss-Ansicht, Detailgrad, 3D-Render-Modus, 3D-Blickwinkel). Gehören zum
// Modell/Kern, nicht zur Top-Bar — Kern und Hülle importieren sie von hier.

// ViewType, DetailLevel und View3d sind Teil des gespeicherten Projekts (Ausschnitte) und kommen aus
// dem Rust-Modell ([K4] S4, `types.generated.ts`).
export type { DetailLevel, View3d, ViewType } from "./types.generated";

/**
 * Render-/Anzeigemodus der 3D-Ansicht: schattiert, einheitlich weiss (Clay-Look),
 * texturiert (echte PBR-Materialien je Bauteil), Drahtgitter, Verdeckte Kanten
 * (Hidden-Line), Schattiert mit Kanten (typischer BIM-Look: Bauteilfarben +
 * Modell-Kanten obenauf). Wirkt nur in der Perspektive. Der Slot „section"
 * (Schnittschraffur, Welle B) ist bewusst freigelassen.
 */
export type RenderMode =
  | "shaded"
  | "white"
  | "contour"
  | "textured"
  | "wireframe"
  | "hidden"
  | "shaded-edges";


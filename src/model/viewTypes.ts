// Ansichts-Typen (Geschoss-Ansicht, Detailgrad, 3D-Render-Modus, 3D-Blickwinkel). Gehören zum
// Modell/Kern, nicht zur Top-Bar — Kern und Hülle importieren sie von hier.

/** Ansichtstyp eines Geschosses (wie in App). */
export type ViewType = "grundriss" | "perspektive";

/**
 * Detailgrad der Darstellung (≙ DOSSIER Einfach/Standard/Detail). Wirkt im
 * Grundriss auf Tür-/Fenstersymbole + Schraffuren/Linienfeinheit (siehe
 * generatePlan.DetailLevel); in der Perspektive noch ohne Wirkung (deferred).
 */
export type DetailLevel = "grob" | "mittel" | "fein";

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

/**
 * Kanonischer Blickwinkel der 3D-Ansicht (Vectorworks/DOSSIER-Stil). „front"/
 * „back"/„side"/„left" springen auf die vier Kardinalrichtungen (Vorne/Hinten/
 * Rechts/Links — KEINE Himmelsrichtungs-Labels, da es noch keinen Nordwinkel
 * gibt); „top" auf die Draufsicht. „iso"/„isoFrontLeft"/„isoBackRight"/
 * „isoBackLeft" sind die vier oberen Iso-Oktanten (untere vier bleiben im
 * Hochbau ungenutzt) — „iso" (vorne-oben-rechts) ist der bestehende Default.
 * „perspective" ist der freie 3/4-Blick. Wirkt nur in der Perspektive.
 */
export type View3d =
  | "front"
  | "back"
  | "side"
  | "left"
  | "top"
  | "iso"
  | "isoFrontLeft"
  | "isoBackRight"
  | "isoBackLeft"
  | "perspective";

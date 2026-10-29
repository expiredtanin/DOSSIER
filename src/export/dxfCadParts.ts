// Baustein des Fachplaner-Exports ([C2], 28.10.): Schriftname aus CSS-Familie (Text-Layout bleibt TS).
// Linientypen, blocklokale Primitive, Papierformate und der Sammler selbst liegen seit [K3d] im Kern
// (`src-tauri/core/src/plan_dxf.rs`).

/** Erste Schriftfamilie aus einem CSS-`font-family`-Wert ohne Anführungszeichen; generische Familien/CSS-Variablen → null. */
export function fontNameOf(css: string | undefined | null): string | null {
  if (!css) return null;
  // `var(--font-ui, sans-serif)` enthält selbst ein Komma: vor dem Teilen entfernen.
  for (const raw of css.replace(/var\([^)]*\)/g, "").split(",")) {
    const name = raw.trim().replace(/^["']|["']$/g, "").trim();
    if (!name) continue;
    if (/^(sans-serif|serif|monospace|cursive|fantasy|system-ui|ui-sans-serif|inherit|initial)$/i.test(name)) continue;
    return name;
  }
  return null;
}

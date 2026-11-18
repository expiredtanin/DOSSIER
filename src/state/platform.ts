// [289] Plattform und Primär-Modifikator an EINER Stelle: Mac = Cmd (metaKey), sonst (Linux/Windows, Browser) = Strg (ctrlKey).
// Alle Tastenkürzel prüfen darüber, nie `ctrlKey || metaKey` (Super/Windows-Taste unter Linux löst sonst Kürzel aus,
// Ctrl+Klick unter macOS ist das Kontextmenü und kein Kürzel).

/** macOS/iOS-Plattform? */
export function isMacPlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
}

/** Plattformname für `data-platform` am Wurzelelement (CSS: Scrollbalken, Schrift, Titelleiste). */
export function platformName(): "mac" | "linux" | "windows" | "other" {
  if (typeof navigator === "undefined") return "other";
  const s = `${navigator.platform || ""} ${navigator.userAgent || ""}`;
  if (/Mac|iPhone|iPad|iPod/.test(s)) return "mac";
  if (/Win/.test(s)) return "windows";
  if (/Linux|X11|CrOS/.test(s)) return "linux";
  return "other";
}

/** Ist der Primär-Modifikator gedrückt? Mac: Cmd; sonst Strg. (`mac` überschreibt die Erkennung, für Tests.) */
export function isPrimaryMod(e: { ctrlKey: boolean; metaKey: boolean }, mac: boolean = isMacPlatform()): boolean {
  return mac ? e.metaKey : e.ctrlKey;
}

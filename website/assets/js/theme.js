// Gewähltes Farbschema vor dem ersten Bild setzen (eigene Datei statt Inline-Skript, CSP-tauglich).
try {
  const t = localStorage.getItem("dossier-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {
  /* ohne Speicher: Systemvorgabe */
}

// Gemeinsam für Startseite und Doku: Farbschema-Schalter, Animationen in verborgenen Tabs anhalten.
export function initCommon() {
  const root = document.documentElement;
  const dark = () => root.dataset.theme === "dark" || (root.dataset.theme !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
  for (const b of document.querySelectorAll(".theme-toggle")) {
    const sync = () => b.setAttribute("aria-pressed", String(dark()));
    sync();
    b.addEventListener("click", () => {
      const next = dark() ? "light" : "dark";
      root.dataset.theme = next;
      try {
        localStorage.setItem("dossier-theme", next);
      } catch {
        /* ohne Speicher gilt die Wahl nur für diese Seite */
      }
      sync();
    });
  }
  document.addEventListener("visibilitychange", () => document.body.classList.toggle("paused", document.hidden));
}

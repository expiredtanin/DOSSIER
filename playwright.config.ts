// Playwright-Konfiguration für die UI-Suite in `e2e/` ([49]). Bedient die gebaute Web-App wie ein
// Mensch (Browser-Modus, nicht Tauri). `npm run e2e` baut nach `dist-test` und startet
// `vite preview` auf Port 5199; nicht Teil von `npm run check` (zu langsam), aber eigener CI-Job.
import { existsSync } from "node:fs";
import { chromium, defineConfig } from "@playwright/test";

// Eigener Port je Worktree möglich (mehrere Agents gleichzeitig): E2E_PORT=…
const PORT = Number(process.env.E2E_PORT ?? 5199);

/**
 * Chromium: normalerweise das von `playwright install` gelieferte. In Cloud-Containern liegt eine
 * andere Revision unter /opt/pw-browsers/chromium (kein `playwright install` möglich) — dann diese.
 * Übersteuerbar mit DOSSIER_CHROMIUM=/pfad/zu/chrome.
 */
function chromiumPath(): string | undefined {
  const fromEnv = process.env.DOSSIER_CHROMIUM;
  if (fromEnv) return fromEnv;
  try {
    if (existsSync(chromium.executablePath())) return undefined;
  } catch {
    /* kein Standard-Browser installiert */
  }
  const fallback = "/opt/pw-browsers/chromium";
  return existsSync(fallback) ? fallback : undefined;
}

export default defineConfig({
  testDir: "e2e",
  outputDir: "test-results",
  globalSetup: "./e2e/globalSetup.ts",
  // Ein Test < 30 s, die ganze Suite < 3 min.
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    locale: "de-CH",
    viewport: { width: 1600, height: 1200 },
    acceptDownloads: true,
    // Bei Fehlern: Screenshot + Trace als Artefakt (test-results/, in der CI hochgeladen).
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    launchOptions: { executablePath: chromiumPath(), args: ["--enable-unsafe-webgpu"] },
  },
  webServer: {
    command: `npx vite build --outDir dist-test && npx vite preview --outDir dist-test --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 240_000,
  },
});

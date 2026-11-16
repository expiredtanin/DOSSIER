// [170] Playwright-Konfiguration für die Linux-App (gepacktes Electron, `e2e/linuxApp170.spec.ts`): kein Web-Server,
// kein Browser — der Test startet das Paket aus `DOSSIER_ELECTRON_BIN` selbst. Aufruf über `npm run test:linux-app`.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  testMatch: /linuxApp\d*\.spec\.ts$/,
  outputDir: "test-results/linux-app",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: "list",
});

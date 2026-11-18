// Gemeinsame Bausteine der UI-Suite ([49]): `test` mit Konsolen-Wächter und Bedien-Helfer.
// Geprüft wird über sichtbare UI (Text, Panel-Werte, Elemente-Baum) — nie über Pixel: Die
// WebGPU-Engines zeichnen headless nichts Verlässliches.
import { appendFileSync } from "node:fs";
import { expect, test as base, type Page } from "@playwright/test";

/**
 * Konsolenfehler, die NUR headless (Linux/SwiftShader, kein echtes WebGPU) auftreten und die
 * Bedienung nicht betreffen. Jeder Eintrag mit Begründung; alles andere lässt den Test scheitern.
 */
const ALLOWED_CONSOLE_ERRORS: { re: RegExp; why: string }[] = [
  {
    re: /createBuffer failed|wgpu-.*webgpu\.rs/,
    why: "render2d/render3d: SwiftShader verliert das WebGPU-Gerät beim Präsentieren, createBuffer(mappedAtCreation) wirft, wgpu paniert (nur headless). render2d baut dann neu auf bzw. fällt auf SVG zurück (planEngine.spec.ts). [206] Seit 14.11. prüfen beide Renderer den Verlust vorher (0 Vorkommen in der ganzen Suite); bleibt erlaubt für den Wettlauf „Gerät schon tot, `device.lost` noch nicht gemeldet“ (die Hülle `guardRenderer` baut dann neu auf). Geprüft in gpuDeviceLost206.spec.ts.",
  },
  {
    re: /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/' failed/,
    why: "[9] KI-Zugriff: die App sucht die MCP-Brücke alle 2 s auf 127.0.0.1, bis sie läuft; Chromium meldet jeden Fehlversuch (aiBridge.spec.ts).",
  },
];

/**
 * [206] Warnungen, die wie Fehler zählen: React-Entwicklungswarnungen (nur gegen `vite dev` sichtbar, nicht im
 * Produktions-Build der Standard-Suite) und veraltete APIs. Alle übrigen Warnungen ändern den Ausgang nicht;
 * mit `E2E_WARN_LOG=<datei>` landen sie (eine JSON-Zeile je Meldung) zur Auswertung in einer Datei.
 */
const FATAL_WARNINGS = /Each child in a list should have a unique "key"|Cannot update a component|Cannot update during an existing state transition|not wrapped in act\(|Warning: |is deprecated|findDOMNode|Maximum update depth/;

export const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      const take = (text: string) => {
        if (!ALLOWED_CONSOLE_ERRORS.some((a) => a.re.test(text))) errors.push(text.slice(0, 400));
      };
      page.on("console", (m) => {
        // Mit E2E_WARN_LOG auch Fehler (z. B. erlaubte wgpu-Panics) mitschreiben, Feld `type`.
        if ((m.type() === "warning" || m.type() === "error") && process.env.E2E_WARN_LOG)
          appendFileSync(process.env.E2E_WARN_LOG, JSON.stringify({ test: base.info().title, type: m.type(), text: m.text().slice(0, 600) }) + "\n");
        if (m.type() === "error") take(m.text());
        else if (m.type() === "warning" && FATAL_WARNINGS.test(m.text())) take(`Warnung: ${m.text()}`);
      });
      page.on("pageerror", (e) => {
        if (process.env.E2E_WARN_LOG)
          appendFileSync(process.env.E2E_WARN_LOG, JSON.stringify({ test: base.info().title, type: "pageerror", text: e.message.slice(0, 600) }) + "\n");
        take(`pageerror: ${e.message}`);
      });
      await use(errors);
      // Nach dem Test: kein unerwarteter Fehler in der Konsole.
      expect(errors, "unerwartete Konsolenfehler").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/** App öffnen und am Startbildschirm „Neues Projekt" wählen. */
export async function startNewProject(page: Page, query = ""): Promise<void> {
  await page.goto("/" + query);
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
}

/** Datei-Menü öffnen und einen Eintrag wählen. */
export async function fileMenu(page: Page, item: string | RegExp): Promise<void> {
  await page.getByRole("button", { name: "Datei", exact: true }).click();
  await page.getByRole("option", { name: item }).click();
}

/**
 * Ersetzt der Menüpunkt das Projekt, fragt die App bei „ungespeicherten Änderungen" nach
 * (auch direkt nach dem Startbildschirm — das leere Projekt gilt dort schon als geändert).
 * Mit `expectDialog` wird der Dialog erwartet, sonst nur bestätigt, falls er erscheint.
 */
export async function discardIfAsked(page: Page, expectDialog = false): Promise<void> {
  const btn = page.getByRole("button", { name: "Nicht speichern" });
  // Der Dialog öffnet mit dem Klick; für den „kein Dialog"-Fall genügt ein kurzes, begrenztes Warten.
  const asked = await btn.waitFor({ timeout: expectDialog ? 10_000 : 1500 }).then(
    () => true,
    () => false,
  );
  if (expectDialog) expect(asked, "Dialog „Ungespeicherte Änderungen“").toBe(true);
  if (asked) await btn.click();
}

/** Neu aus Vorlage: Musterhaus (Demo-Haus mit 9 Wänden im EG, 4 im OG) — der Beispielprojekt-Weg im UI. */
export async function openSample(page: Page): Promise<void> {
  await fileMenu(page, /^Neu aus Vorlage: Musterhaus$/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Demo-Haus");
}

/** Rechte Dock-Reiter wählen (Elemente, Objekt-Info, Zeichnungsebenen …). */
export async function openTab(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name, exact: true }).click();
}

/** [136] Panel „Ausschnitte" (Dock-Bereich mit diesem Reiter). */
export function snapshotPanel(page: Page) {
  return page.getByRole("complementary").filter({ has: page.getByRole("tab", { name: "Ausschnitte", exact: true }) });
}

/** [136] Zeile eines Ausschnitts im Panel „Ausschnitte" (öffnet das Panel). */
export async function snapshotRow(page: Page, name: string) {
  await openTab(page, "Ausschnitte");
  return snapshotPanel(page).locator(".nav-row").filter({ has: page.getByText(name, { exact: true }) }).first();
}

/** [136] Ausschnitt im AKTIVEN Zeichnungs-Reiter zeigen (Klick im Panel „Ausschnitte"). */
export async function showSnapshot(page: Page, name: string): Promise<void> {
  await (await snapshotRow(page, name)).click();
}

/** [136] Ausschnitt in einem NEUEN Zeichnungs-Reiter öffnen (Knopf „↗" im Panel). */
export async function openSnapshotInNewTab(page: Page, name: string): Promise<void> {
  await (await snapshotRow(page, name)).getByRole("button", { name: "In neuem Reiter öffnen" }).click();
}

/** [136] Zeichnungs-Reiterleiste über der Zeichenfläche und ein Reiter darin. */
export function drawingTabs(page: Page) {
  return page.getByRole("tablist", { name: "Zeichnungen" });
}
export function drawingTab(page: Page, name: string) {
  return drawingTabs(page).getByRole("tab", { name, exact: true });
}

/** Zeilen des Elemente-Baums (Reiter „Elemente"), z. B. `Aussenwand 34.5 cm W1`. */
export function elementRows(page: Page) {
  return page.locator(".nav-row");
}

/** Befehlszeile (Eingabefeld). */
export function commandInput(page: Page) {
  return page.locator(".cmdline-input");
}

/** Befehl tippen und mit Enter bestätigen. */
export async function typeCommand(page: Page, text: string): Promise<void> {
  const input = commandInput(page);
  await input.fill(text);
  await input.press("Enter");
}

/** Laufenden Zeichenzug mit leerem Enter beenden (Esc würde ihn verwerfen). */
export async function finishCommand(page: Page): Promise<void> {
  await commandInput(page).press("Enter");
  await expect(page.locator(".cmdline-prompt")).toHaveText("Befehl:");
}

/** Fokus aus Eingabefeldern nehmen, damit Tastenkürzel (Strg+Z …) nicht ins Textfeld gehen. */
export async function blurFocus(page: Page): Promise<void> {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
}

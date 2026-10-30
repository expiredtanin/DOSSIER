// Gemeinsame Bausteine der UI-Suite ([49]): `test` mit Konsolen-Wächter und Bedien-Helfer.
// Geprüft wird über sichtbare UI (Text, Panel-Werte, Elemente-Baum) — nie über Pixel: Die
// WebGPU-Engines zeichnen headless nichts Verlässliches.
import { expect, test as base, type Page } from "@playwright/test";

/**
 * Konsolenfehler, die NUR headless (Linux/SwiftShader, kein echtes WebGPU) auftreten und die
 * Bedienung nicht betreffen. Jeder Eintrag mit Begründung; alles andere lässt den Test scheitern.
 */
const ALLOWED_CONSOLE_ERRORS: { re: RegExp; why: string }[] = [
  {
    re: /createBuffer failed|wgpu-.*webgpu\.rs/,
    why: "render2d/render3d: SwiftShader verliert das WebGPU-Gerät beim Präsentieren, createBuffer(mappedAtCreation) wirft, wgpu paniert (nur headless). render2d baut dann neu auf bzw. fällt auf SVG zurück (planEngine.spec.ts).",
  },
  {
    re: /WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/' failed/,
    why: "[9] KI-Zugriff: die App sucht die MCP-Brücke alle 2 s auf 127.0.0.1, bis sie läuft; Chromium meldet jeden Fehlversuch (aiBridge.spec.ts).",
  },
];

export const test = base.extend<{ errors: string[] }>({
  errors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      const take = (text: string) => {
        if (!ALLOWED_CONSOLE_ERRORS.some((a) => a.re.test(text))) errors.push(text.slice(0, 400));
      };
      page.on("console", (m) => {
        if (m.type() === "error") take(m.text());
      });
      page.on("pageerror", (e) => take(`pageerror: ${e.message}`));
      await use(errors);
      // Nach dem Test: kein unerwarteter Fehler in der Konsole.
      expect(errors, "unerwartete Konsolenfehler").toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

/** App öffnen und am Startbildschirm „Neues Projekt" wählen. */
export async function startNewProject(page: Page): Promise<void> {
  await page.goto("/");
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

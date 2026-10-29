// [99] Esc/Enter in JEDEM Befehl gleich, egal wo der Fokus steht: Esc = ein Schritt zurück (ohne
// Schritt: Befehl endet), Esc-Esc schnell = ganzer Befehl abgebrochen, Enter = abschliessen.
// Geprüft für jeden registrierten interaktiven Befehl, mit Fokus im Befehlsfeld, auf der
// Zeichenfläche und nach einem Klick in ein Panel (Reiter-Knopf fokussiert).
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { blurFocus, commandInput, elementRows, expect, openTab, startNewProject, test, typeCommand } from "./app";

/** Befehlsnamen der Registratur (Schlüssel von `COMMANDS` in src/commands/registry.ts). */
function registeredCommands(): string[] {
  const src = readFileSync("src/commands/registry.ts", "utf8");
  const body = src.slice(src.indexOf("export const COMMANDS"), src.indexOf("};", src.indexOf("export const COMMANDS")));
  return [...body.matchAll(/^\s+(?:"([^"]+)"|(\w+)):\s*\w+,?$/gm)].map((m) => m[1] ?? m[2]);
}

type Focus = "input" | "canvas" | "panel";
const IDLE = "Befehl:";
const prompt = (page: Page) => page.locator(".cmdline-prompt");
const steps = async (page: Page) => Number(await page.locator(".cmdline").getAttribute("data-steps"));

async function canvasAt(page: Page, dx: number, dy: number) {
  const box = (await page.locator("canvas").first().boundingBox())!;
  return { x: box.x + dx, y: box.y + dy };
}

async function clickCanvas(page: Page, dx: number, dy: number) {
  const p = await canvasAt(page, dx, dy);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
}

/** Fokus wie ein Nutzer setzen: Befehlsfeld, nichts (nach Klick auf die Fläche) oder ein Panel-Knopf. */
async function setFocus(page: Page, focus: Focus) {
  if (focus === "input") await commandInput(page).focus();
  else if (focus === "canvas") await blurFocus(page);
  else await page.getByRole("tab", { name: "Elemente", exact: true }).focus();
}

/** Zurück in den Ruhezustand (zwischen den Befehlen). */
async function toIdle(page: Page) {
  for (let i = 0; i < 4 && (await prompt(page).textContent()) !== IDLE; i++) {
    await blurFocus(page);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
  }
  await expect(prompt(page)).toHaveText(IDLE);
}

/** Befehl starten; false, wenn er sofort fertig ist (Sofort-Befehl) oder hier nicht startet. */
async function start(page: Page, name: string): Promise<boolean> {
  await typeCommand(page, name);
  return (await prompt(page).textContent()) !== IDLE;
}

async function escEscEnter(page: Page, name: string, focus: Focus): Promise<string> {
  await toIdle(page);
  if (!(await start(page, name))) return "sofort";
  // Punkte setzen, je Schritt den Prompt merken (Index = Schritt-Tiefe).
  const prompts: string[] = [(await prompt(page).textContent())!];
  await clickCanvas(page, 200, 220);
  if ((await prompt(page).textContent()) === IDLE) return "nach 1 Punkt fertig";
  prompts[await steps(page)] = (await prompt(page).textContent())!;
  await clickCanvas(page, 380, 260);
  if ((await prompt(page).textContent()) === IDLE) return "nach 2 Punkten fertig";
  const depth = await steps(page);
  prompts[depth] = (await prompt(page).textContent())!;

  // Esc einmal: genau ein Schritt zurück (ohne Schritt: Befehl endet).
  await setFocus(page, focus);
  await page.keyboard.press("Escape");
  if (depth === 0) {
    await expect(prompt(page), `${name}: Esc ohne Schritt beendet`).toHaveText(IDLE);
    return "ok";
  }
  await expect(page.locator(".cmdline"), `${name}: Esc = ein Schritt zurück`).toHaveAttribute("data-steps", String(depth - 1));
  if (prompts[depth - 1]) await expect(prompt(page)).toHaveText(prompts[depth - 1]);
  // Esc-Esc schnell: ganzer Befehl weg.
  await page.waitForTimeout(400);
  await setFocus(page, focus);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(prompt(page), `${name}: Esc-Esc bricht ab`).toHaveText(IDLE);

  // Enter: die Engine bekommt es (Befehl endet oder geht weiter) — nie ein Knopf-Klick.
  if (!(await start(page, name))) return "sofort";
  await clickCanvas(page, 200, 220);
  await clickCanvas(page, 380, 260);
  if ((await prompt(page).textContent()) === IDLE) return "ok";
  const before = `${await prompt(page).textContent()}|${await steps(page)}`;
  await setFocus(page, focus);
  await page.keyboard.press("Enter");
  await expect
    .poll(async () => `${await prompt(page).textContent()}|${await steps(page)}`, { message: `${name}: Enter wirkt` })
    .not.toBe(before);
  return "ok";
}

const NAMES = registeredCommands();
const FOCI: Focus[] = ["input", "canvas", "panel"];
const CHUNK = 5;

test("Registratur gelesen", () => {
  expect(NAMES.length).toBeGreaterThan(50);
  expect(NAMES).toContain("polyline");
});

for (let c = 0; c < NAMES.length; c += CHUNK) {
  const chunk = NAMES.slice(c, c + CHUNK);
  test(`Esc/Esc-Esc/Enter: ${chunk.join(", ")}`, async ({ page }) => {
    test.setTimeout(150_000);
    for (const [i, name] of chunk.entries()) {
      // Je Befehl ein leeres Projekt: gezeichnete Elemente (z. B. unendliche Hilfslinien) machen
      // das headless Rendern sonst sehr langsam. Der Fokus wechselt je Befehl, damit alle drei
      // Fälle über die Registratur verteilt geprüft sind.
      await startNewProject(page);
      const t0 = Date.now();
      const r = await escEscEnter(page, name, FOCI[(c + i) % FOCI.length]);
      if (process.env.E2E_TIMING) console.log(`${name}: ${r} ${Date.now() - t0} ms`);
    }
  });
}

for (const focus of FOCI) {
  test(`Wandzug: Esc nimmt den letzten Punkt, Enter übernimmt (Fokus: ${focus})`, async ({ page }) => {
    await startNewProject(page);
    await openTab(page, "Elemente");
    await page.getByRole("button", { name: "Wand", exact: true }).click();
    await expect(prompt(page)).toHaveText("Startpunkt der Wand:");
    await clickCanvas(page, 150, 300);
    await clickCanvas(page, 450, 300);
    await clickCanvas(page, 450, 150);
    await expect(page.locator(".cmdline")).toHaveAttribute("data-steps", "3");
    await setFocus(page, focus);
    await page.keyboard.press("Escape");
    await expect(page.locator(".cmdline")).toHaveAttribute("data-steps", "2");
    await expect(prompt(page)).toHaveText("Nächster Punkt:");
    await setFocus(page, focus);
    await page.keyboard.press("Enter");
    await expect(prompt(page)).toHaveText(IDLE);
    await expect(elementRows(page)).toHaveCount(1);
    // Esc-Esc schnell mitten im Zug: nichts dazu.
    await page.getByRole("button", { name: "Wand", exact: true }).click();
    await clickCanvas(page, 150, 350);
    await clickCanvas(page, 450, 350);
    await setFocus(page, focus);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await expect(prompt(page)).toHaveText(IDLE);
    await expect(elementRows(page)).toHaveCount(1);
  });
}

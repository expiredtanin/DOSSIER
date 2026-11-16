// [267] Ansichten Nord/Ost/Süd/West in einem Schritt: Befehl `ansichten` im Beispielprojekt → vier Ansichten
// (die vorhandene Südansicht wird nicht doppelt angelegt), ein Undo nimmt alle neuen zurück; im leeren Projekt
// Meldung statt Ebenen; Menü Ansicht führt dasselbe aus. Eigener Port: E2E_PORT=5193 npx playwright test e2e/elevations267.spec.ts
import type { Page } from "@playwright/test";
import { blurFocus, expect, openSample, openTab, startNewProject, test, typeCommand } from "./app";

test.use({ viewport: { width: 1280, height: 800 } });

const rows = (page: Page, text: string) => page.locator(".nav-row").filter({ hasText: text });
const count = async (page: Page) => (await rows(page, "Ansicht").count());

test("Befehl ansichten im Musterhaus: vier Ansichten, Süd nicht doppelt, Undo nimmt die neuen zurück", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Zeichnungsebenen");
  await expect(rows(page, "Ansicht Süd")).toHaveCount(1);
  const before = await count(page);

  await typeCommand(page, "ansichten");
  for (const n of ["Nord", "Ost", "Süd", "West"]) await expect(rows(page, `Ansicht ${n}`)).toHaveCount(1);
  expect(await count(page)).toBe(before + 3);
  await expect(page.getByText(/3 Ansichten angelegt/)).toBeVisible();
  const shots = process.env.E2E_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/elevations267.png` });

  // Zweiter Lauf: alles vorhanden, nichts Neues.
  await typeCommand(page, "ansichten");
  await expect(page.getByText(/Alle vier Ansichten sind schon vorhanden/)).toBeVisible();
  expect(await count(page)).toBe(before + 3);

  // Ein Undo nimmt Nord, Ost und West zurück (ein Schritt), Süd bleibt.
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rows(page, "Ansicht Nord")).toHaveCount(0);
  await expect(rows(page, "Ansicht Ost")).toHaveCount(0);
  await expect(rows(page, "Ansicht West")).toHaveCount(0);
  await expect(rows(page, "Ansicht Süd")).toHaveCount(1);
  expect(await count(page)).toBe(before);
});

test("Leeres Projekt: Menü Ansicht → Ansichten aller Seiten erzeugen meldet fehlendes Gebäude", async ({ page }) => {
  await startNewProject(page);
  await openTab(page, "Zeichnungsebenen");
  const before = await count(page);
  await page.getByRole("button", { name: "Ansicht", exact: true }).click();
  await page.getByRole("option", { name: "Ansichten aller Seiten erzeugen" }).click();
  await expect(page.getByText(/Kein Gebäude gefunden/)).toBeVisible();
  expect(await count(page)).toBe(before);
});

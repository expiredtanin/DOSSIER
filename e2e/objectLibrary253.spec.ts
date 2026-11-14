// [253] Objektbibliothek 2D: Palette „Objekte" → Objekt wählen → Einfügepunkt klicken (R drehen, M spiegeln) →
// Objekt-Info baut die Felder aus der Parameterliste → Breite ändern, „Neu würfeln" → Undo nimmt das Setzen
// samt angelegter Klasse in einem Schritt zurück. Geprüft über die Test-Naht `libobjs` (Parameter, Plan-Ausmass).
import type { Page } from "@playwright/test";
import { blurFocus, expect, openTab, test } from "./app";
import type {} from "../src/state/testHooks"; // Typ von window.__dossierTest

const prompt = (page: Page) => page.locator(".cmdline-prompt");
const libobjs = (page: Page) => page.evaluate(() => window.__dossierTest!.libobjs());

/** Objekt in der Palette wählen (Gruppe bei Bedarf aufklappen), Optionstasten drücken, Einfügepunkt klicken. */
async function place(page: Page, group: string, name: string, dx: number, dy: number, keys: string[] = []): Promise<void> {
  await openTab(page, "Objekte");
  const btn = page.getByRole("button", { name, exact: true });
  if (!(await btn.isVisible())) await page.locator("summary", { hasText: group }).click();
  await btn.click();
  await expect(prompt(page)).toHaveText("Einfügepunkt:");
  for (const k of keys) {
    // R / M wie beim Zeichnen: Fokus auf der Fläche, nicht im Textfeld.
    await blurFocus(page);
    await page.keyboard.press(k);
  }
  const box = (await page.locator("canvas").first().boundingBox())!;
  const x = box.x + dx;
  const y = box.y + dy;
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await expect(prompt(page)).toHaveText("Befehl:");
}

test("Objektbibliothek: WC und Esstisch setzen, Parameter ändern, Undo", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  const before = await libobjs(page);
  expect(before.items).toHaveLength(0);

  // WC: einmal gedreht (R) und gespiegelt (M).
  await place(page, "Sanitär", "WC wandhängend", 250, 250, ["r", "m"]);
  let s = await libobjs(page);
  expect(s.items).toHaveLength(1);
  const wc = s.items[0];
  expect(wc.libId).toBe("lib:wc-wand");
  expect(wc.rotation).toBeCloseTo(Math.PI / 2, 6);
  expect(wc.params.mirror).toBe(true);
  expect(wc.lines).toBeGreaterThan(0);
  // Die Klasse des Objekts gibt es jetzt (im selben Schritt angelegt).
  expect(s.layers).toContain(wc.categoryCode);

  // Esstisch mit Stühlen: Drehung und Spiegelung bleiben erhalten → dreimal R und einmal M stellt sie zurück.
  await place(page, "Tische", "Tisch 80×140 mit Stühlen", 450, 250, ["r", "r", "r", "m"]);
  s = await libobjs(page);
  expect(s.items).toHaveLength(2);
  const table = s.items.find((o) => o.libId === "lib:tisch-80x140")!;
  expect(table).toBeTruthy();
  expect(table.rotation).toBeCloseTo(0, 6);
  expect(table.params.mirror).toBeUndefined();
  expect(table.lines).toBeGreaterThan(0);
  expect(table.categoryCode).not.toBe(wc.categoryCode);

  // Objekt-Info des Tischs: Felder aus der Parameterliste; Breite ändern → das Plan-Ausmass wächst.
  await page.evaluate((id) => window.__dossierTest!.select({ drawings: [id] }), table.id);
  await openTab(page, "Objekt-Info");
  const section = page.getByTestId("libobj-section");
  await expect(section).toContainText("Tisch 80×140 mit Stühlen");
  await expect(section.locator("label.objinfo-field", { hasText: "Stühle" })).toBeVisible();
  const width = section.locator("label.objinfo-field", { hasText: "Breite" }).locator("input");
  await expect(width).toHaveValue("1.400");
  await width.fill("2");
  await width.press("Enter");
  await expect.poll(async () => (await libobjs(page)).items.find((o) => o.id === table.id)!.params.w).toBeCloseTo(2, 6);
  const wider = (await libobjs(page)).items.find((o) => o.id === table.id)!;
  expect(wider.w, "Plan wird breiter").toBeGreaterThan(table.w + 0.4);

  // „Neu würfeln" ändert den Seed.
  const seed0 = wider.seed;
  await section.getByRole("button", { name: "Neu würfeln" }).click();
  await expect.poll(async () => (await libobjs(page)).items.find((o) => o.id === table.id)!.seed).not.toBe(seed0);

  // Undo, Schritt für Schritt: Seed, Breite, Tisch setzen (ein Schritt), WC samt Klasse setzen (ein Schritt).
  const undo = async () => {
    await blurFocus(page);
    await page.keyboard.press("ControlOrMeta+z");
  };
  await undo();
  await expect.poll(async () => (await libobjs(page)).items.find((o) => o.id === table.id)?.seed).toBe(seed0);
  await undo();
  await expect.poll(async () => (await libobjs(page)).items.find((o) => o.id === table.id)?.params.w).toBe(1.4);
  await undo();
  await expect.poll(async () => (await libobjs(page)).items.map((o) => o.libId)).toEqual(["lib:wc-wand"]);
  await undo();
  await expect.poll(async () => (await libobjs(page)).items).toHaveLength(0);
  // Die für das WC angelegte Klasse ist mit zurückgenommen.
  expect((await libobjs(page)).layers).toEqual(before.layers);
});

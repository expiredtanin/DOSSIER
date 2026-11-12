// [185] Navigation wie Archicad: Geschosswechsel per Ctrl/Cmd+6 behält Zoom und Ausschnitt exakt; Ctrl/Cmd+3 zeigt die
// Auswahl allein im 3D (Reiter „3D · Auswahl"), Ctrl/Cmd+4 blendet sie aus, Ctrl/Cmd+3 ohne Auswahl zeigt wieder alles.
// Das 3D-Bild ist headless leer (kein WebGPU): geprüft wird über den Store und die 3D-Teile/Pick-Geometrie.
import { discardIfAsked, drawingTab, drawingTabs, expect, fileMenu, openTab, test } from "./app";

test("Geschoss per Ctrl+6/5 mit gleichem Ausschnitt, Auswahl in 3D zeigen/ausblenden", async ({ page }) => {
  test.setTimeout(150_000);
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  const tabs = drawingTabs(page).getByRole("tab");
  const nav = (name: string) => page.locator(".nav-row").filter({ hasText: name }).first();
  const cam = () => page.evaluate(() => window.__dossierTest!.viewCamera());
  const v3d = () => page.evaluate(() => window.__dossierTest!.view3d());

  await openTab(page, "Zeichnungsebenen");
  await nav("Erdgeschoss").click();
  const plan = page.locator("svg.plan-svg").first();
  await expect(plan).toBeVisible({ timeout: 30_000 });
  const eg = (await cam()).levelId;

  // Zoomen und verschieben (Rad an einer Stelle abseits der Mitte).
  await page.waitForTimeout(500);
  const fitted = await cam();
  const box = (await plan.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, -240);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(500);
  const before = await cam();
  expect(before.center && before.pxPerMeter).toBeTruthy();
  expect(before.pxPerMeter, "Rad hat gezoomt").not.toBeCloseTo(fitted.pxPerMeter!, 3);

  // Ctrl+6: Obergeschoss im selben Reiter, gleicher Ausschnitt.
  await page.keyboard.press("Control+6");
  await expect(drawingTab(page, "Obergeschoss")).toHaveAttribute("aria-selected", "true");
  await expect(tabs).toHaveCount(1);
  await page.waitForTimeout(500);
  const after = await cam();
  expect(after.levelId).not.toBe(eg);
  expect(after.pxPerMeter).toBeCloseTo(before.pxPerMeter!, 6);
  expect(after.center!.x).toBeCloseTo(before.center!.x, 6);
  expect(after.center!.y).toBeCloseTo(before.center!.y, 6);
  expect(after.scale).toBe(before.scale);

  // Ctrl+5: zurück ins Erdgeschoss, Ausschnitt weiter gleich.
  await page.keyboard.press("Control+5");
  await expect(drawingTab(page, "Erdgeschoss")).toHaveAttribute("aria-selected", "true");
  await page.waitForTimeout(300);
  const back = await cam();
  expect(back.levelId).toBe(eg);
  expect(back.center!.x).toBeCloseTo(before.center!.x, 6);
  expect(back.pxPerMeter).toBeCloseTo(before.pxPerMeter!, 6);
  await page.keyboard.press("Control+6");
  await expect(drawingTab(page, "Obergeschoss")).toHaveAttribute("aria-selected", "true");

  // Wand wählen → Ctrl+3: 3D-Reiter „3D · Auswahl", nur diese Wand im Modell und im Pick.
  const all = await v3d();
  expect(all.only).toBeNull();
  expect(all.walls.length).toBeGreaterThan(3);
  const wall = all.walls[0];
  await page.evaluate((id) => window.__dossierTest!.select({ walls: [id] }), wall);
  await page.keyboard.press("Control+3");
  await expect(drawingTab(page, "3D · Auswahl")).toHaveAttribute("aria-selected", "true");
  await expect(tabs).toHaveCount(2);
  const only = await v3d();
  expect(only.only).toEqual([wall]);
  expect(only.walls).toEqual([wall]);
  expect(only.pickWalls).toEqual([wall]);
  // [197] Nur diese Wand: keine Dachfenster/Deckenöffnungen (Wirt Dach/Decke), nur Öffnungen dieser Wand.
  expect(only.pickOpenings.every((o) => o.host === wall)).toBe(true);
  expect(all.pickOpenings.some((o) => o.host === "dach-haupt")).toBe(true);

  // Ctrl+4: die gewählte Wand ausblenden (nicht mehr im Modell, nicht anwählbar), Auswahl leer.
  await page.keyboard.press("Control+4");
  await expect.poll(async () => (await v3d()).hidden).toEqual([wall]);
  const hidden = await v3d();
  expect(hidden.walls).toEqual([]);
  expect(hidden.pickWalls).toEqual([]);
  expect(JSON.parse((await page.evaluate(() => window.__dossierTest!.selected())).all).walls).toEqual([]);

  // Ctrl+3 ohne Auswahl: wieder alles, normaler 3D-Reiter.
  await page.keyboard.press("Control+3");
  await expect(drawingTab(page, "3D · Obergeschoss")).toHaveAttribute("aria-selected", "true");
  await expect(tabs).toHaveCount(2);
  const again = await v3d();
  expect(again.only).toBeNull();
  expect(again.hidden).toEqual([]);
  expect(again.walls).toEqual(all.walls);

  // Ctrl+5 im 3D-Reiter: aktives Geschoss wechselt, bleibt 3D.
  await page.keyboard.press("Control+5");
  await expect(drawingTab(page, "3D · Erdgeschoss")).toHaveAttribute("aria-selected", "true");
  await expect(tabs).toHaveCount(2);
});

// [40] Ausschnitt duplizieren: Kopie erscheint im Ausschnitte-Panel als „… Kopie", Undo nimmt sie wieder weg.
import { blurFocus, discardIfAsked, expect, fileMenu, openTab, showSnapshot, startNewProject, test } from "./app";

test("Ausschnitt duplizieren und rückgängig machen", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await openTab(page, "Ausschnitte");
  const dups = page.locator("[data-testid^=viewsnap-duplicate-]");
  const before = await dups.count();
  expect(before).toBeGreaterThan(0);
  await dups.first().click();
  await expect(dups).toHaveCount(before + 1);
  await expect(page.getByText(/ Kopie$/).first()).toBeVisible();
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(dups).toHaveCount(before);
});

// [34] Vorlage direkt am Ausschnitt wählen (Fussbereich des gewählten Ausschnitts).
test("Ausschnitt: Ansichtsvorlage im Panel wählen und lösen", async ({ page }) => {
  test.setTimeout(120_000);
  await startNewProject(page);
  await fileMenu(page, /Musterhaus \(komplex\)/);
  await discardIfAsked(page);
  await expect(page.locator(".project-name")).toHaveText("Musterhaus komplex", { timeout: 30_000 });
  await openTab(page, "Ausschnitte");
  // [136] Wahl im Panel bleibt stabil (keine Abwahl durch die angewendete Ansicht).
  await showSnapshot(page, "EG 1:100");
  const sel = page.getByTestId("viewsnap-template");
  await expect(sel).toBeVisible();
  await expect(sel).toHaveValue("vt-gr100");
  await sel.selectOption("");
  await expect(sel).toHaveValue("");
  await sel.selectOption("vt-gr50");
  await expect(sel).toHaveValue("vt-gr50");
});

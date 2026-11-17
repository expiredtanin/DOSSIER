// [275] Umbau-Panel, Abschnitt „Darstellung“: Farbe einer Status-Füllung ändern (Plan folgt, Undo), Stift statt Farbe,
// „SIA-Vorgabe“, gestrichelt beim Abbruch, eigene Farbe einer Etappe. Port: E2E_PORT=5196.
import type { Locator, Page } from "@playwright/test";
import { blurFocus, commandInput, expect, finishCommand, openTab, test, typeCommand } from "./app";

test.use({ viewport: { width: 1280, height: 900 } });

const RED = "#c8524a";
const OWN = "#336699";
const PHASE = "#5b84b1";

/** Füllfarbe im Popover des Farb-/Stiftfelds als Hex setzen. */
async function setHex(page: Page, field: Locator, hex: string) {
  const pop = page.locator(".pen-color-popover");
  await field.scrollIntoViewIfNeeded();
  // Ein Scrollen des Panels schliesst das Popover (PenColorField): bis es offen bleibt.
  await expect(async () => {
    if (!(await pop.isVisible())) await field.locator(".pen-color-swatch").click();
    await expect(pop).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 10_000 });
  await pop.getByRole("button", { name: "Frei", exact: true }).click();
  await pop.locator("input.pen-color-input").fill(hex);
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 895);
}

test("Umbau-Panel Darstellung: Farbe oder Stift je Status, SIA-Vorgabe, Etappen-Farbe ([275])", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto("/?dossierTest");
  await page.getByRole("button", { name: /Neues Projekt/ }).first().click();
  await expect(page.getByRole("group", { name: "Befehlszeile" })).toBeVisible();
  const ren = () => page.evaluate(() => window.__dossierTest!.renovation());
  const fills = async () => Object.keys(await page.evaluate(() => window.__dossierTest!.planFillColors()));

  await openTab(page, "Umbau");
  const panel = page.getByTestId("renovation-dock");
  await panel.getByTestId("reno-draw-new").click();
  await page.getByRole("button", { name: "Wand", exact: true }).click();
  await commandInput(page).focus();
  await typeCommand(page, "0,0");
  await typeCommand(page, "5,0");
  await finishCommand(page);
  await blurFocus(page);
  await panel.getByTestId("reno-filter-umbauplan").click();
  await expect.poll(fills).toContain(RED);

  // Abschnitt Darstellung: Neu zeigt die gedämpfte Vorgabe.
  const styles = panel.getByTestId("reno-styles");
  await expect(styles).toBeVisible();
  const rowNew = styles.getByTestId("reno-style-new");
  await expect(rowNew).toHaveAttribute("data-fill", RED);
  await expect(styles.getByTestId("reno-style-sia")).toBeDisabled();
  await styles.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/renovation275-darstellung-hell.png" });

  // Freie Farbe: Plan folgt; ein Undo-Schritt stellt zurück.
  await setHex(page, styles.getByTestId("reno-style-new-fill"), OWN);
  await expect(rowNew).toHaveAttribute("data-fill", OWN);
  await expect.poll(fills).toContain(OWN);
  await expect.poll(fills).not.toContain(RED);
  await blurFocus(page);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(rowNew).toHaveAttribute("data-fill", RED);
  await expect.poll(fills).toContain(RED);

  // Stift statt Farbe: die Füllung nimmt die Farbe des Stifts im aktiven Stiftsatz; Plan zeigt sie.
  await styles.getByTestId("reno-style-new-fill").locator(".pen-color-swatch").click();
  const pop = page.locator(".pen-color-popover");
  await pop.getByRole("button", { name: "Stift", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.mouse.click(5, 895);
  await expect(styles.getByTestId("reno-style-new-fill").locator(".pen-color-badge")).toBeVisible();
  const penFill = await rowNew.getAttribute("data-fill");
  expect(penFill).toMatch(/^#[0-9a-f]{6}$/i);
  await expect.poll(fills).toContain(penFill!);

  // SIA-Vorgabe setzt alles zurück.
  await expect(styles.getByTestId("reno-style-sia")).toBeEnabled();
  await styles.getByTestId("reno-style-sia").click();
  await expect(rowNew).toHaveAttribute("data-fill", RED);
  await expect(styles.getByTestId("reno-style-sia")).toBeDisabled();
  await expect.poll(fills).toContain(RED);

  // Gestrichelt nur beim Abbruch angeboten.
  await expect(styles.getByTestId("reno-style-demolish-dashed")).toBeChecked();
  await expect(styles.getByTestId("reno-style-new-dashed")).toHaveCount(0);
  await styles.getByTestId("reno-style-demolish-dashed").uncheck();
  await expect(styles.getByTestId("reno-style-demolish")).toHaveAttribute("data-dashed", "false");
  await styles.getByTestId("reno-style-demolish-reset").click();
  await expect(styles.getByTestId("reno-style-demolish")).toHaveAttribute("data-dashed", "true");

  // Etappe mit eigener Farbe: Wand in Etappe 1, deren Neu-Farbe blau.
  await panel.getByTestId("reno-phase-add").click();
  const wallId = Object.keys((await ren()).walls)[0];
  await page.evaluate((id) => window.__dossierTest!.select({ walls: [id] }), wallId);
  const phaseId = await panel.getByTestId("reno-sel-phase").locator("option").nth(1).getAttribute("value");
  await panel.getByTestId("reno-sel-phase").selectOption(phaseId!);
  await panel.getByTestId("reno-phase-style").click();
  const phaseBox = panel.getByTestId("reno-phase-styles");
  await expect(phaseBox).toBeVisible();
  await setHex(page, phaseBox.getByTestId("reno-phase-style-new-fill"), PHASE);
  await expect(phaseBox.getByTestId("reno-phase-style-new")).toHaveAttribute("data-fill", PHASE);
  await expect.poll(fills).toContain(PHASE);
  await expect.poll(fills).not.toContain(RED);
  // Projektfarbe bleibt unverändert.
  await expect(rowNew).toHaveAttribute("data-fill", RED);
  await phaseBox.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/renovation275-etappe.png" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await styles.scrollIntoViewIfNeeded();
  await page.screenshot({ path: "test-results/renovation275-darstellung-dunkel.png" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await phaseBox.getByTestId("reno-phase-style-reset").click();
  await expect.poll(fills).toContain(RED);
  await expect.poll(fills).not.toContain(PHASE);
});

import { expect, openSample, startNewProject, test } from "./app";

test("3D-Ansicht öffnen ohne Konsolenfehler und zurück in den Grundriss", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);

  await page.getByRole("button", { name: "Ansicht", exact: true }).click();
  // „Perspektive" gibt es zweimal (Ansichtsart, Blickwinkel-Preset); die Ansichtsart steht zuerst.
  await page.getByRole("option", { name: "Perspektive" }).first().click();
  // [182] Die Perspektive öffnet einen eigenen 3D-Reiter; der Grundriss-Reiter bleibt.
  await expect(page.getByText("Perspektive · Erdgeschoss", { exact: false })).toBeVisible();
  await expect(page.getByRole("tab", { name: "3D · Erdgeschoss", exact: true })).toHaveAttribute("aria-selected", "true");

  // Der Konsolen-Wächter (app.ts) schlägt bei unerwarteten Fehlern an; hier zusätzlich ein
  // Blickwinkel-Wechsel, der den Viewport neu aufbaut.
  await page.getByRole("button", { name: "Ansicht", exact: true }).click();
  await page.getByRole("option", { name: "Iso" }).first().click();

  await page.getByRole("button", { name: "Ansicht", exact: true }).click();
  await page.getByRole("option", { name: "Grundriss" }).click();
  await expect(page.getByRole("tab", { name: "Erdgeschoss", exact: true })).toBeVisible();
  await expect(page.getByText(/^Perspektive · /)).toHaveCount(0);
});

import { expect, openSample, startNewProject, test } from "./app";

test("3D-Ansicht öffnen ohne Konsolenfehler und zurück in den Grundriss", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);

  await page.getByRole("button", { name: "Ansicht", exact: true }).click();
  // „3D-Ansicht" (Ansichtsart) und „Perspektive" (Blickwinkel-Preset) sind getrennt benannt [263].
  await page.getByRole("option", { name: "3D-Ansicht", exact: true }).click();
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

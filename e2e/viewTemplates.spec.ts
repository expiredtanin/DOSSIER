// Ansichtsvorlagen ([34]): Vorlage mit ausgeblendeter Kategorie anlegen, mit der aktiven Ansicht
// verknüpfen (Kategorie verschwindet), die Vorlage ändern (Ansicht folgt), duplizieren und löschen.
// Geprüft über sichtbare UI (Ebenen-Panel, Ressourcen-Tab) — nicht über Pixel.
import { expect, openSample, openTab, startNewProject, test } from "./app";

test("Ansichtsvorlage: Kategorie ausblenden, anwenden, Vorlage ändern, Ansicht folgt ([34])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);

  // Ressourcen-Fenster → Tab „Ansichtsvorlagen" (schliesst über dem Dock liegend, daher je Mal öffnen/schliessen).
  const openResources = async () => {
    await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
    await page.getByRole("option", { name: /Ressourcen/ }).click();
    await page.getByRole("tab", { name: "Ansichtsvorlagen" }).click();
  };
  const closeResources = () => page.locator(".res-window").getByRole("button", { name: "Schließen" }).first().click();
  await openResources();
  // Neue Projekte bringen Standard-Vorlagen mit ([66]); gezählt wird relativ dazu.
  const rows = page.getByTestId("view-template-row");
  const base = await rows.count();
  await page.getByTestId("view-template-add").click();
  await expect(rows).toHaveCount(base + 1);

  // Kategorie „Wände" (20) in der Vorlage ausblenden, dann mit der aktiven Ansicht verknüpfen.
  const wallsCat = page.getByTestId("view-template-categories").getByRole("combobox", { name: /^20 / });
  await wallsCat.selectOption("hide");
  await page.getByTestId("view-template-apply-linked").click();
  await expect(rows.filter({ hasText: "1 verknüpft" })).toHaveCount(1);

  // Ebenen-Panel: Wände sind ausgeblendet (Schalter bietet „Einblenden").
  await closeResources();
  await openTab(page, "Ebenen");
  const walls = page.getByRole("button", { name: /^Wände sichtbar$/ });
  await expect(walls).toHaveAttribute("title", "Einblenden");

  // Vorlage ändern: Wände wieder sichtbar → die verknüpfte Ansicht folgt.
  await openResources();
  await wallsCat.selectOption("show");
  await closeResources();
  await expect(walls).toHaveAttribute("title", "Ausblenden");

  // Duplizieren und Löschen.
  await openResources();
  await page.getByTitle("Vorlage duplizieren").last().click();
  await expect(rows).toHaveCount(base + 2);
  await page.getByTitle("Vorlage löschen").last().click();
  await expect(rows).toHaveCount(base + 1);
});

test("Override-Baustein „Deckenaufbau weiss“ in eine Ansichtsvorlage übernehmen ([33])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
  await page.getByRole("option", { name: /Ressourcen/ }).click();
  await page.getByRole("tab", { name: "Ansichtsvorlagen" }).click();
  await page.getByTestId("view-template-add").click();
  await page.getByTestId("view-template-row").last().click();
  // Baustein wählen und übernehmen: Regel ins Projekt, in der Vorlage eingeschaltet.
  await page.getByRole("combobox", { name: "Baustein übernehmen" }).selectOption({ label: "Deckenaufbau weiss" });
  await page.getByTestId("view-template-rule-block-add").click();
  await expect(page.getByTestId("view-template-rules").getByRole("checkbox", { name: "Deckenaufbau weiss" })).toBeChecked();
  await expect(page.getByTestId("view-template-rule-block-add")).toBeDisabled();
  // Overrides-Tab: Regel mit Schicht-Bedingungen und Schnittflächen-Aktionen.
  await page.getByRole("tab", { name: "Overrides" }).click();
  await page.locator(".res-ov-row", { hasText: "Deckenaufbau weiss" }).click();
  const detail = page.getByTestId("override-rule-detail");
  await expect(detail.getByTestId("override-more-condition")).toHaveCount(1);
  // Aktion „Umriss / Fuge“ an (Schalter) und eingeschaltet (Wert).
  await expect(detail.getByRole("checkbox", { name: "Umriss / Fuge" })).toHaveCount(2);
  for (const c of await detail.getByRole("checkbox", { name: "Umriss / Fuge" }).all()) await expect(c).toBeChecked();
  // Massstab-Kriterium: der Baustein gilt ab 1:100 (Liste zeigt es in der Zusammenfassung).
  const scale = detail.getByTestId("override-scale");
  await expect(scale.getByRole("checkbox", { name: "ab Massstab" })).toBeChecked();
  await expect(scale.getByRole("spinbutton")).toHaveValue("100");
  await expect(page.locator(".res-ov-row", { hasText: "Deckenaufbau weiss" })).toContainText("ab 1:100");
  // Bereich bis 1:200 ergänzen.
  await scale.getByRole("checkbox", { name: "bis Massstab" }).check();
  await scale.getByRole("spinbutton").last().fill("200");
  await expect(page.locator(".res-ov-row", { hasText: "Deckenaufbau weiss" })).toContainText("1:100 bis 1:200");
});

test("Aufbau-Editor: Schichtfunktion wählen, Vorgabe aus dem Baustoff ([33])", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  await page.getByRole("button", { name: "Fenster", exact: true }).first().click();
  await page.getByRole("option", { name: /Ressourcen/ }).click();
  await page.getByRole("tab", { name: "Deckenstile" }).click();
  const fn = page.getByTestId("layer-function").first().locator(".tb-dd-trigger");
  // Vorgabe: aus dem Baustoff abgeleitet, mit Anzeige des Werts.
  await expect(fn).toHaveText(/^aus Baustoff: \S/);
  await fn.click();
  await page.getByRole("option", { name: "Dämmung", exact: true }).click();
  await expect(fn).toHaveText("Dämmung");
  // Zurück auf die Vorgabe.
  await fn.click();
  await page.getByRole("option", { name: /^aus Baustoff: / }).click();
  await expect(fn).toHaveText(/^aus Baustoff: /);
});

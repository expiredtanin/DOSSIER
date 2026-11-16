// [268] Review [264]: der Sprachwechsel baut die App neu auf (`LanguageRoot`). Der Datei-Zustand (zuletzt gespeicherter
// Stand, Pfad, Lock) darf dabei nicht verloren gehen — sonst gelten ungespeicherte Änderungen als gespeichert und
// „Neues Projekt“/Öffnen/Schliessen verwirft sie ohne Rückfrage. Ebenso darf der Neuaufbau die Autosave-Kopie der
// LAUFENDEN Sitzung nicht als „ungesicherte Arbeit aus der letzten Sitzung“ anbieten.
// Eigener Port: E2E_PORT=5195 npx playwright test e2e/languageSwitch268.spec.ts
import type { Page } from "@playwright/test";
import { sampleProject } from "../src/model/sampleProject";
import { blurFocus, commandInput, expect, finishCommand, openTab, startNewProject, test, typeCommand } from "./app";

async function switchLanguage(page: Page, windowMenu: string, item: string, dialog: string, label: string, lang: "de" | "en") {
  await page.getByRole("menubar").getByRole("button", { name: windowMenu, exact: true }).click();
  await page.getByRole("option", { name: item }).click();
  const dlg = page.getByRole("dialog", { name: dialog });
  await expect(dlg).toBeVisible();
  await dlg.getByLabel(label).selectOption(lang);
}

async function drawWall(page: Page) {
  await openTab(page, "Elemente");
  await page.getByRole("button", { name: "Wand", exact: true }).click();
  await commandInput(page).focus();
  await typeCommand(page, "0,0");
  await typeCommand(page, "5,0");
  await finishCommand(page);
  await blurFocus(page);
}

test("Sprachwechsel behält ungespeicherte Änderungen: Neues Projekt fragt weiterhin nach", async ({ page }) => {
  test.setTimeout(60_000);
  await startNewProject(page);
  await drawWall(page);
  await switchLanguage(page, "Fenster", "Einstellungen", "Einstellungen", "Sprache", "en");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("option", { name: /^New Project$/ }).click();
  await expect(page.getByRole("button", { name: "Don't save" }), "Rückfrage „Ungespeicherte Änderungen“").toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  // Abbrechen: die Wand ist noch da.
  await expect(page.locator(".project-name")).toHaveText("Leeres Projekt");
});

test("Sprachwechsel bietet die Autosave-Kopie der laufenden Sitzung nicht als Wiederherstellung an", async ({ page }) => {
  test.setTimeout(60_000);
  await startNewProject(page);
  await drawWall(page);
  // Die laufende Sitzung hat (wie nach dem 30-s-Takt) eine Kopie des unbenannten Projekts geschrieben.
  await page.evaluate(
    (project) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("dossier", 1);
        open.onupgradeneeded = () => {
          if (!open.result.objectStoreNames.contains("projects")) open.result.createObjectStore("projects", { keyPath: "name" });
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("projects", "readwrite");
          tx.objectStore("projects").put({ name: "autosave:unsaved", project, savedAt: Date.now() });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    JSON.stringify(sampleProject),
  );
  await switchLanguage(page, "Fenster", "Einstellungen", "Einstellungen", "Sprache", "en");
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "File", exact: true })).toBeVisible();
  // Die Suche nach Kopien läuft asynchron (IndexedDB): kurz warten, dann darf kein Angebot da sein.
  await page.waitForTimeout(1500);
  await expect(page.getByText(/Unsaved work found|Ungesicherte Arbeit gefunden|damaged/i)).toHaveCount(0);
});

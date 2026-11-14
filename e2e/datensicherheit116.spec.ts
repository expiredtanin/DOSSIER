// [116] Datensicherheit im Browser: Wiederherstellen nach Absturz/Neuladen (Autosave-Kopie in IndexedDB),
// beschädigte Kopien (abgeschnittenes JSON) und die Rückfrage beim Schliessen mit ungespeicherten Änderungen.
// Was nur die Tauri-App kann (Fenster schliessen, Cmd+Q, atomares Schreiben auf die Platte): `doc/RELEASE-1.0.md`, Abschnitt 14.
import type { Page } from "@playwright/test";
import { blurFocus, elementRows, expect, openSample, openTab, startNewProject, test } from "./app";
import { sampleProject } from "../src/model/sampleProject";

const GOOD = JSON.stringify(sampleProject);
const TRUNCATED = GOOD.slice(0, GOOD.length >> 1);

/** Schreibt Datensätze so in IndexedDB, wie `state/projectStore.ts` es tut (Datenbank „dossier", Speicher „projects"). */
async function seedAutosave(page: Page, records: { name: string; project: string; savedAt: number }[]): Promise<void> {
  await page.evaluate(
    (recs) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open("dossier", 1);
        open.onupgradeneeded = () => {
          if (!open.result.objectStoreNames.contains("projects")) open.result.createObjectStore("projects", { keyPath: "name" });
        };
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction("projects", "readwrite");
          for (const r of recs) tx.objectStore("projects").put(r);
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    records,
  );
}

/**
 * Leere Seite auf dem Ursprung der App: dort lässt sich IndexedDB füllen, BEVOR die App läuft (sonst liest und
 * löscht die App beim Start die Kopien schon, während der Test sie noch schreibt).
 */
async function blankOrigin(page: Page): Promise<void> {
  await page.route("**/__seed", (r) => r.fulfill({ contentType: "text/html", body: "<!doctype html><title>seed</title>" }));
  await page.goto("/__seed");
}

/** Merkt sich, ob ein Text je sichtbar war (Toasts verschwinden nach 4 s; unter Last ist Polling zu knapp). Vor `goto`/`reload` rufen. */
async function rememberText(page: Page, needle: string): Promise<() => Promise<boolean>> {
  await page.addInitScript((n) => {
    const w = window as unknown as { __saw?: Record<string, boolean> };
    w.__saw = w.__saw ?? {};
    // MutationObserver statt Timer: die Beobachtung läuft direkt nach dem DOM-Eintrag, auch wenn der Hauptfaden danach blockiert.
    const check = () => {
      if (document.body?.textContent?.includes(n)) w.__saw![n] = true;
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true, characterData: true });
  }, needle);
  return () => page.evaluate((n) => !!(window as unknown as { __saw?: Record<string, boolean> }).__saw?.[n], needle);
}

async function storedNames(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open("dossier", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction("projects").objectStore("projects").getAllKeys();
          req.onsuccess = () => resolve((req.result as string[]).sort());
        };
      }),
  );
}

test("Neuladen mit Autosave-Kopie: Angebot, Wiederherstellen bringt das Projekt zurück", async ({ page }) => {
  await blankOrigin(page);
  await seedAutosave(page, [{ name: "autosave:unsaved", project: GOOD, savedAt: Date.now() }]);
  await page.goto("/");
  const dialog = page.getByRole("dialog", { name: "Ungesicherte Arbeit gefunden" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Wiederherstellen" }).click();
  await expect(page.locator(".project-name")).toHaveText("Demo-Haus");
});

test("beschädigte neueste Kopie: Hinweis, die vorige Kopie wird angeboten, die beschädigte ist weg", async ({ page }) => {
  const saw = await rememberText(page, "neueste automatische Sicherung war beschädigt");
  await blankOrigin(page);
  await seedAutosave(page, [
    { name: "autosave:unsaved", project: TRUNCATED, savedAt: Date.now() },
    { name: "autosave:unsaved#prev", project: GOOD, savedAt: Date.now() - 60_000 },
  ]);
  await page.goto("/");
  await expect.poll(saw).toBe(true);
  const dialog = page.getByRole("dialog", { name: "Ungesicherte Arbeit gefunden" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Wiederherstellen" }).click();
  await expect(page.locator(".project-name")).toHaveText("Demo-Haus");
  expect(await storedNames(page)).toEqual(["autosave:unsaved#prev"]);
});

test("nur beschädigte Kopien: kein Absturz, Hinweis, kein Angebot, beide gelöscht", async ({ page }) => {
  const saw = await rememberText(page, "Sicherung war beschädigt und wurde verworfen");
  await blankOrigin(page);
  await seedAutosave(page, [
    { name: "autosave:unsaved", project: TRUNCATED, savedAt: Date.now() },
    { name: "autosave:unsaved#prev", project: "{", savedAt: Date.now() - 60_000 },
  ]);
  await page.goto("/");
  await expect.poll(saw).toBe(true);
  await expect(page.getByRole("dialog", { name: "Ungesicherte Arbeit gefunden" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Neues Projekt/ }).first()).toBeVisible();
  await expect.poll(() => storedNames(page)).toEqual([]);
});

test("Schliessen mit ungespeicherten Änderungen: Browser fragt nach (beforeunload), sauber nicht", async ({ page }) => {
  await startNewProject(page);
  await openSample(page);
  // Sauber (gerade geladen): kein beforeunload-Dialog.
  const seen: string[] = [];
  page.on("dialog", (d) => {
    seen.push(d.type());
    void d.dismiss();
  });
  await page.reload();
  expect(seen).toEqual([]);

  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: "W1" }).click();
  const top = page.locator(".objinfo-wall-anchor").first();
  await top.getByRole("button", { name: "Eigene" }).click();
  const topField = top.getByLabel("Eigene Höhe");
  await topField.fill("3.2");
  await topField.press("Enter");
  await blurFocus(page);
  // Chromium fragt nur nach einer Nutzer-Geste auf der Seite; die ist durch die Klicks gegeben. dismiss = Seite bleibt.
  void page.reload().catch(() => {});
  await expect.poll(() => seen).toContain("beforeunload");
  // Aufräumen: ab jetzt „Verlassen" bestätigen, sonst hielte die Abfrage das Schliessen der Seite am Testende auf.
  page.removeAllListeners("dialog");
  page.on("dialog", (d) => void d.accept());
  // (Nach „Bleiben" hängt der Playwright-Treiber an der abgebrochenen Navigation; mehr wird hier nicht geprüft.)
});

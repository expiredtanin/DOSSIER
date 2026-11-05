// [121] Neurendern messen: wie viele React-Komponenten rendern bei EINER Wand-Änderung (Objekt-Info,
// Musterhaus) bzw. bei einem Zoom-Schritt im Grundriss? Gezählt über einen schlanken DevTools-Haken
// (`__REACT_DEVTOOLS_GLOBAL_HOOK__`, den React auch im Produktions-Build bedient) — ohne Produktcode.
// Eine Komponente zählt, wenn sich ihre Props oder ihr Hook-Zustand seit dem letzten Commit
// geändert haben (= sie hat gerendert). Die Zahlen stehen in der Ausgabe (Namen nur lesbar ohne
// Minifizierung: `vite build --minify false`). Gemessen 3.11. (Musterhaus): Wand-Änderung 413 → 290,
// Zoom-Schritt 240 → 61. 4.11.: Wand-Änderung 290 → 51 (Plan-Primitive/Schraffur-Muster mit
// Strukturvergleich), Zoom-Schritt 61 → 8, 5 Zeiger-Schritte 75 → 20 (Live-Anzeigen abonnieren selbst).
// Die Schranken unten fangen den Rückfall ab, dass wieder ganze Bäume mitrendern.
import type { Page } from "@playwright/test";
import { blurFocus, elementRows, expect, openSample, openTab, startNewProject, test } from "./app";

declare global {
  interface Window {
    __renderCounts?: { on: boolean; total: number; byName: Record<string, number> };
  }
}

async function installCounter(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const stats = { on: false, total: 0, byName: {} as Record<string, number> };
    window.__renderCounts = stats;
    const seen = new WeakMap<object, { p: unknown; s: unknown }>();
    // Funktions-, Klassen-, forwardRef-, einfache memo-Komponenten (React-18-Fiber-Tags). Die Hülle
    // von `memo(fn, vergleich)` (Tag 14) zählt nicht: sie trägt bei jedem Eltern-Render neue Props,
    // auch wenn der Vergleich das Rendern verhindert; rendert sie, zählt ihr inneres Kind (Tag 0).
    const COMPOSITE = new Set([0, 1, 11, 15]);
    type Fiber = {
      tag: number;
      type: { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } } | null;
      memoizedProps: unknown;
      memoizedState: unknown;
      alternate: Fiber | null;
      child: Fiber | null;
      sibling: Fiber | null;
    };
    const nameOf = (f: Fiber): string => {
      const t = f.type;
      if (!t) return "?";
      return t.displayName || t.name || t.render?.name || t.type?.name || "anon";
    };
    const walk = (root: Fiber | null) => {
      const stack: Fiber[] = root ? [root] : [];
      while (stack.length) {
        const f = stack.pop()!;
        if (COMPOSITE.has(f.tag)) {
          const key = (seen.has(f) ? f : f.alternate && seen.has(f.alternate) ? f.alternate : f) as object;
          const prev = seen.get(key);
          if (!prev || prev.p !== f.memoizedProps || prev.s !== f.memoizedState) {
            if (stats.on) {
              stats.total++;
              const n = nameOf(f);
              stats.byName[n] = (stats.byName[n] ?? 0) + 1;
            }
          }
          seen.set(key, { p: f.memoizedProps, s: f.memoizedState });
        }
        if (f.sibling) stack.push(f.sibling);
        if (f.child) stack.push(f.child);
      }
    };
    (window as unknown as { __REACT_DEVTOOLS_GLOBAL_HOOK__: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      supportsFiber: true,
      renderers: new Map(),
      inject: () => 1,
      onScheduleFiberRoot: () => {},
      onCommitFiberRoot: (_id: number, root: { current: Fiber }) => walk(root.current),
      onPostCommitFiberRoot: () => {},
      onCommitFiberUnmount: () => {},
      checkDCE: () => {},
    };
  });
}

/** Zählt die Renders während `action` (plus Ausklingen) und gibt sie aus. */
async function measure(page: Page, label: string, action: () => Promise<void>): Promise<number> {
  await page.evaluate(() => {
    const s = window.__renderCounts!;
    s.on = true;
    s.total = 0;
    s.byName = {};
  });
  await action();
  await page.waitForTimeout(800);
  const stats = await page.evaluate(() => {
    const s = window.__renderCounts!;
    s.on = false;
    return { total: s.total, byName: s.byName };
  });
  const byName = Object.entries(stats.byName)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n}:${c}`)
    .join(" ");
  console.log(`[121] Renders ${label}: ${stats.total} — ${byName}`);
  return stats.total;
}

test("Neurendern zählen: Wand-Änderung, Zoom- und Zeiger-Schritt", async ({ page }) => {
  await installCounter(page);
  await startNewProject(page);
  await openSample(page);
  await openTab(page, "Elemente");
  await elementRows(page).filter({ hasText: "W1" }).click();
  await expect(page.getByText("Auswahl: 1 Wand")).toBeVisible();
  const top = page.locator(".objinfo-wall-anchor").first();
  await top.getByRole("button", { name: "Eigene" }).click();
  const field = top.getByLabel("Eigene Höhe");
  await field.fill("3.2");
  await page.waitForTimeout(500);

  // Genau eine Op (Wand-Oberkante).
  const edit = await measure(page, "je Wand-Änderung", async () => {
    await field.press("Enter");
    await expect(page.getByText("Höhe").locator("..").filter({ hasText: "3.20 m" })).toBeVisible();
  });
  await blurFocus(page);

  // Ein Mausrad-Schritt im Grundriss (ändert nur den Live-Massstab).
  const box = (await page.locator("svg.plan-svg").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(300);
  const zoom = await measure(page, "je Zoom-Schritt", async () => {
    await page.mouse.wheel(0, -120);
  });

  // Zeigerbewegung über den Grundriss (Fang/Koordinaten-Anzeige), 5 Schritte.
  const pointer = await measure(page, "je 5 Zeiger-Schritte", async () => {
    for (let k = 1; k <= 5; k++) await page.mouse.move(box.x + box.width / 2 + k * 7, box.y + box.height / 2 + k * 5);
  });

  expect(edit, "Renders je Wand-Änderung").toBeLessThan(90);
  expect(zoom, "Renders je Zoom-Schritt").toBeLessThan(25);
  expect(pointer, "Renders je 5 Zeiger-Schritte").toBeLessThan(40);
});

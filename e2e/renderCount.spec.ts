// [121] Neurendern messen: wie viele React-Komponenten rendern bei EINER Wand-Änderung (Objekt-Info,
// Musterhaus)? Gezählt über einen schlanken DevTools-Haken (`__REACT_DEVTOOLS_GLOBAL_HOOK__`, den React
// auch im Produktions-Build bedient) — ohne Produktcode. Eine Komponente zählt, wenn sich ihre
// Props oder ihr Hook-Zustand seit dem letzten Commit geändert haben (= sie hat gerendert).
import { blurFocus, elementRows, expect, openSample, openTab, startNewProject, test } from "./app";

declare global {
  interface Window {
    __renderCounts?: { on: boolean; total: number; byName: Record<string, number> };
  }
}

test("Wand-Änderung: Neurendern zählen", async ({ page }) => {
  await page.addInitScript(() => {
    const stats = { on: false, total: 0, byName: {} as Record<string, number> };
    window.__renderCounts = stats;
    const seen = new WeakMap<object, { p: unknown; s: unknown }>();
    // Funktions-, Klassen-, forwardRef-, memo-Komponenten (React-18-Fiber-Tags).
    const COMPOSITE = new Set([0, 1, 11, 14, 15]);
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

  // Messen: genau eine Op (Wand-Oberkante), dann ausklingen lassen.
  await page.evaluate(() => {
    const s = window.__renderCounts!;
    s.on = true;
    s.total = 0;
    s.byName = {};
  });
  await field.press("Enter");
  await expect(page.getByText("Höhe").locator("..").filter({ hasText: "3.20 m" })).toBeVisible();
  await page.waitForTimeout(800);
  const stats = await page.evaluate(() => {
    const s = window.__renderCounts!;
    s.on = false;
    return { total: s.total, byName: s.byName };
  });
  await blurFocus(page);
  const byName = Object.entries(stats.byName)
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n}:${c}`)
    .join(" ");
  console.log(`[121] Renders je Wand-Änderung: ${stats.total} — ${byName}`);
  expect(stats.total).toBeGreaterThan(0);
});

// CSS-Custom-Property → RGB (für die GPU-Renderer).

/** Liest eine CSS-Custom-Property (z. B. "--sheet") als RGB[0..1] oder null. */
export function readCssColor(varName: string): [number, number, number] | null {
  if (typeof window === 'undefined') return null;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  let h = raw.startsWith('#') ? raw.slice(1) : raw;
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (h.length < 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return [r / 255, g / 255, b / 255];
}

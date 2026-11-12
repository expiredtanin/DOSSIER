// Schriftdateien für den GPU-Glyphen-Pass ([226]): render2d zeichnet Texte mit der gebündelten Familie der
// Zeile (Szenenformat: Kennung = Index in `TEXT_FONTS` + 1, 0 = Inter) und fordert die Dateien lazy an
// (`needed_fonts`, Schlüssel = Familie << 8 | Schnitt, Bit 0 fett, Bit 1 kursiv). Hier: Schlüssel → URL → Bytes.
// Die Dateien sind dieselben WOFF2 wie im CSS (`public/fonts`, `fonts.css`); render2d entpackt sie selbst.

import { TEXT_FONTS } from "./fontList";

export const FONT_STYLE_BOLD = 1;
export const FONT_STYLE_ITALIC = 2;

/** `Familie << 8 | Schnitt` → URL der WOFF2-Datei (`null` für Inter/unbekannte Kennung). */
export function fontFileUrl(key: number): string | null {
  const family = key >>> 8;
  const style = key & 0xff;
  const name = family >= 2 ? TEXT_FONTS[family - 1] : undefined;
  if (!name) return null;
  const slug = name.toLowerCase().replace(/\s+/g, "-");
  const weight = style & FONT_STYLE_BOLD ? 700 : 400;
  const slant = style & FONT_STYLE_ITALIC ? "italic" : "normal";
  return `/fonts/${slug}/${slug}-${weight}-${slant}.woff2`;
}

const cache = new Map<number, Promise<Uint8Array | null>>();

/**
 * Bytes der Schriftdatei zu `key` laden (je Schlüssel einmal, auch bei Fehlschlag). `null` = es gibt keine
 * (404, Netz-/Dateifehler): der Pass bleibt dann bei der Ersatz-Variante bzw. Inter. Lokale App-Dateien,
 * kein Netzabruf nach aussen (daher `fetch` statt `netFetch`).
 */
export function loadFontFile(key: number, fetchFn: typeof fetch = fetch): Promise<Uint8Array | null> {
  let p = cache.get(key);
  if (!p) {
    const url = fontFileUrl(key);
    p = url
      ? fetchFn(url).then(
          async (r) => (r.ok ? new Uint8Array(await r.arrayBuffer()) : null),
          () => null,
        )
      : Promise.resolve(null);
    cache.set(key, p);
  }
  return p;
}

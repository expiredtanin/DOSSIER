// Farbraum-Hilfsfunktionen (Hex↔RGB↔CMYK) + eine kuratierte RAL-Classic-
// Auswahl — Grundlage für den Mischer/die Paletten im Farbfeld
// (`ui/ColorMixer.tsx`, `ui/FreeColorPicker.tsx`). Reine Konvertierungen,
// keine Bibliothek.
//
// CMYK ist hier eine VEREINFACHTE Bildschirm-Umrechnung (naive R/G/B↔C/M/Y/K-
// Formel ohne ICC-Profil/Druckkalibrierung) — für die Mischer-Vorschau am
// Bildschirm ausreichend, aber NICHT farbverbindlich für den Druck (dafür
// bräuchte es echtes Farbmanagement, das diese App nicht betreibt).
//
// Bezeichner englisch, Kommentare deutsch (CONVENTIONS.md).

export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Cmyk {
  c: number;
  m: number;
  y: number;
  k: number;
}

/** "#rrggbb" oder "#rgb" → {r,g,b} (0..255). Ungültige Eingaben ergeben Schwarz. */
export function hexToRgb(hex: string): Rgb {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  if (full.length !== 6 || Number.isNaN(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** {r,g,b} (0..255, wird geklammert) → "#rrggbb". */
export function rgbToHex({ r, g, b }: Rgb): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const toHex = (v: number) => clamp(v).toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** RGB (0..255) → CMYK (0..100, gerundet). Reine Bildschirm-Näherung, s. Modul-Kommentar. */
export function rgbToCmyk({ r, g, b }: Rgb): Cmyk {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const k = 1 - Math.max(rn, gn, bn);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  const c = (1 - rn - k) / (1 - k);
  const m = (1 - gn - k) / (1 - k);
  const y = (1 - bn - k) / (1 - k);
  return {
    c: Math.round(c * 100),
    m: Math.round(m * 100),
    y: Math.round(y * 100),
    k: Math.round(k * 100),
  };
}

/** CMYK (0..100) → RGB (0..255, unklammert — Aufrufer nutzt i. d. R. {@link rgbToHex}, das klammert). */
export function cmykToRgb({ c, m, y, k }: Cmyk): Rgb {
  const cn = c / 100;
  const mn = m / 100;
  const yn = y / 100;
  const kn = k / 100;
  return {
    r: 255 * (1 - cn) * (1 - kn),
    g: 255 * (1 - mn) * (1 - kn),
    b: 255 * (1 - yn) * (1 - kn),
  };
}

/** Farbton 0..360, Sättigung/Helligkeit 0..100 (UI-Bereiche, nicht 0..1). */
export interface Hsl {
  h: number;
  s: number;
  l: number;
}
/** Farbton 0..360, Sättigung/Hellwert 0..100 (HSV/HSB). */
export interface Hsv {
  h: number;
  s: number;
  v: number;
}

/**
 * RGB → HSL. Bei unbunten Farben (Grau/Schwarz/Weiss) ist der Farbton
 * mathematisch UNDEFINIERT und wird hier 0 — die UI hält den zuletzt
 * eingestellten Farbton deshalb in einem eigenen Puffer, sonst würde der
 * Regler beim Ziehen nach Schwarz/Weiss auf Rot zurückspringen
 * (s. `ui/ColorMixer.tsx`).
 */
export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

/** HSL → RGB (Kanäle 0..255, ungerundet — Aufrufer nutzt i. d. R. {@link rgbToHex}). */
export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sn = s / 100;
  const ln = l / 100;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = ln - c / 2;
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

/** RGB → HSV/HSB (Farbton bei unbunten Farben 0, s. {@link rgbToHsl}). */
export function rgbToHsv({ r, g, b }: Rgb): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return {
    h: Math.round(h),
    s: Math.round((max === 0 ? 0 : d / max) * 100),
    v: Math.round(max * 100),
  };
}

/** HSV/HSB → RGB (Kanäle 0..255, ungerundet). */
export function hsvToRgb({ h, s, v }: Hsv): Rgb {
  const sn = s / 100;
  const vn = v / 100;
  const c = vn * sn;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  const m = vn - c;
  return { r: (r1 + m) * 255, g: (g1 + m) * 255, b: (b1 + m) * 255 };
}

export interface NamedColor {
  name: string;
  hex: string;
}

/**
 * Tango-Palette (freedesktop.org Tango Desktop Project) — die klassische,
 * offen lizenzierte (Public Domain) Grafik-/Icon-Palette, die u. a. Inkscape
 * lange Zeit als Standardpalette mitgeliefert hat und die auch in GIMP/
 * Scribus als Grundpalette auftaucht. 9 Farbfamilien × 3 Helligkeitsstufen
 * (hell/mittel/dunkel) — anders als RAL für flächige Grafik/Illustration
 * gedacht, nicht für Bauteil-/Fassadenfarben. Werte sind die kanonischen,
 * überall identisch kursierenden Tango-Hex-Codes (keine Näherung wie bei
 * RAL — dies IST die digitale Referenz, kein physisches Muster).
 */
export const TANGO_PALETTE: NamedColor[] = [
  { name: "Butter hell", hex: "#FCE94F" },
  { name: "Butter", hex: "#EDD400" },
  { name: "Butter dunkel", hex: "#C4A000" },
  { name: "Orange hell", hex: "#FCAF3E" },
  { name: "Orange", hex: "#F57900" },
  { name: "Orange dunkel", hex: "#CE5C00" },
  { name: "Chocolate hell", hex: "#E9B96E" },
  { name: "Chocolate", hex: "#C17D11" },
  { name: "Chocolate dunkel", hex: "#8F5902" },
  { name: "Chameleon hell", hex: "#8AE234" },
  { name: "Chameleon", hex: "#73D216" },
  { name: "Chameleon dunkel", hex: "#4E9A06" },
  { name: "Sky Blue hell", hex: "#729FCF" },
  { name: "Sky Blue", hex: "#3465A4" },
  { name: "Sky Blue dunkel", hex: "#204A87" },
  { name: "Plum hell", hex: "#AD7FA8" },
  { name: "Plum", hex: "#75507B" },
  { name: "Plum dunkel", hex: "#5C3566" },
  { name: "Scarlet Red hell", hex: "#EF2929" },
  { name: "Scarlet Red", hex: "#CC0000" },
  { name: "Scarlet Red dunkel", hex: "#A40000" },
  { name: "Aluminium 1", hex: "#EEEEEC" },
  { name: "Aluminium 2", hex: "#D3D7CF" },
  { name: "Aluminium 3", hex: "#BABDB6" },
  { name: "Aluminium 4", hex: "#888A85" },
  { name: "Aluminium 5", hex: "#555753" },
  { name: "Aluminium 6", hex: "#2E3436" },
];

/**
 * Material-Design-Palette (Google, offen dokumentiert/Apache-Doku-Lizenz) —
 * je Farbfamilie die drei Referenz-Stufen 100/500/900 (hell/Basis/dunkel,
 * dieselbe Hell/Basis/Dunkel-Logik wie {@link TANGO_PALETTE}) statt der
 * vollen 10-Stufen-Skala jeder Familie — deckt die kanonischen, überall
 * identisch kursierenden Werte ab, ohne 190 Einzelwerte aus dem Gedächtnis
 * zu rekonstruieren. Für flächige UI-/Grafikfarben, kein Bauteilbezug.
 */
export const MATERIAL_PALETTE: NamedColor[] = [
  { name: "Red 100", hex: "#FFCDD2" },
  { name: "Red 500", hex: "#F44336" },
  { name: "Red 900", hex: "#B71C1C" },
  { name: "Pink 100", hex: "#F8BBD0" },
  { name: "Pink 500", hex: "#E91E63" },
  { name: "Pink 900", hex: "#880E4F" },
  { name: "Purple 100", hex: "#E1BEE7" },
  { name: "Purple 500", hex: "#9C27B0" },
  { name: "Purple 900", hex: "#4A148C" },
  { name: "Deep Purple 100", hex: "#D1C4E9" },
  { name: "Deep Purple 500", hex: "#673AB7" },
  { name: "Deep Purple 900", hex: "#311B92" },
  { name: "Indigo 100", hex: "#C5CAE9" },
  { name: "Indigo 500", hex: "#3F51B5" },
  { name: "Indigo 900", hex: "#1A237E" },
  { name: "Blue 100", hex: "#BBDEFB" },
  { name: "Blue 500", hex: "#2196F3" },
  { name: "Blue 900", hex: "#0D47A1" },
  { name: "Light Blue 100", hex: "#B3E5FC" },
  { name: "Light Blue 500", hex: "#03A9F4" },
  { name: "Light Blue 900", hex: "#01579B" },
  { name: "Cyan 100", hex: "#B2EBF2" },
  { name: "Cyan 500", hex: "#00BCD4" },
  { name: "Cyan 900", hex: "#006064" },
  { name: "Teal 100", hex: "#B2DFDB" },
  { name: "Teal 500", hex: "#009688" },
  { name: "Teal 900", hex: "#004D40" },
  { name: "Green 100", hex: "#C8E6C9" },
  { name: "Green 500", hex: "#4CAF50" },
  { name: "Green 900", hex: "#1B5E20" },
  { name: "Light Green 100", hex: "#DCEDC8" },
  { name: "Light Green 500", hex: "#8BC34A" },
  { name: "Light Green 900", hex: "#33691E" },
  { name: "Lime 100", hex: "#F0F4C3" },
  { name: "Lime 500", hex: "#CDDC39" },
  { name: "Lime 900", hex: "#827717" },
  { name: "Yellow 100", hex: "#FFF9C4" },
  { name: "Yellow 500", hex: "#FFEB3B" },
  { name: "Yellow 900", hex: "#F57F17" },
  { name: "Amber 100", hex: "#FFECB3" },
  { name: "Amber 500", hex: "#FFC107" },
  { name: "Amber 900", hex: "#FF6F00" },
  { name: "Orange 100", hex: "#FFE0B2" },
  { name: "Orange 500", hex: "#FF9800" },
  { name: "Orange 900", hex: "#E65100" },
  { name: "Deep Orange 100", hex: "#FFCCBC" },
  { name: "Deep Orange 500", hex: "#FF5722" },
  { name: "Deep Orange 900", hex: "#BF360C" },
  { name: "Brown 100", hex: "#D7CCC8" },
  { name: "Brown 500", hex: "#795548" },
  { name: "Brown 900", hex: "#3E2723" },
  { name: "Grey 100", hex: "#F5F5F5" },
  { name: "Grey 500", hex: "#9E9E9E" },
  { name: "Grey 900", hex: "#212121" },
  { name: "Blue Grey 100", hex: "#CFD8DC" },
  { name: "Blue Grey 500", hex: "#607D8B" },
  { name: "Blue Grey 900", hex: "#263238" },
];

export interface RalColor {
  /** Nummernteil ohne "RAL"-Präfix, z. B. "9016". */
  code: string;
  /** Offizieller deutscher Name, z. B. "Verkehrsweiss". */
  name: string;
  /** NÄHERUNGSWERT (s. Modul-Kommentar) — nicht farbverbindlich. */
  hex: string;
}

/**
 * Kuratierte Auswahl gängiger RAL-Classic-Farben (Fassaden-/Bauteilfarben,
 * die in der Praxis am häufigsten vorkommen — Vollton- wie Metallic-Reihe
 * ausgenommen). Die Hex-Werte sind NÄHERUNGEN, wie sie in praktisch jeder
 * frei verfügbaren RAL-Umrechnungstabelle kursieren: RAL selbst ist ein
 * physisches, lizenziertes Farbmuster-System (Fächer/Fächerkarte); eine
 * bildschirm-exakte, farbverbindliche Wiedergabe ist ohne kalibriertes
 * ICC-Profil UND die offizielle Karte grundsätzlich nicht möglich. Für die
 * Bildschirm-Orientierung im Stift-/Farbfeld-Editor ausreichend, für die
 * verbindliche Ausschreibung/Bemusterung gilt weiterhin die echte RAL-Karte
 * (s. Hinweistext im UI, `pen.ralHint`).
 */
export const RAL_CLASSIC: RalColor[] = [
  { code: "1000", name: "Grünbeige", hex: "#BEBD7F" },
  { code: "1001", name: "Beige", hex: "#C2B078" },
  { code: "1002", name: "Sandgelb", hex: "#C6A664" },
  { code: "1003", name: "Signalgelb", hex: "#E5BE01" },
  { code: "1004", name: "Goldgelb", hex: "#CDA434" },
  { code: "1005", name: "Honiggelb", hex: "#A98307" },
  { code: "1006", name: "Maisgelb", hex: "#E4A010" },
  { code: "1007", name: "Narzissengelb", hex: "#DC9D00" },
  { code: "1011", name: "Braunbeige", hex: "#8A6642" },
  { code: "1013", name: "Perlweiss", hex: "#EAE6CA" },
  { code: "1014", name: "Elfenbein", hex: "#DED6B1" },
  { code: "1015", name: "Hellelfenbein", hex: "#E6D690" },
  { code: "1017", name: "Safrangelb", hex: "#F6A950" },
  { code: "1019", name: "Graubeige", hex: "#A48F7A" },
  { code: "1021", name: "Rapsgelb", hex: "#F7BA0B" },
  { code: "1023", name: "Verkehrsgelb", hex: "#FAD201" },
  { code: "1028", name: "Melonengelb", hex: "#E2A300" },
  { code: "1032", name: "Ginstergelb", hex: "#D6AE01" },
  { code: "2000", name: "Gelborange", hex: "#ED760E" },
  { code: "2001", name: "Rotorange", hex: "#C93C20" },
  { code: "2002", name: "Blutorange", hex: "#CB2821" },
  { code: "2003", name: "Pastellorange", hex: "#FF7514" },
  { code: "2004", name: "Reinorange", hex: "#F44611" },
  { code: "2009", name: "Verkehrsorange", hex: "#E25303" },
  { code: "2010", name: "Signalorange", hex: "#D4652F" },
  { code: "2011", name: "Tieforange", hex: "#E05C1E" },
  { code: "3000", name: "Feuerrot", hex: "#AB2524" },
  { code: "3001", name: "Signalrot", hex: "#A52019" },
  { code: "3002", name: "Karminrot", hex: "#A2231D" },
  { code: "3003", name: "Rubinrot", hex: "#9B111E" },
  { code: "3004", name: "Purpurrot", hex: "#75151E" },
  { code: "3005", name: "Weinrot", hex: "#5E2129" },
  { code: "3007", name: "Schwarzrot", hex: "#412227" },
  { code: "3009", name: "Oxidrot", hex: "#642424" },
  { code: "3011", name: "Braunrot", hex: "#781F19" },
  { code: "3013", name: "Tomatenrot", hex: "#A12312" },
  { code: "3018", name: "Erdbeerrot", hex: "#D53032" },
  { code: "3020", name: "Verkehrsrot", hex: "#CC0605" },
  { code: "3022", name: "Lachsrot", hex: "#D95030" },
  { code: "3027", name: "Himbeerrot", hex: "#B32821" },
  { code: "4001", name: "Rotlila", hex: "#6D3F5B" },
  { code: "4002", name: "Rotviolett", hex: "#922B3E" },
  { code: "4003", name: "Erikaviolett", hex: "#DE4C8A" },
  { code: "4005", name: "Blaulila", hex: "#6C4675" },
  { code: "4006", name: "Verkehrspurpur", hex: "#A03472" },
  { code: "4007", name: "Purpurviolett", hex: "#4A192C" },
  { code: "4008", name: "Signalviolett", hex: "#924E7D" },
  { code: "4009", name: "Pastellviolett", hex: "#8673A1" },
  { code: "5000", name: "Violettblau", hex: "#354D73" },
  { code: "5001", name: "Grünblau", hex: "#1F3438" },
  { code: "5002", name: "Ultramarinblau", hex: "#20214F" },
  { code: "5003", name: "Saphirblau", hex: "#1D1E33" },
  { code: "5005", name: "Signalblau", hex: "#1E2460" },
  { code: "5007", name: "Brillantblau", hex: "#3E5F8A" },
  { code: "5008", name: "Graublau", hex: "#26252D" },
  { code: "5009", name: "Azurblau", hex: "#025669" },
  { code: "5010", name: "Enzianblau", hex: "#0E294B" },
  { code: "5011", name: "Stahlblau", hex: "#231A24" },
  { code: "5012", name: "Lichtblau", hex: "#3B83BD" },
  { code: "5013", name: "Kobaltblau", hex: "#1E213D" },
  { code: "5014", name: "Taubenblau", hex: "#606E8C" },
  { code: "5015", name: "Himmelblau", hex: "#2271B3" },
  { code: "5017", name: "Verkehrsblau", hex: "#063971" },
  { code: "5018", name: "Türkisblau", hex: "#3F888F" },
  { code: "5019", name: "Capriblau", hex: "#1B5583" },
  { code: "5020", name: "Ozeanblau", hex: "#1D334A" },
  { code: "5021", name: "Wasserblau", hex: "#256D7B" },
  { code: "5022", name: "Nachtblau", hex: "#252850" },
  { code: "5024", name: "Pastellblau", hex: "#5D9B9B" },
  { code: "6000", name: "Patinagrün", hex: "#327662" },
  { code: "6001", name: "Smaragdgrün", hex: "#287233" },
  { code: "6002", name: "Laubgrün", hex: "#2D572C" },
  { code: "6003", name: "Olivgrün", hex: "#424632" },
  { code: "6004", name: "Blaugrün", hex: "#1F3A3D" },
  { code: "6005", name: "Moosgrün", hex: "#2F4538" },
  { code: "6006", name: "Grauoliv", hex: "#3E3B32" },
  { code: "6007", name: "Flaschengrün", hex: "#343B29" },
  { code: "6009", name: "Tannengrün", hex: "#31372B" },
  { code: "6010", name: "Grasgrün", hex: "#35682D" },
  { code: "6011", name: "Resedagrün", hex: "#587246" },
  { code: "6012", name: "Schwarzgrün", hex: "#343E40" },
  { code: "6013", name: "Schilfgrün", hex: "#6C7156" },
  { code: "6014", name: "Gelboliv", hex: "#47402E" },
  { code: "6015", name: "Schwarzoliv", hex: "#3B3C36" },
  { code: "6016", name: "Türkisgrün", hex: "#1E5945" },
  { code: "6017", name: "Maigrün", hex: "#4C9141" },
  { code: "6018", name: "Gelbgrün", hex: "#57A639" },
  { code: "6019", name: "Weissgrün", hex: "#BDECB6" },
  { code: "6020", name: "Chromoxidgrün", hex: "#2E3A23" },
  { code: "6021", name: "Blassgrün", hex: "#89AC76" },
  { code: "6024", name: "Verkehrsgrün", hex: "#008351" },
  { code: "6025", name: "Farngrün", hex: "#4D5D53" },
  { code: "6026", name: "Opalgrün", hex: "#005D52" },
  { code: "6027", name: "Lichtgrün", hex: "#81C0BB" },
  { code: "6028", name: "Kieferngrün", hex: "#2D4A34" },
  { code: "6029", name: "Minzgrün", hex: "#007243" },
  { code: "6032", name: "Signalgrün", hex: "#0F8558" },
  { code: "6033", name: "Minttürkis", hex: "#478A84" },
  { code: "6034", name: "Pastelltürkis", hex: "#7FB0B2" },
  { code: "7000", name: "Fehgrau", hex: "#7E8B92" },
  { code: "7001", name: "Silbergrau", hex: "#8F999F" },
  { code: "7002", name: "Olivgrau", hex: "#817F68" },
  { code: "7003", name: "Moosgrau", hex: "#7A7B6D" },
  { code: "7004", name: "Signalgrau", hex: "#9EA0A1" },
  { code: "7005", name: "Mausgrau", hex: "#6B716F" },
  { code: "7006", name: "Beigegrau", hex: "#756F61" },
  { code: "7008", name: "Khakigrau", hex: "#6A5F31" },
  { code: "7009", name: "Grüngrau", hex: "#4D5645" },
  { code: "7010", name: "Zeltgrau", hex: "#4C514A" },
  { code: "7011", name: "Eisengrau", hex: "#434B4D" },
  { code: "7012", name: "Basaltgrau", hex: "#4E5754" },
  { code: "7013", name: "Braungrau", hex: "#4E5541" },
  { code: "7015", name: "Schiefergrau", hex: "#434750" },
  { code: "7016", name: "Anthrazitgrau", hex: "#293133" },
  { code: "7021", name: "Schwarzgrau", hex: "#23282B" },
  { code: "7022", name: "Umbragrau", hex: "#332F2C" },
  { code: "7023", name: "Betongrau", hex: "#686C5E" },
  { code: "7024", name: "Graphitgrau", hex: "#474A51" },
  { code: "7026", name: "Granitgrau", hex: "#2F353B" },
  { code: "7030", name: "Steingrau", hex: "#8B8C7A" },
  { code: "7031", name: "Blaugrau", hex: "#474B4E" },
  { code: "7032", name: "Kieselgrau", hex: "#B8B799" },
  { code: "7033", name: "Zementgrau", hex: "#7D8471" },
  { code: "7034", name: "Gelbgrau", hex: "#92926F" },
  { code: "7035", name: "Lichtgrau", hex: "#D7D7D7" },
  { code: "7036", name: "Platingrau", hex: "#969992" },
  { code: "7037", name: "Staubgrau", hex: "#7D7F7D" },
  { code: "7038", name: "Achatgrau", hex: "#B5B8B1" },
  { code: "7039", name: "Quarzgrau", hex: "#6C6960" },
  { code: "7040", name: "Fenstergrau", hex: "#9DA1AA" },
  { code: "7042", name: "Verkehrsgrau A", hex: "#8D948D" },
  { code: "7043", name: "Verkehrsgrau B", hex: "#4E5452" },
  { code: "7044", name: "Seidengrau", hex: "#CAC4B0" },
  { code: "7045", name: "Telegrau 1", hex: "#909090" },
  { code: "7046", name: "Telegrau 2", hex: "#82898E" },
  { code: "7047", name: "Telegrau 4", hex: "#D0D0D0" },
  { code: "7048", name: "Perlgrau", hex: "#898176" },
  { code: "8000", name: "Grünbraun", hex: "#826C34" },
  { code: "8001", name: "Ockerbraun", hex: "#955F20" },
  { code: "8002", name: "Signalbraun", hex: "#6C3B2A" },
  { code: "8003", name: "Lehmbraun", hex: "#734222" },
  { code: "8004", name: "Kupferbraun", hex: "#8E402A" },
  { code: "8007", name: "Rehbraun", hex: "#59351F" },
  { code: "8008", name: "Olivbraun", hex: "#6F4F28" },
  { code: "8011", name: "Nussbraun", hex: "#5A3A29" },
  { code: "8012", name: "Rotbraun", hex: "#592321" },
  { code: "8014", name: "Sepiabraun", hex: "#382C1E" },
  { code: "8015", name: "Kastanienbraun", hex: "#633A34" },
  { code: "8016", name: "Mahagonibraun", hex: "#4C2F27" },
  { code: "8017", name: "Schokoladenbraun", hex: "#442F29" },
  { code: "8019", name: "Graubraun", hex: "#3D3635" },
  { code: "8022", name: "Schwarzbraun", hex: "#212121" },
  { code: "8023", name: "Orangebraun", hex: "#A65E2E" },
  { code: "8024", name: "Beigebraun", hex: "#79553D" },
  { code: "8025", name: "Blassbraun", hex: "#755C48" },
  { code: "8028", name: "Terrabraun", hex: "#4E3B31" },
  { code: "9001", name: "Cremeweiss", hex: "#FDF4E3" },
  { code: "9002", name: "Grauweiss", hex: "#E7EBDA" },
  { code: "9003", name: "Signalweiss", hex: "#F4F4F4" },
  { code: "9004", name: "Signalschwarz", hex: "#282828" },
  { code: "9005", name: "Tiefschwarz", hex: "#0A0A0A" },
  { code: "9006", name: "Weissaluminium", hex: "#A5A5A5" },
  { code: "9007", name: "Graualuminium", hex: "#8F8F8F" },
  { code: "9010", name: "Reinweiss", hex: "#FFFFFF" },
  { code: "9011", name: "Graphitschwarz", hex: "#1C1C1C" },
  { code: "9016", name: "Verkehrsweiss", hex: "#F6F6F6" },
  { code: "9017", name: "Verkehrsschwarz", hex: "#1E1E1E" },
  { code: "9018", name: "Papyrusweiss", hex: "#D7D7D7" },
];

#!/usr/bin/env python3
"""Vorschubbreiten der gebuendelten Schriften -> src-tauri/core/src/text_metrics.rs ([226]).

Liest public/fonts/<slug>/<slug>-<400|700>-<normal|italic>.woff2 (Reihenfolge der Familien wie
src/text/fontList.ts, Kennung = Index + 1; Inter bleibt bei den Tabellen in text_layout.rs) und schreibt
die Breiten (1/1000 em, Tabelle `hmtx`) fuer U+0020-U+007E, U+00A0-U+00FF und einige Satzzeichen.
Aufruf: python3 scripts/gen-text-metrics.py   (braucht fontTools + brotli)
"""
import re, os
from fontTools.ttLib import TTFont

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(root, "src/text/fontList.ts")).read()
names = re.findall(r'^\s+"([^"]+)",$', src.split("TEXT_FONTS: string[] = [")[1].split("];")[0], re.M)
CHARS = list(range(0x20, 0x7F)) + list(range(0xA0, 0x100)) + [0x2013, 0x2014, 0x2026, 0x20AC, 0x2018, 0x2019, 0x201A, 0x201C, 0x201D, 0x201E]

def widths(path):
    f = TTFont(path)
    cmap = f.getBestCmap()
    hmtx = f["hmtx"]
    upem = f["head"].unitsPerEm
    out = []
    for c in CHARS:
        g = cmap.get(c)
        out.append(round(hmtx[g][0] * 1000 / upem) if g else 0)  # 0 = Zeichen fehlt in der Schrift
    return out

rows = []
for i, name in enumerate(names):
    if i == 0:
        continue  # Inter: Tabellen in text_layout.rs
    slug = name.lower().replace(" ", "-")
    for style in range(4):  # Bit 0 fett, Bit 1 kursiv
        w = "700" if style & 1 else "400"
        it = "italic" if style & 2 else "normal"
        p = os.path.join(root, f"public/fonts/{slug}/{slug}-{w}-{it}.woff2")
        if not os.path.exists(p):  # z. B. Manrope kursiv: wie aufrecht (so zeichnet auch der Glyphen-Pass)
            p = os.path.join(root, f"public/fonts/{slug}/{slug}-{w}-normal.woff2")
        rows.append((name, style, widths(p)))

out = ["// ERZEUGT von scripts/gen-text-metrics.py ([226]) — nicht von Hand aendern.",
       "// Vorschubbreiten (1/1000 em) der gebuendelten Schriften ausser Inter (public/fonts, SIL OFL 1.1, s. NOTICE):",
       "// Zeile = (Kennung - 2) * 4 + Schnitt (Bit 0 fett, Bit 1 kursiv), Spalten = `CHARS`; 0 = Zeichen fehlt.",
       f"pub const N_CHARS: usize = {len(CHARS)};",
       "/// Zeichen der Spalten: U+0020-007E, U+00A0-00FF, dann Satzzeichen.",
       "pub const EXTRA_CHARS: [u32; 10] = [0x2013, 0x2014, 0x2026, 0x20AC, 0x2018, 0x2019, 0x201A, 0x201C, 0x201D, 0x201E];",
       f"pub static WIDTHS: [[u16; N_CHARS]; {len(rows)}] = ["]
for name, style, w in rows:
    out.append(f"    // {name}, Schnitt {style}")
    out.append("    [" + ", ".join(map(str, w)) + "],")
out.append("];")
open(os.path.join(root, "src-tauri/core/src/text_metrics.rs"), "w").write("\n".join(out) + "\n")
print(len(rows), "Tabellen")

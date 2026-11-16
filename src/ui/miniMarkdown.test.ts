import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInline, parseMarkdown } from "./miniMarkdown";

describe("miniMarkdown [263]", () => {
  it("Inline: fett, kursiv, Code, Rest bleibt Text", () => {
    expect(parseInline("a **b** *c* `d` e*")).toEqual([
      { t: "text", s: "a " }, { t: "b", s: "b" }, { t: "text", s: " " }, { t: "i", s: "c" }, { t: "text", s: " " },
      { t: "code", s: "d" }, { t: "text", s: " e*" },
    ]);
  });
  it("Blöcke: Überschrift, Absatz über Zeilen, Listen mit Fortsetzung, Zitat, Bild, Linie", () => {
    const b = parseMarkdown("# T\n\nzeile eins\nzeile zwei\n\n1. a\n   weiter\n2. b\n\n- x\n\n> q\n> r\n\n![alt](p/a.png)\n\n---\n");
    expect(b.map((x) => x.t)).toEqual(["h", "p", "ol", "ul", "quote", "img", "hr"]);
    expect((b[1] as { inl: { s: string }[] }).inl[0]!.s).toBe("zeile eins zeile zwei");
    expect((b[2] as { items: unknown[][] }).items).toHaveLength(2);
    expect(b[5]).toEqual({ t: "img", alt: "alt", src: "p/a.png" });
  });
  it("die echte Kurzanleitung lässt sich lesen: Überschriften, Bilder, keine Rohzeichen", () => {
    const md = readFileSync(join(process.cwd(), "doc", "KURZANLEITUNG.md"), "utf8");
    const b = parseMarkdown(md);
    expect(b[0]).toMatchObject({ t: "h", level: 1 });
    expect(b.filter((x) => x.t === "h" && x.level === 2).length).toBeGreaterThanOrEqual(10);
    expect(b.filter((x) => x.t === "img").length).toBe(5);
    expect(JSON.stringify(b.filter((x) => x.t !== "img"))).not.toContain("**");
  });
});

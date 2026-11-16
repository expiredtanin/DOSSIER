// [263] Minimaler Markdown-Leser für die Kurzanleitung (doc/KURZANLEITUNG.md) im Hilfe-Dialog: Überschriften, Absätze,
// Listen (`-`, `1.`), Zitate, Trennlinie, Bilder und im Text **fett**, *kursiv*, `Code`. Mehr braucht das Dokument nicht;
// Tabellen/Codeblöcke gibt es dort nicht. Reine Funktion (Test `miniMarkdown.test.ts`), die Darstellung steht in
// `QuickGuideDialog.tsx` (kein dangerouslySetInnerHTML).

export type Inline = { t: "text" | "b" | "i" | "code"; s: string };
export type Block =
  | { t: "h"; level: 1 | 2 | 3; inl: Inline[] }
  | { t: "p"; inl: Inline[] }
  | { t: "quote"; inl: Inline[] }
  | { t: "ul" | "ol"; items: Inline[][] }
  | { t: "img"; alt: string; src: string }
  | { t: "hr" };

/** Zerlegt eine Zeile in Text-, Fett-, Kursiv- und Code-Stücke. Unabgeschlossene Zeichen bleiben Text. */
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;
  let last = 0;
  for (const m of src.matchAll(re)) {
    if (m.index! > last) out.push({ t: "text", s: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ t: "code", s: m[1] });
    else if (m[2] !== undefined) out.push({ t: "b", s: m[2] });
    else out.push({ t: "i", s: m[3]! });
    last = m.index! + m[0].length;
  }
  if (last < src.length) out.push({ t: "text", s: src.slice(last) });
  return out;
}

export function parseMarkdown(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let para: string[] = [];
  let quote: string[] = [];
  let list: { t: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (para.length) blocks.push({ t: "p", inl: parseInline(para.join(" ")) });
    if (quote.length) blocks.push({ t: "quote", inl: parseInline(quote.join(" ")) });
    if (list) blocks.push({ t: list.t, items: list.items.map(parseInline) });
    para = [];
    quote = [];
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if (!line.trim()) flush();
    else if ((m = line.match(/^(#{1,3})\s+(.*)$/))) {
      flush();
      blocks.push({ t: "h", level: m[1]!.length as 1 | 2 | 3, inl: parseInline(m[2]!) });
    } else if (/^-{3,}$/.test(line)) {
      flush();
      blocks.push({ t: "hr" });
    } else if ((m = line.match(/^!\[([^\]]*)\]\(([^)]+)\)$/))) {
      flush();
      blocks.push({ t: "img", alt: m[1]!, src: m[2]! });
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      if (!quote.length) flush();
      quote.push(m[1]!);
    } else if ((m = line.match(/^(?:([-*])|(\d+)\.)\s+(.*)$/))) {
      const kind = m[1] ? "ul" : "ol";
      if (!list || list.t !== kind) {
        flush();
        list = { t: kind, items: [] };
      }
      list.items.push(m[3]!);
    } else if (list && /^\s+\S/.test(raw)) {
      list.items[list.items.length - 1] += " " + line.trim(); // Fortsetzungszeile eines Listenpunkts
    } else {
      if (quote.length || list) flush();
      para.push(line.trim());
    }
  }
  flush();
  return blocks;
}

// PDF-Ebenen (Optional Content Groups, [80]): jsPDF kennt keine optionalen Inhalte. Wir schreiben sie
// minimal selbst — je Ebenenname EIN OCG-Objekt (gleiche Namen auf mehreren Seiten = eine in Acrobat
// schaltbare Ebene), der Inhalt steht zwischen `/OC /ocN BDC` … `EMC` im Seitenstrom, die Namen stehen im
// Ressourcen-Wörterbuch (`/Properties`), die Liste im Katalog (`/OCProperties`). Eingehängt über die
// Ereignisse von jsPDF (`putResources`, `putXobjectDict`, `putCatalog`); ohne benutzte Ebene schreibt
// nichts etwas ins PDF.

import type { jsPDF } from "jspdf";
import type { LayerCategory } from "../model/types";

export interface PdfLayers {
  /** Führt `fn` aus; was es ins PDF zeichnet, gehört zur Ebene `name` (Marken bleiben auch bei Fehlern ausgeglichen). */
  run<T>(name: string, fn: () => T | Promise<T>): Promise<T>;
  /** Bisher benutzte Ebenennamen in Reihenfolge. */
  names(): string[];
}

/** PDF-Textstring (UTF-16BE, hex) — Umlaute und alles ausserhalb ASCII bleiben lesbar. */
function pdfText(s: string): string {
  let hex = "FEFF";
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, "0");
  return `<${hex.toUpperCase()}>`;
}

/** Schaltet Ebenen für das Dokument frei; Aufrufer legen Inhalt mit `run` in Ebenen. */
export function enablePdfLayers(doc: jsPDF): PdfLayers {
  const names: string[] = [];
  const keys = new Map<string, string>(); // Name → Ressourcen-Schlüssel
  const oids = new Map<string, number>(); // Name → OCG-Objektnummer
  const internal = doc.internal as unknown as {
    write: (...s: string[]) => void;
    newObject: () => number;
    events: { subscribe: (topic: string, fn: () => void) => void };
  };

  internal.events.subscribe("putResources", () => {
    for (const n of names) {
      const oid = internal.newObject();
      internal.write(`<< /Type /OCG /Name ${pdfText(n)} >>`);
      internal.write("endobj");
      oids.set(n, oid);
    }
  });
  // Im XObject-Wörterbuch: dieses schliessen, `/Properties` öffnen — das schliessende `>>` setzt jsPDF.
  internal.events.subscribe("putXobjectDict", () => {
    if (names.length === 0) return;
    internal.write(">>");
    internal.write("/Properties <<");
    for (const n of names) {
      const oid = oids.get(n);
      if (oid !== undefined) internal.write(`/${keys.get(n)} ${oid} 0 R`);
    }
  });
  internal.events.subscribe("putCatalog", () => {
    if (names.length === 0) return;
    const refs = names.map((n) => `${oids.get(n)} 0 R`).join(" ");
    internal.write(`/OCProperties << /OCGs [${refs}] /D << /Order [${refs}] /ON [${refs}] /BaseState /ON >> >>`);
  });

  return {
    async run(name, fn) {
      let key = keys.get(name);
      if (!key) {
        key = `oc${names.length + 1}`;
        keys.set(name, key);
        names.push(name);
      }
      internal.write(`/OC /${key} BDC`);
      try {
        return await fn();
      } finally {
        internal.write("EMC");
      }
    },
    names: () => [...names],
  };
}

/**
 * PDF-Ebenen aus dem Kategorie-Baum: je Wurzel-Kategorie eine Gruppe mit ihren sichtbaren Codes (samt
 * Unterkategorien); sichtbare Codes ausserhalb des Baums landen in `otherName`. Leere Gruppen entfallen.
 */
export function categoryLayerGroups(
  layers: readonly LayerCategory[],
  visible: ReadonlySet<string>,
  otherName: string,
): { name: string; codes: Set<string> }[] {
  const out: { name: string; codes: Set<string> }[] = [];
  const known = new Set<string>();
  const walk = (c: LayerCategory, into: Set<string>) => {
    known.add(c.code);
    if (visible.has(c.code)) into.add(c.code);
    for (const k of c.children ?? []) walk(k, into);
  };
  for (const root of layers) {
    const codes = new Set<string>();
    walk(root, codes);
    if (codes.size > 0) out.push({ name: root.name, codes });
  }
  const rest = new Set([...visible].filter((c) => !known.has(c)));
  if (rest.size > 0) out.push({ name: otherName, codes: rest });
  return out;
}

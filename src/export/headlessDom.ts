// Minimales DOM für den Headless-Betrieb (dossier-cli, vitest in Node): `planToPrintSvg`/`sceneToPrintSvg`
// bauen ihr SVG über `document.createElementNS`. Im Browser gibt es das; in Node stellen wir für die Dauer des
// Aufrufs ein xmldom-Dokument bereit. Keine zweite Logik — dieselben Druck-Serializer, nur ein anderes DOM.

import { DOMImplementation, XMLSerializer } from "@xmldom/xmldom";

/** Führt `fn` mit einem `document` aus; ohne vorhandenes (Browser) wird ein xmldom-Dokument ein- und danach ausgehängt. */
export async function withHeadlessDom<T>(fn: () => Promise<T> | T): Promise<T> {
  const g = globalThis as { document?: unknown };
  if (g.document) return fn();
  g.document = new DOMImplementation().createDocument(null, null, null);
  try {
    return await fn();
  } finally {
    delete g.document;
  }
}

/** SVG-Element (Browser oder xmldom) als Text. */
export function serializeSvg(el: Element | SVGElement): string {
  return new XMLSerializer().serializeToString(el as never);
}

// Lesbare Fundstelle für den Anonymitäts-Dialog ([208]): der Kern liefert Bereich und Pfad
// (`Wärmedämmung.name`, `Plan.titleBlock.sheetName`); hier werden Elementart, Name und Feld daraus.
//
// Bezeichner englisch, Kommentare deutsch.

import { t } from "../i18n";

export interface PlaceParts {
  /** Elementart im Singular („Material“), leer wenn unbekannt. */
  kind: string;
  /** Name des Elements (ggf. mit Unterelement: „Plan › logo.png“). */
  item: string;
  /** Feld („Name“, „Blattname“); bei Orten ohne Pfad (Zusatztexte wie „Dateiname“) der Ort selbst. */
  field: string;
}

/** Zwischenschlüssel im Pfad, die ein Unterelement einleiten (Liste in einem Element). */
const NESTED = ["images", "layers", "children", "items", "rows"];

/** Übersetzung, oder der Fallback, wenn es den Schlüssel nicht gibt (`t` gibt dann den Schlüssel zurück). */
function tr(key: string, fallback: string): string {
  const s = t(key);
  return s === key ? fallback : s;
}

/** Zerlegt Bereich und Pfad in Elementart, Elementname und Feld. */
export function anonymityPlaceParts(area: string, place: string): PlaceParts {
  const kind = tr(`anonymity.item.${area}`, "");
  const cut = place.lastIndexOf(".");
  if (cut < 0) return { kind, item: "", field: place };
  const key = place.slice(cut + 1);
  let item = place.slice(0, cut);
  let field = /^\d+$/.test(key) ? `${tr("anonymity.part.index", "")} ${key}`.trim() : tr(`anonymity.field.${key}`, key);
  if (item.endsWith(".titleBlock")) {
    item = item.slice(0, -".titleBlock".length);
    field = `${tr("anonymity.part.titleBlock", "titleBlock")} · ${field}`;
  }
  for (const n of NESTED) item = item.split(`.${n}.`).join(" › ");
  return { kind, item, field };
}

// Ein Abschnitt des Berichtsmodells (`ReportSection` aus `export/areaReport.ts`) als Tabelle im Panel. Gemeinsam für die
// Flächentabelle (`AreaTableSection`) und den Wohnungsspiegel (`UnitsSection`): was hier steht, steht auch im Export.

import type { ReportSection } from "../export/areaReport";

export function ReportTable({ section: s }: { section: ReportSection }) {
  return (
    <div className="area-block">
      <div className="area-heading">{s.heading}</div>
      <div className="area-scroll">
        <table className={s.columns.length > 6 ? "area-table wide" : "area-table"}>
          <thead>
            <tr>
              {s.columns.map((c, i) => (
                <th key={i} className={i === 0 ? "" : "num"}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.rows.map((r, ri) => (
              <tr key={ri} className={r.total ? "total" : ""}>
                {r.cells.map((c, ci) =>
                  typeof c === "string" ? (
                    // Kurze Textzellen in Zahlenspalten (Strich, ja/nein) stehen wie die Zahlen rechts.
                    <td key={ci} data-label={ci > 0 ? s.columns[ci] : undefined} data-span={cardSpan(c, s.columns[ci])} className={ci > 0 && c.length <= 4 ? "num" : undefined}>
                      {c}
                    </td>
                  ) : (
                    <td key={ci} data-label={ci > 0 ? s.columns[ci] : undefined} data-span={cardSpan("", s.columns[ci])} className="num">
                      {c.n === null ? "–" : c.n.toFixed(c.d)}
                    </td>
                  ),
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Kartenansicht im schmalen Dock: lange Texte und lange Spaltenköpfe („Aussenraum m²“) belegen zwei bzw. drei Rasterspalten, damit nichts mitten im Wort bricht. */
function cardSpan(text: string, head: string | undefined): string | undefined {
  if (text.length > 22) return "3";
  return text.length > 9 || (head?.length ?? 0) > 9 ? "2" : undefined;
}

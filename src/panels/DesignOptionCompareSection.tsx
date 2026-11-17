// [272] Varianten-Vergleich im Flächenbilanz-Panel: Kennzahlen (GF, HNF, GV, Fussabdruck, AZ, ÜZ) und Kosten (Grobschätzung
// inkl. MwSt.) je Kombination der Variantensätze nebeneinander, Hauptkombination zuerst (Kern `design_options::compare`);
// mit CSV-Export. Nur mit Variantensätzen im Projekt; `renovation`: Umbau-Zustand wie die Kennzahlenleiste.

import { t } from "../i18n";
import { compareDesignOptions, compareDesignOptionsCsv, designOptionSets, exportProjectName, formatChf } from "../core";
import type { Project } from "../model/types";
import { downloadCsv } from "./downloadFile";
import { runWithAnonymityGate } from "../state/anonymityGate";

const fmt = (n: number, d = 1) => n.toLocaleString("de-CH", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Spaltenköpfe (übersetzt) für Tabelle und CSV. */
export function designOptionCompareHead(): string[] {
  return [t("designOption.compare.combination"), "GF m²", "HNF m²", "GV m³", t("designOption.compare.footprint"), "AZ", "ÜZ", t("designOption.compare.cost")];
}

export function DesignOptionCompareSection({ project, renovation = "" }: { project: Project; renovation?: string }) {
  if (!designOptionSets(project).length) return null;
  const rows = compareDesignOptions(project, renovation);
  if (!rows.length) return null;
  const head = designOptionCompareHead();
  const stem = `${exportProjectName(project) || "projekt"}-varianten`;
  const exportCsv = () => runWithAnonymityGate(project, [`${stem}.csv`], () => downloadCsv(`${stem}.csv`, compareDesignOptionsCsv(project, head, renovation)));
  const base = rows[0];
  const delta = (v: number, b: number, d: number) => (v === b ? "" : ` (${v > b ? "+" : "−"}${fmt(Math.abs(v - b), d)})`);
  return (
    <div className="kz-variants" data-testid="design-option-compare">
      <div className="balance-section-label">{t("designOption.compare.title")}</div>
      <div className="kz-variants-scroll">
        <table className="kz-variants-table">
          <thead>
            <tr>
              {head.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label} className={r.primary ? "kz-variants-primary" : undefined} data-testid="design-option-compare-row">
                <td title={r.label}>{r.label}</td>
                <td className="num">{fmt(r.gf) + delta(r.gf, base.gf, 1)}</td>
                <td className="num">{fmt(r.hnf) + delta(r.hnf, base.hnf, 1)}</td>
                <td className="num">{fmt(r.gv, 0) + delta(r.gv, base.gv, 0)}</td>
                <td className="num">{fmt(r.footprint)}</td>
                <td className="num">{r.az == null ? "–" : fmt(r.az, 2)}</td>
                <td className="num">{r.uez == null ? "–" : fmt(r.uez, 2)}</td>
                <td className="num">{formatChf(r.cost)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="balance-export" data-testid="design-option-compare-csv" onClick={exportCsv}>
        {t("designOption.compare.csv")}
      </button>
    </div>
  );
}

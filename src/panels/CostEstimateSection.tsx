// Kostenschätzung grob ([209]) im Flächenbilanz-Panel: Kennwert-Tabelle (eBKP-H-Hauptgruppen) und Zuschläge
// bearbeiten, Ergebnis mit Summen, Bandbreite und Mengen; Export CSV/PDF aus demselben Bericht.
//
//  • Rechnet der Kern (`kosten.rs`, Mengen aus der SIA-416-Flächentabelle); hier nur Anzeige und Eingabe.
//  • Fehlt `Project.costEstimate`, zeigt die Tabelle die Beispielwerte; die erste Änderung schreibt sie ins
//    Projekt (eine Op, Undo-fähig; Tippen in dasselbe Feld = ein Undo-Schritt über den coalesceKey).
//  • Methodenwechsel: Beispiel-Kennwerte werden durch die der neuen Methode ersetzt, eigene Kennwerte über das
//    Mengenverhältnis umgerechnet (Betrag bleibt gleich).

import { useEffect, useMemo, useState } from "react";
import { t } from "../i18n";
import { areaReportToCsv, buildAreaReportPdf, buildCostReport, computeCostEstimate, costGroupLabel, costUnitLabel, defaultCostEstimate, formatChf, setField } from "../core";
import type { CostBasis, CostEstimate, CostGroup, CostMethod, CostResult } from "../core";
import type { Project } from "../model/types";
import { downloadCsv } from "./downloadFile";
import { useStore } from "../state/appStore";

const BASES: CostBasis[] = ["method", "gv", "gf", "hnf", "facade", "roof", "lump"];
const METHODS: CostMethod[] = ["gv", "gf"];

/** Zahl-Eingabe, übernimmt bei Enter/Verlassen (Komma oder Punkt). */
function NumField(props: { value: number; onCommit: (v: number) => void; testId?: string; title?: string; width?: number }) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  const commit = () => {
    const v = Number(text.replace(/'/g, "").replace(",", "."));
    if (Number.isFinite(v) && v !== props.value) props.onCommit(v);
    else setText(String(props.value));
  };
  return (
    <input
      type="text"
      inputMode="decimal"
      className="kz-input kz-num"
      style={props.width ? { width: props.width } : undefined}
      value={text}
      title={props.title}
      data-testid={props.testId}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
      }}
    />
  );
}

/** Kennwerte beim Methodenwechsel: Beispielwerte tauschen, eigene Werte über das Mengenverhältnis umrechnen. */
function switchMethod(p: Project, est: CostEstimate, res: CostResult, method: CostMethod): CostEstimate {
  const from = est.method === "gf" ? res.quantities.gf : res.quantities.gv;
  const to = method === "gf" ? res.quantities.gf : res.quantities.gv;
  const examples = new Map(defaultCostEstimate(p, method).groups.map((g) => [g.code, g.rate]));
  const groups = est.groups.map((g, i) => {
    if (g.basis !== "method") return g;
    const ex = examples.get(g.code);
    if (res.rows[i]?.example && ex !== undefined) return { ...g, rate: ex };
    return from > 0 && to > 0 ? { ...g, rate: Math.round((g.rate * from) / to) } : g;
  });
  return { ...est, method, groups };
}

export function CostEstimateSection() {
  const project = useStore((s) => s.project);
  const applyChange = useStore((s) => s.applyChange);
  const notify = useStore((s) => s.notify);
  const res = useMemo(() => computeCostEstimate(project), [project]);
  const est: CostEstimate = useMemo(() => project.costEstimate ?? defaultCostEstimate(project, "gv"), [project]);
  const stem = `${project.name || "projekt"}-kosten`;

  const update = (next: (e: CostEstimate) => CostEstimate, key: string) =>
    applyChange((p: Project) => [setField("costEstimate", next(p.costEstimate ?? defaultCostEstimate(p, "gv")))], `costEstimate.${key}`);
  const patch = (fields: Partial<CostEstimate>, key: string) => update((e) => ({ ...e, ...fields }), key);
  const patchGroup = (i: number, g: Partial<CostGroup>, key: string) =>
    update((e) => ({ ...e, groups: e.groups.map((x, j) => (j === i ? { ...x, ...g } : x)) }), `${key}.${i}`);

  const exportCsv = () => downloadCsv(`${stem}.csv`, areaReportToCsv(buildCostReport(project, res)));
  const exportPdf = () => {
    try {
      buildAreaReportPdf(buildCostReport(project, res)).save(`${stem}.pdf`);
    } catch {
      notify(t("costs.export.fail"));
    }
  };
  const pctLabel = (v: number) => `${Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)} %`;
  const sumRow = (label: string, n: number, testId: string, total = false, code = "") => (
    <tr className={total ? "total" : ""} data-testid={testId}>
      <td>{code}</td>
      <td colSpan={2}>{label}</td>
      <td className="num">{formatChf(n)}</td>
      <td />
    </tr>
  );

  return (
    <div className="area-section cost-section" data-testid="cost-section">
      <div className="balance-head">
        <span className="balance-section-label">{t("costs.title")}</span>
        <span className="area-actions">
          <button type="button" className="balance-export" data-testid="cost-export-csv" onClick={exportCsv}>
            {t("areas.exportCsv")}
          </button>
          <button type="button" className="balance-export" data-testid="cost-export-pdf" onClick={exportPdf}>
            {t("areas.exportPdf")}
          </button>
        </span>
      </div>

      {res.hasExample && <div className="cost-example-banner">{t("costs.exampleBanner")}</div>}

      <div className="cost-settings">
        <label className="kz-parcel">
          <span>{t("costs.method")}</span>
          <select
            className="kz-input"
            data-testid="cost-method"
            value={res.method}
            onChange={(e) => update((x) => switchMethod(project, x, res, e.target.value as CostMethod), "method")}
          >
            {METHODS.map((m) => (
              <option key={m} value={m}>
                {t(`costs.method.${m}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="kz-parcel">
          <span>{t("costs.priceBase")}</span>
          <input
            type="text"
            className="kz-input"
            style={{ width: 64 }}
            value={est.priceBase}
            data-testid="cost-price-base"
            onChange={(e) => patch({ priceBase: e.target.value }, "priceBase")}
          />
        </label>
        <label className="kz-parcel">
          <span>{t("costs.fees")}</span>
          <NumField value={est.feesPct} testId="cost-fees" onCommit={(v) => patch({ feesPct: v }, "fees")} />
        </label>
        <label className="kz-parcel">
          <span>{t("costs.reserve")}</span>
          <NumField value={est.reservePct} testId="cost-reserve" onCommit={(v) => patch({ reservePct: v }, "reserve")} />
        </label>
        <label className="kz-parcel">
          <span>{t("costs.vat")}</span>
          <NumField value={est.vatPct} testId="cost-vat" onCommit={(v) => patch({ vatPct: v }, "vat")} />
        </label>
        <label className="kz-parcel" title={t("costs.accuracy.hint")}>
          <span>{t("costs.accuracy")}</span>
          <NumField value={est.accuracyPct} testId="cost-accuracy" title={t("costs.accuracy.hint")} onCommit={(v) => patch({ accuracyPct: v }, "accuracy")} />
        </label>
        <label className="kz-parcel">
          <span>{t("costs.region")}</span>
          <NumField value={est.regionFactor} testId="cost-region" onCommit={(v) => patch({ regionFactor: v }, "region")} />
        </label>
        <label className="kz-parcel" title={t("costs.index.hint")}>
          <span>{t("costs.index")}</span>
          <NumField value={est.indexFactor} testId="cost-index" title={t("costs.index.hint")} onCommit={(v) => patch({ indexFactor: v }, "index")} />
        </label>
      </div>

      <table className="area-table cost-table" data-testid="cost-table">
        <thead>
          <tr>
            <th>{t("costs.col.code")}</th>
            <th>
              {t("costs.col.group")} · {t("costs.col.basis")}
            </th>
            <th className="num">{t("costs.col.rate")}</th>
            <th className="num">{t("costs.col.amount")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {res.rows.map((r, i) => (
            <tr key={i} data-testid={`cost-row-${r.code}`}>
              <td>
                <input type="text" className="kz-input cost-code" value={est.groups[i]?.code ?? r.code} onChange={(e) => patchGroup(i, { code: e.target.value }, "code")} />
              </td>
              <td className="cost-name">
                <input
                  type="text"
                  className="kz-input"
                  value={est.groups[i]?.name ?? ""}
                  placeholder={costGroupLabel(r.code)}
                  title={costGroupLabel(r.code, r.name)}
                  onChange={(e) => patchGroup(i, { name: e.target.value || undefined }, "name")}
                />
                <div className="cost-sub">
                  <select className="kz-input" value={est.groups[i]?.basis ?? "method"} title={t("costs.col.basis")} onChange={(e) => patchGroup(i, { basis: e.target.value as CostBasis }, "basis")}>
                    {BASES.map((b) => (
                      <option key={b} value={b}>
                        {b === "method" ? `${t(`costs.basis.${res.method}`)} (${t("costs.basis.method")})` : t(`costs.basis.${b}`)}
                      </option>
                    ))}
                  </select>
                  <span className="cost-qty">{r.unit ? `${formatChf(r.quantity, 1)} ${r.unit}` : costUnitLabel(r)}</span>
                </div>
              </td>
              <td className="num">
                <span className={r.example ? "cost-rate example" : "cost-rate"} title={r.example ? t("costs.example") : undefined}>
                  <NumField value={r.rate} testId={`cost-rate-${r.code}`} width={52} onCommit={(v) => patchGroup(i, { rate: v }, "rate")} />
                  {r.example ? "*" : ""}
                </span>
              </td>
              <td className="num">{formatChf(r.amount)}</td>
              <td>
                <button
                  type="button"
                  className="site-remove"
                  title={t("costs.removeGroup")}
                  aria-label={t("costs.removeGroup")}
                  onClick={() => update((e) => ({ ...e, groups: e.groups.filter((_, j) => j !== i) }), "remove")}
                >
                  ×
                </button>
              </td>
            </tr>
          ))}
          {sumRow(t("costs.row.subtotal"), res.subtotal, "cost-subtotal", true)}
          {sumRow(`${t("costs.row.fees")} ${pctLabel(res.feesPct)}`, res.fees, "cost-fees-row", false, "V")}
          {sumRow(`${t("costs.row.reserve")} ${pctLabel(res.reservePct)}`, res.reserve, "cost-reserve-row", false, "Y")}
          {sumRow(t("costs.row.net"), res.net, "cost-net", true)}
          {sumRow(`${t("costs.row.vat")} ${pctLabel(res.vatPct)}`, res.vat, "cost-vat-row", false, "Z")}
          {sumRow(t("costs.row.gross"), res.gross, "cost-gross", true)}
          <tr data-testid="cost-range" className="cost-range">
            <td />
            <td colSpan={3}>
              {t("costs.range")} ±{pctLabel(res.accuracyPct)}: {formatChf(res.low)} – {formatChf(res.high)}
            </td>
            <td />
          </tr>
        </tbody>
      </table>

      <div className="area-actions">
        <button
          type="button"
          className="balance-export"
          title={t("costs.addGroup.hint")}
          onClick={() => update((e) => ({ ...e, groups: [...e.groups, { code: "", basis: "method", rate: 0 }] }), "add")}
        >
          ＋ {t("costs.addGroup")}
        </button>
        <button
          type="button"
          className="balance-export"
          title={t("costs.reset.hint")}
          data-testid="cost-reset"
          onClick={() => applyChange((p: Project) => [setField("costEstimate", defaultCostEstimate(p, res.method))], "costEstimate.reset")}
        >
          {t("costs.reset")}
        </button>
      </div>

      <table className="area-table cost-quantities" data-testid="cost-quantities">
        <tbody>
          {(
            [
              ["costs.q.gv", formatChf(res.quantities.gv, 1), "m³"],
              ["costs.q.gf", formatChf(res.quantities.gf, 1), "m²"],
              ["costs.q.hnf", formatChf(res.quantities.hnf, 1), "m²"],
              ["costs.q.facade", formatChf(res.quantities.facade, 1), "m²"],
              ["costs.q.roof", formatChf(res.quantities.roof, 1), "m²"],
              ["costs.perGv", res.perGv === null ? "–" : formatChf(res.perGv), "CHF"],
              ["costs.perGf", res.perGf === null ? "–" : formatChf(res.perGf), "CHF"],
            ] as const
          ).map(([key, value, unit]) => (
            <tr key={key}>
              <td>{t(key)}</td>
              <td className="num">
                {value} {unit}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="area-notes">
        {res.notes.map((k) => (
          <li key={k}>{t(`costs.note.${k}`, { pct: pctLabel(res.accuracyPct) })}</li>
        ))}
        <li>{t("costs.foot.ebkp")}</li>
      </ul>
    </div>
  );
}

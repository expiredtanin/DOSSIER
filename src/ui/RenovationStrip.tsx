// [274] Vorschau-Streifen einer Sanierung: Alt, Neu und Ergebnis (Umbauplan) mit SIA-Farben, aussen links → innen rechts,
// massstäblich zueinander (gleiche Meter je Pixel). Die Teilstücke rechnet der Kern (`renovationPair`).

import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import type { RenovationPair, RenovationStripPiece } from "../core";

function Bar({ pieces, scale, demolishFill }: { pieces: RenovationStripPiece[]; scale: number; demolishFill: string }) {
  return (
    <span className="reno-strip-bar">
      {pieces.map((q, i) => (
        <span
          key={i}
          className={`reno-strip-piece is-${q.kind}`}
          data-kind={q.kind}
          style={{
            width: `${Math.max(1, q.thickness * scale)}px`,
            background: q.fill,
            // Neu über Abbruch: Abbruch als gestrichelte Kontur über der Neu-Füllung.
            outline: q.kind === "newOverDemolish" ? `1px dashed ${demolishFill}` : undefined,
            outlineOffset: q.kind === "newOverDemolish" ? "-2px" : undefined,
            borderStyle: q.kind === "demolish" ? "dashed" : "solid",
          }}
          title={`${t(`renovation.fate.${q.kind === "newOverDemolish" ? "new" : q.kind}` as TranslationKey)} ${(q.thickness * 100).toFixed(1)} cm`}
        />
      ))}
    </span>
  );
}

/** Streifen Alt/Neu/Ergebnis eines Typ-Paars; `width` = Pixel für den dicksten Aufbau. */
export function RenovationStrip({ pair, width = 150 }: { pair: RenovationPair; width?: number }) {
  const sum = (v: RenovationStripPiece[]) => v.reduce((a, q) => a + q.thickness, 0);
  const max = Math.max(sum(pair.oldStrip), sum(pair.newStrip), sum(pair.result), 1e-6);
  const scale = width / max;
  const demolishFill = pair.result.find((q) => q.kind === "demolish")?.fill ?? pair.oldStrip.find((q) => q.kind === "demolish")?.fill ?? "var(--reno-demolish)";
  const row = (label: string, pieces: RenovationStripPiece[], id: string) => (
    <div className="reno-strip-row" data-testid={`reno-strip-${id}`}>
      <span className="reno-strip-label">{label}</span>
      <Bar pieces={pieces} scale={scale} demolishFill={demolishFill} />
      <span className="reno-strip-cm">{(sum(pieces) * 100).toFixed(1)} cm</span>
    </div>
  );
  return (
    <div className="reno-strip" data-testid="reno-strip">
      {row(t("renovation.strip.old"), pair.oldStrip, "old")}
      {row(t("renovation.strip.new"), pair.newStrip, "new")}
      {row(t("renovation.strip.result"), pair.result, "result")}
    </div>
  );
}

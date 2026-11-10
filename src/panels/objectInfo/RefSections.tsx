// Abschnitte für Bemassungs-Bezüge und Detail-Verweise der Attribute ([165] aus `ObjectInfoPanel.tsx`).
// Gerufen von `AttributesPanel`.

import type { DimRef } from "../../model/types";
import { usePanelHost } from "../host";
import { t } from "../../i18n";
import type { TranslationKey } from "../../i18n";
import type { DetailRefInfo } from "../../state/selectionInfo";
import { Dropdown } from "../../ui/Dropdown";

// ── Assoziative Bemassung ([38]) ────────────────────────────────────────────
// Je Punkt: frei, angehängt (Merkmal + Element) oder Bezug verloren; „Bemassung lösen" entfernt alle.
export function DimRefsSection({
  refs,
  drawingId,
  host,
}: {
  refs: (DimRef | null)[];
  drawingId: string;
  host: ReturnType<typeof usePanelHost>;
}) {
  const lost = refs.some((r) => r?.lost);
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.dimRefs.section")}</div>
      {refs.map((r, i) => (
        <div className="objinfo-field" key={i} data-testid="dim-ref">
          <span className="objinfo-flabel">{t("objinfo.dimRefs.point", { n: i + 1 })}</span>
          <span className="objinfo-fval">
            {!r
              ? t("objinfo.dimRefs.free")
              : r.lost
                ? t("objinfo.dimRefs.lost", { id: r.id })
                : `${t(`objinfo.dimRefs.feature.${r.feature}` as TranslationKey)} · ${r.id}${r.id2 ? ` / ${r.id2}` : ""}`}
          </span>
        </div>
      ))}
      {lost && <div className="objinfo-measure-hint">{t("objinfo.dimRefs.lostHint")}</div>}
      <div className="objinfo-field">
        <button type="button" className="objinfo-btn" onClick={() => host.onDetachDimension(drawingId)}>
          {t("cmd.dimdetach.label")}
        </button>
      </div>
    </>
  );
}


// ── Masszahl ([172]) ─────────────────────────────────────────────────────────
// Vorgabe: mittig über dem Massstrich; eine verschobene Zahl lässt sich dorthin zurücksetzen.
export function DimTextSection({ drawingId, host }: { drawingId: string; host: ReturnType<typeof usePanelHost> }) {
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-field">
        <button type="button" className="objinfo-btn" onClick={() => host.onResetDimensionText(drawingId)}>
          {t("cmd.dimtextreset.label")}
        </button>
      </div>
    </>
  );
}

// ── Detail-/Schnitt-Verweis-Attribut-Abschnitt ──────────────────────────────
// Bezeichner (obere Zeile) + Blattverknüpfung (Dropdown der Project.layouts,
// „kein Verweis" löst sie); ohne Verknüpfung zusätzlich ein manueller
// Blattname-Platzhalter (untere Zeile, s. `DetailRefInfo`-Kommentar).
export function DetailRefSection({
  detailRef,
  drawingId,
  host,
}: {
  detailRef: DetailRefInfo;
  drawingId: string;
  host: ReturnType<typeof usePanelHost>;
}) {
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.detailRef.section")}</div>

      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.detailRef.label")}</span>
        <input
          type="text"
          className="objinfo-text"
          value={detailRef.label}
          onChange={(e) => host.onSetDetailRefLabel(drawingId, e.target.value)}
          title={t("objinfo.detailRef.label")}
        />
      </div>

      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.detailRef.sheet")}</span>
        <Dropdown
          value={detailRef.sheetLayoutId ?? ""}
          onChange={(v) => host.onSetDetailRefSheetLayout(drawingId, v === "" ? undefined : v)}
          options={[
            { value: "", label: t("objinfo.detailRef.sheet.none") },
            ...detailRef.availableLayouts.map((l) => ({ value: l.id, label: l.name })),
          ]}
          title={t("objinfo.detailRef.sheet")}
          width={130}
        />
      </div>

      {!detailRef.sheetLayoutId && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.detailRef.sheetLabel")}</span>
          <input
            type="text"
            className="objinfo-text"
            value={detailRef.sheetLabel ?? ""}
            placeholder={t("objinfo.detailRef.sheetLabel.hint")}
            onChange={(e) => host.onSetDetailRefSheetLabel(drawingId, e.target.value)}
            title={t("objinfo.detailRef.sheetLabel")}
          />
        </div>
      )}
    </>
  );
}

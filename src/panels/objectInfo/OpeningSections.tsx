// Abschnitte „Öffnung" und „Flächenöffnung" der Attribute ([165] aus `ObjectInfoPanel.tsx`) samt der
// Linien-Übersteuerung der Öffnung. Gerufen von `AttributesPanel`.

import { useStore } from "../../state/appStore";
import type { OpeningInfo } from "../../state/selectionInfo";
import { usePanelHost } from "../host";
import { t } from "../../i18n";
import { Dropdown } from "../../ui/Dropdown";
import type { DetailLevel } from "../../model/viewTypes";
import { formatM } from "../../model/types";
import { surfaceOpeningInfo } from "../../core";
import { ColorHexField } from "../../ui/ColorHexField";
import { selectionOpeningValues } from "../../state/mixedValues";
import { DimensionField, MixedMark } from "./fields";
import { useMulti } from "./useMulti";
import { expandAndFocusInfoGroup } from "./infoGroupState";
import { setSettingsArea } from "../objectSettings/areaState";

/** ⚙: den Abschnitt „Fenster-/Türeditor" im Bereich „Objekt" aufklappen und fokussieren. */
function openEditor(): void {
  setSettingsArea("object");
  expandAndFocusInfoGroup("openingEditor");
}

// Anzeige-Fallbacks für die Öffnungs-Linien-Übersteuerung (LineStyleRow) —
// dieselben Werte wie POCHE_STROKE/SYMBOL_HAIRLINE_MM im Grundriss (Kern: plan/style.rs)
// (reine UI-Default-Anzeige, kein Re-Export nötig).
const OPENING_LINE_DEFAULT_COLOR = "#1a1a1a";

const OPENING_LINE_DEFAULT_WEIGHT = 0.02;


// ── Öffnungs-Attribut-Abschnitt ──────────────────────────────────────────────
// Art (Fenster/Tür), Wirts-Wand, Position/Breite/Höhe/Brüstung, bei Türen
// zusätzlich Anschlag/Aufschlag/Richtung/Winkel; UK/OK read-only.
export function OpeningSection({
  opening,
  host,
}: {
  opening: OpeningInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  const storeProject = useStore((st) => st.project);
  // [195b] Mehrfachauswahl: abweichende Werte als „gemischt" kennzeichnen.
  const multi = useMulti("openings", selectionOpeningValues);
  const isDoor = opening.kind === "door";
  if (opening.hostRoofId || opening.hostCeilingId) {
    return <SurfaceOpeningSection opening={opening} host={host} />;
  }
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.opening.section")}</div>

      {/* Tür-/Fenstertyp (Bibliothek) — je nach Art aus doorTypes bzw. windowTypes.
          Der ⚙-Knopf öffnet den reichen Fenster-/Tür-Einstellungsdialog. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.type")}</span>
        <Dropdown
          value={opening.typeId ?? ""}
          onChange={(v) => host.onSetOpeningType(v)}
          options={[
            { value: "", label: t("objinfo.type.none") },
            ...(isDoor
              ? storeProject.doorTypes ?? []
              : storeProject.windowTypes ?? []
            ).map((ty) => ({ value: ty.id, label: ty.name })),
          ]}
          title={t("objinfo.opening.type")}
          width={106}
        />
        <MixedMark on={multi?.typeId.mixed} what="openingType" />
        <button
          type="button"
          className="objinfo-typebtn"
          title={t("objinfo.opening.editType")}
          aria-label={t("objinfo.opening.editType")}
          onClick={openEditor}
        >
          ⚙
        </button>
      </div>

      {/* Art (Fenster/Tür) — read-only: die Gattung wird beim Platzieren mit dem
          jeweiligen Werkzeug festgelegt und NICHT nachträglich umgeschaltet
          (ein Fenster in eine Tür zu verwandeln ergibt keinen sinnvollen Bauteil). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.kind")}</span>
        <span className="objinfo-fval">
          {t(isDoor ? "objinfo.opening.kind.door" : "objinfo.opening.kind.window")}
        </span>
      </div>

      {/* Wirts-Wand (read-only Anzeige des Geschosses/Wand-Bezugs). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.hostWall")}</span>
        <span className="objinfo-fval">{opening.hostWallName}</span>
      </div>

      {/* Editierbare Maße. */}
      <DimensionField
        label={t("objinfo.opening.position")}
        value={opening.position}
        onCommit={(v) => host.onSetOpeningPosition(v)}
      />
      {/* [144] Gegenstück: Abstand des zweiten Pfostens vom Wandende (nur gerade Wand). */}
      {opening.wallLength != null && (
        <DimensionField
          label={t("objinfo.opening.positionEnd")}
          value={opening.wallLength - opening.position - opening.width}
          onCommit={(v) => host.onSetOpeningPosition(opening.wallLength! - v - opening.width)}
        />
      )}
      <DimensionField
        label={t("objinfo.opening.width")}
        value={opening.width}
        onCommit={(v) => host.onSetOpeningWidth(v)}
      />
      <MixedMark on={multi?.width.mixed} what="width" />
      <DimensionField
        label={t("objinfo.opening.height")}
        value={opening.height}
        onCommit={(v) => host.onSetOpeningHeight(v)}
      />
      <MixedMark on={multi?.height.mixed} what="height" />
      {!isDoor && (
        <>
          <DimensionField
            label={t("objinfo.opening.sill")}
            value={opening.sillHeight}
            onCommit={(v) => host.onSetOpeningSill(v)}
          />
          <MixedMark on={multi?.sillHeight.mixed} what="sill" />
          {/* Fenster-spezifisch: Flügelanzahl (1–4). */}
          <DimensionField
            label={t("objinfo.opening.wingCount")}
            value={opening.wingCount ?? 1}
            min={1}
            onCommit={(v) => host.onSetOpeningWingCount(Math.max(1, Math.min(4, Math.round(v))))}
          />
          {/* Grundriss-Linien je Kategorie: Rahmen (Blendrahmen+Stulp), Fenster
              (Flügelrahmen/Sprossen), Sims (Auf-/Untersicht, nur wenn der
              Fenstertyp sie aktiviert hat — s. WindowType.sillLine). */}
          <LineStyleRow
            label={t("objinfo.opening.frameLine")}
            value={opening.frameLine}
            fallbackColor={OPENING_LINE_DEFAULT_COLOR}
            fallbackWeight={OPENING_LINE_DEFAULT_WEIGHT}
            onChange={host.onSetOpeningFrameLine}
          />
          <LineStyleRow
            label={t("objinfo.opening.frameViewLine")}
            value={opening.frameViewLine}
            fallbackColor={opening.frameLine?.color ?? OPENING_LINE_DEFAULT_COLOR}
            fallbackWeight={opening.frameLine?.weight ?? OPENING_LINE_DEFAULT_WEIGHT}
            onChange={host.onSetOpeningFrameViewLine}
          />
          <LineStyleRow
            label={t("objinfo.opening.sashLine")}
            value={opening.sashLine}
            fallbackColor={OPENING_LINE_DEFAULT_COLOR}
            fallbackWeight={OPENING_LINE_DEFAULT_WEIGHT}
            onChange={host.onSetOpeningSashLine}
          />
          <LineStyleRow
            label={t("objinfo.opening.sillLine")}
            value={opening.sillLineStyle}
            fallbackColor={OPENING_LINE_DEFAULT_COLOR}
            fallbackWeight={OPENING_LINE_DEFAULT_WEIGHT}
            onChange={host.onSetOpeningSillLineStyle}
          />
          {/* [95] Öffnungslinien der Flügel: Ansicht (Dreh-/Kipp-Dreiecke) und Grundriss (Aufschlagbogen). */}
          <TriStateField
            label={t("objinfo.opening.sashSymbols")}
            value={opening.sashSymbols}
            onChange={(v) => host.onSetOpeningDisplay({ sashSymbols: v })}
          />
          <TriStateField
            label={t("objinfo.opening.planSwingArcs")}
            value={opening.planSwingArcs}
            onChange={(v) => host.onSetOpeningDisplay({ planSwingArcs: v })}
          />
        </>
      )}

      {/* Tür-spezifisch: Typ / Sturzlinien / Anschlag / Aufschlagseite / Richtung / Winkel. */}
      {isDoor && (
        <>
          {/* Tür-Typ (normal / Wandöffnung). */}
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.doorType")}</span>
            <Dropdown
              value={opening.doorType ?? "normal"}
              onChange={(v) => host.onSetOpeningDoorType(v as "normal" | "wandoeffnung")}
              options={[
                { value: "normal", label: t("objinfo.opening.doorType.normal") },
                { value: "wandoeffnung", label: t("objinfo.opening.doorType.wandoeffnung") },
              ]}
              title={t("objinfo.opening.doorType")}
              width={130}
            />
          </div>
          {/* Sturzlinien-Darstellung (keine/innen/aussen/beide). */}
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.lintelLines")}</span>
            <Dropdown
              value={opening.lintelLines ?? "beide"}
              onChange={(v) => host.onSetOpeningLintelLines(v as "keine" | "innen" | "aussen" | "beide")}
              options={[
                { value: "keine", label: t("objinfo.opening.lintelLines.keine") },
                { value: "innen", label: t("objinfo.opening.lintelLines.innen") },
                { value: "aussen", label: t("objinfo.opening.lintelLines.aussen") },
                { value: "beide", label: t("objinfo.opening.lintelLines.beide") },
              ]}
              title={t("objinfo.opening.lintelLines")}
              width={130}
            />
          </div>
          {/* [105] Linientyp der Sturzlinien (Strichmuster in Papier-mm wie [153]); leer = wie Türtyp. */}
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.lintelLineStyle")}</span>
            <Dropdown
              value={opening.lintelLineStyle ?? ""}
              onChange={(v) =>
                host.onSetOpeningDisplay({
                  lintelLineStyle: v === "" ? undefined : (v as "gestrichelt" | "punktiert" | "durchgehend" | "keine"),
                })
              }
              options={[
                { value: "", label: t("objinfo.opening.fromType") },
                { value: "gestrichelt", label: t("objinfo.opening.lintelLineStyle.gestrichelt") },
                { value: "punktiert", label: t("objinfo.opening.lintelLineStyle.punktiert") },
                { value: "durchgehend", label: t("objinfo.opening.lintelLineStyle.durchgehend") },
                { value: "keine", label: t("objinfo.opening.lintelLineStyle.keine") },
              ]}
              title={t("objinfo.opening.lintelLineStyle")}
              width={130}
            />
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.hinge")}</span>
            <Dropdown
              value={opening.hinge ?? "start"}
              onChange={(v) => host.onSetOpeningHinge(v as "start" | "end")}
              options={[
                { value: "start", label: t("objinfo.opening.hinge.start") },
                { value: "end", label: t("objinfo.opening.hinge.end") },
              ]}
              title={t("objinfo.opening.hinge")}
              width={130}
            />
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.swing")}</span>
            <Dropdown
              value={opening.swing ?? "left"}
              onChange={(v) => host.onSetOpeningSwing(v as "left" | "right")}
              options={[
                { value: "left", label: t("objinfo.opening.swing.left") },
                { value: "right", label: t("objinfo.opening.swing.right") },
              ]}
              title={t("objinfo.opening.swing")}
              width={130}
            />
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.dir")}</span>
            <Dropdown
              value={opening.openingDir ?? "in"}
              onChange={(v) => host.onSetOpeningDir(v as "in" | "out")}
              options={[
                { value: "in", label: t("objinfo.opening.dir.in") },
                { value: "out", label: t("objinfo.opening.dir.out") },
              ]}
              title={t("objinfo.opening.dir")}
              width={130}
            />
          </div>
          <DimensionField
            label={t("objinfo.opening.swingAngle")}
            value={opening.swingAngle ?? 90}
            min={1}
            onCommit={(v) => host.onSetOpeningSwingAngle(v)}
          />
        </>
      )}

      {/* Detailstufe-Übersteuerung — fehlt sie ("" = Ansicht), gilt die
          ansichtsweite Detailstufe (Grundriss-Kopfzeile). Wirkt auf dasselbe
          grob/mittel/fein-Symbol wie die Ansichts-Detailstufe (Türblatt-Bogen,
          Rahmen/Glaslinien), nur PRO ELEMENT statt für den ganzen Plan. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.detailLevel")}</span>
        <Dropdown
          value={opening.detailLevel ?? ""}
          onChange={(v) =>
            host.onSetOpeningDetailLevel(v === "" ? undefined : (v as DetailLevel))
          }
          options={[
            { value: "", label: t("objinfo.detailLevel.view") },
            { value: "grob", label: t("topbar.detail.grob") },
            { value: "mittel", label: t("topbar.detail.mittel") },
            { value: "fein", label: t("topbar.detail.fein") },
          ]}
          title={t("objinfo.opening.detailLevel")}
          width={130}
        />
      </div>

      <div className="objinfo-sep" />

      {/* UK/OK (read-only, aus der Wand-UK + Brüstung/Höhe abgeleitet). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.bottom")}</span>
        <span className="objinfo-fval">{formatM(opening.zBottom)}</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.top")}</span>
        <span className="objinfo-fval">{formatM(opening.zTop)}</span>
      </div>
    </>
  );
}


// ── Dach-/Deckenfenster ([103]) ─────────────────────────────────────────────
// Wirt (Dach/Decke + Geschoss), Breite quer und Höhe im Gefälle (in der Fläche gemessen), Lage des
// Mittelpunkts im Grundriss, Drehung nur auf waagrechten Flächen; UK/OK und Neigung aus dem Kern.
function SurfaceOpeningSection({
  opening,
  host,
}: {
  opening: OpeningInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  const storeProject = useStore((st) => st.project);
  const info = surfaceOpeningInfo(storeProject, opening.id);
  const roof = !!opening.hostRoofId;
  const hp = opening.hostPoint ?? { x: 0, y: 0 };
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.opening.section")}</div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.opening.type")}</span>
        <Dropdown
          value={opening.typeId ?? ""}
          onChange={(v) => host.onSetOpeningType(v)}
          options={[
            { value: "", label: t("objinfo.type.none") },
            ...(storeProject.windowTypes ?? []).map((ty) => ({ value: ty.id, label: ty.name })),
          ]}
          title={t("objinfo.opening.type")}
          width={106}
        />
        <button
          type="button"
          className="objinfo-typebtn"
          title={t("objinfo.opening.editType")}
          aria-label={t("objinfo.opening.editType")}
          onClick={openEditor}
        >
          ⚙
        </button>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t(roof ? "objinfo.opening.hostRoof" : "objinfo.opening.hostCeiling")}</span>
        <span className="objinfo-fval">{info?.hostName ?? "–"}</span>
      </div>
      <DimensionField label={t("objinfo.opening.surfaceWidth")} value={opening.width} onCommit={(v) => host.onSetOpeningWidth(v)} />
      <DimensionField label={t("objinfo.opening.surfaceHeight")} value={opening.height} onCommit={(v) => host.onSetOpeningHeight(v)} />
      <DimensionField label={t("objinfo.opening.hostX")} value={hp.x} min={-1e9} onCommit={(x) => host.onSetOpeningHost?.({ hostPoint: { x, y: hp.y } })} />
      <DimensionField label={t("objinfo.opening.hostY")} value={hp.y} min={-1e9} onCommit={(y) => host.onSetOpeningHost?.({ hostPoint: { x: hp.x, y } })} />
      {!roof && (
        <DimensionField
          label={t("objinfo.opening.hostAngle")}
          value={opening.hostAngle ?? 0}
          min={-360}
          unit="°"
          step={1}
          digits={1}
          onCommit={(a) => host.onSetOpeningHost?.({ hostAngle: a })}
        />
      )}
      {info && (
        <>
          <div className="objinfo-sep" />
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.slope")}</span>
            <span className="objinfo-fval">{info.slopeDeg.toFixed(1)}°</span>
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.bottom")}</span>
            <span className="objinfo-fval">{formatM(info.zBottom)}</span>
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.opening.top")}</span>
            <span className="objinfo-fval">{formatM(info.zTop)}</span>
          </div>
        </>
      )}
    </>
  );
}


/** Farbe + Strichstärke (mm) einer Linien-Kategorie, mit "System"-Fallback-
 *  Anzeige (Override `undefined` ⇒ zeigt `fallbackColor`/`fallbackWeight`,
 *  Ändern setzt sofort einen expliziten Override). */
function LineStyleRow({
  label,
  value,
  fallbackColor,
  fallbackWeight,
  onChange,
}: {
  label: string;
  value: { color?: string; weight?: number } | undefined;
  fallbackColor: string;
  fallbackWeight: number;
  onChange: (v: { color?: string; weight?: number } | undefined) => void;
}) {
  return (
    <div className="objinfo-field">
      <span className="objinfo-flabel">{label}</span>
      <ColorHexField
        value={value?.color ?? fallbackColor}
        onChange={(color) => onChange({ ...value, color })}
      />
      <input
        className="objinfo-input objinfo-input-narrow"
        type="number"
        step={0.01}
        min={0}
        value={(value?.weight ?? fallbackWeight).toFixed(2)}
        onChange={(e) => {
          const w = Number(e.target.value);
          if (isFinite(w) && w >= 0) onChange({ ...value, weight: w });
        }}
        title={t("objinfo.lineWeight")}
      />
      <span className="objinfo-unit">mm</span>
    </div>
  );
}

/** Ja/Nein mit „wie Typ“ (fehlt) — für Übersteuerungen an der Öffnung ([95]). */
function TriStateField({ label, value, onChange }: { label: string; value: boolean | undefined; onChange: (v: boolean | undefined) => void }) {
  return (
    <div className="objinfo-field">
      <span className="objinfo-flabel">{label}</span>
      <Dropdown
        value={value === undefined ? "" : value ? "an" : "aus"}
        onChange={(v) => onChange(v === "" ? undefined : v === "an")}
        options={[
          { value: "", label: t("objinfo.opening.fromType") },
          { value: "an", label: t("objinfo.opening.on") },
          { value: "aus", label: t("objinfo.opening.off") },
        ]}
        title={label}
        width={130}
      />
    </div>
  );
}

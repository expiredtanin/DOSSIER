// [280] Träger-Abschnitt der Objekt-Info: Querschnitt (Breite × Höhe), Profilname (nur Text), Versatz der Oberkante
// gegenüber der Deckenunterkante (0 = bündig, Unterzug); Länge, Geschoss und aufgelöste UK/OK nur zur Auskunft.

import { t } from "../../i18n";
import type { BeamInfo } from "../../state/selectionInfo";
import { usePanelHost } from "../host";
import { DimensionField } from "./fields";

export function BeamSection({ beam, host }: { beam: BeamInfo; host: ReturnType<typeof usePanelHost> }) {
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.beam.section")}</div>

      <label className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.beam.profileName")}</span>
        <input
          key={beam.profileName ?? ""}
          type="text"
          className="objinfo-text"
          defaultValue={beam.profileName ?? ""}
          placeholder={t("objinfo.beam.profileName.placeholder")}
          onBlur={(e) => {
            if (e.target.value.trim() !== (beam.profileName ?? "")) host.onSetBeamProfileName(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          title={t("objinfo.beam.profileName")}
        />
      </label>

      <DimensionField label={t("objinfo.beam.width")} value={beam.width} onCommit={(v) => host.onSetBeamWidth(v)} />
      <DimensionField label={t("objinfo.beam.height")} value={beam.height} onCommit={(v) => host.onSetBeamHeight(v)} />
      <DimensionField label={t("objinfo.beam.topOffset")} value={beam.topOffset} onCommit={(v) => host.onSetBeamTopOffset(v)} />

      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.beam.length")}</span>
        <span className="objinfo-fval">{beam.length.toFixed(2)} m</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.beam.level")}</span>
        <span className="objinfo-fval">
          {beam.zBottom.toFixed(2)} – {beam.zTop.toFixed(2)} m
        </span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.beam.floor")}</span>
        <span className="objinfo-fval">{beam.floorName}</span>
      </div>
    </>
  );
}

// Abschnitte „Dach" der Attribute ([165] aus `ObjectInfoPanel.tsx`): Dachform, Gauben und Dachränder.
// Gerufen von `AttributesPanel`.

import { useStore } from "../../state/appStore";
import type { RoofInfo } from "../../state/selectionInfo";
import { usePanelHost } from "../host";
import { useMemo } from "react";
import { dormerStatus } from "../../analysis/dormerStatus";
import type { Dormer, DormerKind, RoofShape } from "../../model/types";
import type { TranslationKey } from "../../i18n";
import { t } from "../../i18n";
import { Dropdown } from "../../ui/Dropdown";
import { UValueRow } from "../UValueRow";
import { formatM } from "../../model/types";
import type { RoofEdge, EdgeSpec } from "../../core";

// ── Treppen-Attribut-Abschnitt ───────────────────────────────────────────────
// Grundform (gerade/L/Wendel), Laufbreite, Stufenanzahl, Steighöhe (+ abgeleitete
// Steigungshöhe/Auftrittstiefe), Laufrichtung; Referenzgeschoss + UK/OK read-only.
/** Rechteck-Umriss (CCW) aus unterer/linker Ecke + Breite/Tiefe (für Dach-Resize). */
function rectOutline(x0: number, y0: number, w: number, d: number) {
  return [
    { x: x0, y: y0 },
    { x: x0 + w, y: y0 },
    { x: x0 + w, y: y0 + d },
    { x: x0, y: y0 + d },
  ];
}


/** Gauben ([G5]) des Dachs: Art, Masse, Neigung, Aufbau je Gaube; Hinzufügen über den Befehl „Gaube". */
function DormersSection({ roof, host }: { roof: RoofInfo; host: ReturnType<typeof usePanelHost> }) {
  const storeProject = useStore((st) => st.project);
  const dormers = roof.dormers ?? [];
  const status = useMemo(() => dormerStatus(storeProject), [storeProject]);
  const patch = (i: number, p: Partial<Dormer>) =>
    host.onSetRoofPatch({ dormers: dormers.map((d, k) => (k === i ? { ...d, ...p } : d)) }, `dormer-${i}`);
  const num = (labelKey: TranslationKey, value: number, step: number, apply: (v: number) => void) => (
    <div className="objinfo-field">
      <span className="objinfo-flabel">{t(labelKey)}</span>
      <input
        type="number"
        className="objinfo-text"
        step={step}
        value={Number(value.toFixed(2))}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) apply(v);
        }}
        title={t(labelKey)}
      />
    </div>
  );
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.dormer.section")}</div>
      {dormers.map((d, i) => (
        <div key={d.id} data-testid="objinfo-dormer">
          {(() => {
            const st = status.find((s) => s.dormerId === d.id);
            if (!st || !(st.clamped || st.invalid)) return null;
            return (
              <div className="objinfo-warn" role="alert" data-testid="objinfo-dormer-warning">
                {st.invalid ? t("objinfo.dormer.invalid") : t("objinfo.dormer.clamped", { height: st.effectiveHeight.toFixed(2) })}
              </div>
            );
          })()}
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.dormer.kind")}</span>
            <Dropdown
              value={d.kind}
              onChange={(v) => patch(i, { kind: v as DormerKind })}
              options={[
                { value: "schlepp", label: t("objinfo.dormer.kind.schlepp") },
                { value: "sattel", label: t("objinfo.dormer.kind.sattel") },
                { value: "flach", label: t("objinfo.dormer.kind.flach") },
                { value: "walm", label: t("objinfo.dormer.kind.walm") },
              ]}
              title={t("objinfo.dormer.kind")}
              width={130}
            />
            <button
              type="button"
              className="objinfo-typebtn"
              title={t("objinfo.dormer.remove")}
              aria-label={t("objinfo.dormer.remove")}
              onClick={() => host.onSetRoofPatch({ dormers: dormers.filter((_, k) => k !== i) })}
            >
              ×
            </button>
          </div>
          {num("objinfo.dormer.width", d.width, 0.1, (v) => patch(i, { width: Math.max(0.8, v) }))}
          {num("objinfo.dormer.frontHeight", d.frontHeight, 0.05, (v) => patch(i, { frontHeight: Math.max(0.5, v) }))}
          {d.kind !== "flach" &&
            num("objinfo.dormer.pitch", d.pitchDeg ?? (d.kind === "schlepp" ? 15 : 40), 1, (v) =>
              patch(i, { pitchDeg: Math.max(0, Math.min(75, v)), depth: undefined }),
            )}
          {d.kind === "schlepp" &&
            num("objinfo.dormer.depth", d.depth ?? 0, 0.1, (v) => patch(i, { depth: v > 0.1 ? v : undefined }))}
          {num("objinfo.dormer.overhang", d.overhang ?? 0.15, 0.05, (v) => patch(i, { overhang: Math.max(0, v) }))}
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.dormer.wallType")}</span>
            <Dropdown
              value={d.wallTypeId ?? ""}
              onChange={(v) => patch(i, { wallTypeId: v || undefined })}
              options={[
                { value: "", label: t("objinfo.dormer.wallType.default") },
                ...storeProject.wallTypes.map((wt) => ({ value: wt.id, label: wt.name })),
              ]}
              title={t("objinfo.dormer.wallType")}
              width={130}
            />
          </div>
          <div className="objinfo-field">
            <span className="objinfo-flabel">{t("objinfo.dormer.roofType")}</span>
            <Dropdown
              value={d.roofTypeId ?? ""}
              onChange={(v) => patch(i, { roofTypeId: v || undefined })}
              options={[
                { value: "", label: t("objinfo.dormer.roofType.host") },
                ...(storeProject.roofTypes ?? []).map((rt) => ({ value: rt.id, label: rt.name })),
              ]}
              title={t("objinfo.dormer.roofType")}
              width={130}
            />
          </div>
        </div>
      ))}
      <div className="objinfo-field">
        <button type="button" className="objinfo-typebtn" title={t("objinfo.dormer.add")} onClick={() => host.onRunCommand("dormer")}>
          {t("objinfo.dormer.addBtn")}
        </button>
      </div>
    </>
  );
}


/** Dach-Abschnitt: Form, Neigung(en), Überstand, Firstrichtung, Dicke. */
export function RoofSection({
  roof,
  host,
}: {
  roof: RoofInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  const storeProject = useStore((st) => st.project);
  const numField = (
    labelKey: TranslationKey,
    value: number,
    step: number,
    apply: (v: number) => void,
  ) => (
    <div className="objinfo-field">
      <span className="objinfo-flabel">{t(labelKey)}</span>
      <input
        type="number"
        className="objinfo-text"
        step={step}
        value={Number(value.toFixed(2))}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) apply(v);
        }}
        title={t(labelKey)}
      />
    </div>
  );
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.roof.section")}</div>

      {/* Dachform. */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.roof.shape")}</span>
        <Dropdown
          value={roof.shape}
          onChange={(v) => host.onSetRoofPatch({ shape: v as RoofShape })}
          options={[
            { value: "flach", label: t("objinfo.roof.shape.flach") },
            { value: "pult", label: t("objinfo.roof.shape.pult") },
            { value: "sattel", label: t("objinfo.roof.shape.sattel") },
            { value: "walm", label: t("objinfo.roof.shape.walm") },
            { value: "mansarde", label: t("objinfo.roof.shape.mansarde") },
            { value: "zelt", label: t("objinfo.roof.shape.zelt") },
          ]}
          title={t("objinfo.roof.shape")}
          width={130}
        />
      </div>

      {/* Dachtyp (mehrschichtiger Aufbau) — leer = einschichtig (Dicke unten). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.roof.type")}</span>
        <Dropdown
          value={roof.roofTypeId ?? ""}
          onChange={(v) => host.onSetRoofPatch({ roofTypeId: v || undefined })}
          options={[
            { value: "", label: t("objinfo.roof.type.single") },
            ...(storeProject.roofTypes ?? []).map((rt) => ({ value: rt.id, label: rt.name })),
          ]}
          title={t("objinfo.roof.type")}
          width={130}
        />
      </div>
      <UValueRow project={storeProject} kind="roof" typeId={roof.roofTypeId} />

      {/* Firstrichtung (X/Y) — nur bei Formen mit First relevant. */}
      {roof.shape !== "flach" && roof.shape !== "zelt" && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.roof.ridgeAxis")}</span>
          <Dropdown
            value={roof.ridgeAxis}
            onChange={(v) => host.onSetRoofPatch({ ridgeAxis: v as "x" | "y" })}
            options={[
              { value: "x", label: t("objinfo.roof.ridgeAxis.x") },
              { value: "y", label: t("objinfo.roof.ridgeAxis.y") },
            ]}
            title={t("objinfo.roof.ridgeAxis")}
            width={130}
          />
        </div>
      )}

      {/* Neigung(en) — Flachdach hat keine. */}
      {roof.shape !== "flach" &&
        numField("objinfo.roof.pitch", roof.pitchDeg, 1, (v) =>
          host.onSetRoofPatch({ pitchDeg: Math.max(0, Math.min(85, v)) }),
        )}
      {roof.shape === "mansarde" &&
        numField("objinfo.roof.pitchUpper", roof.pitchUpperDeg ?? roof.pitchDeg / 2, 1, (v) =>
          host.onSetRoofPatch({ pitchUpperDeg: Math.max(0, Math.min(85, v)) }),
        )}
      {/* Mansarde-Untertyp (Giebel/Walm/Zelt) + Knicklage. */}
      {roof.shape === "mansarde" && (
        <div className="objinfo-field">
          <span className="objinfo-flabel">{t("objinfo.roof.mansardType")}</span>
          <Dropdown
            value={roof.mansardType ?? "giebel"}
            onChange={(v) =>
              host.onSetRoofPatch({ mansardType: v as "giebel" | "walm" | "zelt" })
            }
            options={[
              { value: "giebel", label: t("objinfo.roof.mansard.giebel") },
              { value: "walm", label: t("objinfo.roof.mansard.walm") },
              { value: "zelt", label: t("objinfo.roof.mansard.zelt") },
            ]}
            title={t("objinfo.roof.mansardType")}
            width={130}
          />
        </div>
      )}
      {roof.shape === "mansarde" &&
        numField("objinfo.roof.mansardKnee", (roof.mansardKneeRatio ?? 0.4) * 100, 1, (v) =>
          host.onSetRoofPatch({ mansardKneeRatio: Math.max(5, Math.min(49, v)) / 100 }),
        )}

      {roof.shape === "sattel" &&
        numField("objinfo.roof.halfHip", (roof.halfHipRatio ?? 0) * 100, 5, (v) =>
          host.onSetRoofPatch({ halfHipRatio: Math.max(0, Math.min(90, v)) / 100 }),
        )}

      {/* Grundriss-Masse (Breite/Tiefe): das Umriss-Rechteck neu bilden, die
          untere/linke Ecke (minX/minY) bleibt fix. */}
      {/* Mit Innenhöfen oder Kanten ausserhalb eines Vierecks würde das Rechteck die Höfe/Kantenneigungen
          zerstören — dort entfallen Breite/Tiefe. */}
      {roof.holes.length === 0 &&
        roof.edges.length === 4 &&
        numField("objinfo.roof.width", roof.width, 0.1, (v) => {
          const w = Math.max(0.2, v);
          host.onSetRoofPatch({
            outline: rectOutline(roof.minX, roof.minY, w, roof.depth),
          });
        })}
      {roof.holes.length === 0 &&
        roof.edges.length === 4 &&
        numField("objinfo.roof.depth", roof.depth, 0.1, (v) => {
          const d = Math.max(0.2, v);
          host.onSetRoofPatch({
            outline: rectOutline(roof.minX, roof.minY, roof.width, d),
          });
        })}

      {/* Überstand: Traufe (senkrecht zum First) + Ortgang (Giebelseite). */}
      {numField("objinfo.roof.overhang", roof.overhang, 0.05, (v) =>
        host.onSetRoofPatch({ overhang: Math.max(0, v) }),
      )}
      {roof.shape !== "flach" &&
        roof.shape !== "zelt" &&
        numField(
          "objinfo.roof.overhangGable",
          roof.overhangGable ?? roof.overhang,
          0.05,
          (v) => host.onSetRoofPatch({ overhangGable: Math.max(0, v) }),
        )}
      {/* Attika ([148]): Brüstung am Rand des Flachdachs; Höhe 0 = keine. */}
      {roof.shape === "flach" && (
        <>
          {numField("objinfo.roof.parapetHeight", roof.parapetHeight ?? 0, 0.05, (v) =>
            host.onSetRoofPatch({ parapetHeight: v > 0 ? v : undefined }),
          )}
          {(roof.parapetHeight ?? 0) > 0 &&
            numField("objinfo.roof.parapetWidth", roof.parapetWidth ?? 0.2, 0.01, (v) =>
              host.onSetRoofPatch({ parapetWidth: Math.max(0.02, v) }),
            )}
          {(roof.parapetHeight ?? 0) > 0 && (
            <div className="objinfo-field">
              <span className="objinfo-flabel">{t("objinfo.roof.parapetMaterial")}</span>
              <Dropdown
                value={roof.parapetComponentId ?? ""}
                onChange={(v) => host.onSetRoofPatch({ parapetComponentId: v || undefined })}
                options={[
                  { value: "", label: t("objinfo.roof.parapetMaterial.none") },
                  ...storeProject.components.map((c) => ({ value: c.id, label: c.name })),
                ]}
                title={t("objinfo.roof.parapetMaterial")}
                width={130}
              />
            </div>
          )}
        </>
      )}
      {numField("objinfo.roof.thickness", roof.thickness, 0.02, (v) =>
        host.onSetRoofPatch({ thickness: Math.max(0.01, v) }),
      )}
      {/* Traufhöhe (absolutes Z) — z. B. für einen Kniestock übers Geschoss anheben. */}
      {numField("objinfo.roof.baseElevation", roof.baseElevation, 0.1, (v) =>
        host.onSetRoofPatch({ baseElevation: v }),
      )}

      {/* Kanten: Neigung je Kante (leer = Standard) und Giebel ([26]). Wirkt bei Sattel/Walm/
          Mansarde/Zelt; Flach und Pult ignorieren sie. */}
      {roof.shape !== "flach" && roof.shape !== "pult" && (
        <RoofEdgesSection roof={roof} host={host} />
      )}
      {/* Innenhöfe: Liste mit Entfernen, Hinzufügen über den Befehl „Dachhof“. */}
      <DormersSection roof={roof} host={host} />
      {roof.shape !== "pult" && (
        <>
          <div className="objinfo-sep" />
          <div className="objinfo-section-label">{t("objinfo.roof.courts")}</div>
          {roof.holes.map((h, i) => (
            <div className="objinfo-field" key={i}>
              <span className="objinfo-flabel objinfo-muted">
                {t("objinfo.roof.courtRow", { n: i + 1, area: h.area.toFixed(2) })}
              </span>
              <button
                type="button"
                className="objinfo-typebtn"
                title={t("objinfo.roof.courtRemove")}
                aria-label={t("objinfo.roof.courtRemove")}
                onClick={() => host.onRemoveRoofHole(i)}
              >
                ×
              </button>
            </div>
          ))}
          <div className="objinfo-field">
            <button
              type="button"
              className="objinfo-typebtn"
              title={t("objinfo.roof.courtAdd")}
              onClick={() => host.onRunCommand("roofhole")}
            >
              {t("objinfo.roof.courtAddBtn")}
            </button>
          </div>
        </>
      )}
      <div className="objinfo-sep" />

      {/* Abgeleitete Werte (read-only). */}
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.roof.ridgeHeight")}</span>
        <span className="objinfo-fval">{formatM(roof.ridgeHeight)}</span>
      </div>
      <div className="objinfo-field">
        <span className="objinfo-flabel">{t("objinfo.roof.area")}</span>
        <span className="objinfo-fval">{roof.footprintArea.toFixed(2)} m²</span>
      </div>
    </>
  );
}


/** Kantenliste eines Dachs: Neigung je Kante (leer = Standard) + Giebel-Schalter. */
function RoofEdgesSection({
  roof,
  host,
}: {
  roof: RoofInfo;
  host: ReturnType<typeof usePanelHost>;
}) {
  // Tippen einer Zahl = ein Undo-Schritt je Kante (gleicher coalesceKey, s. Host).
  const setEdge = (e: RoofEdge, spec: EdgeSpec) => host.onSetRoofEdge(e.index, spec);
  return (
    <>
      <div className="objinfo-sep" />
      <div className="objinfo-section-label">{t("objinfo.roof.edges")}</div>
      {roof.edges.map((e) => {
        const label =
          e.ring === 0
            ? t("objinfo.roof.edge", { n: e.edge + 1 })
            : t("objinfo.roof.edgeCourt", { c: e.ring, n: e.edge + 1 });
        const gable = e.spec.kind === "gable";
        const placeholder = e.defaultGable ? t("objinfo.roof.edgeGable") : String(roof.pitchDeg);
        return (
          <div className="objinfo-field objinfo-roof-edge" key={e.index} data-edge={e.index}>
            <span className="objinfo-flabel" title={`${e.length.toFixed(2)} m`}>
              {label}
            </span>
            <input
              type="number"
              className="objinfo-text"
              min={0}
              max={89}
              step={1}
              disabled={gable}
              placeholder={placeholder}
              value={e.spec.kind === "pitch" ? Number(e.spec.deg.toFixed(2)) : ""}
              aria-label={`${label}: ${t("objinfo.roof.edgePitch")}`}
              title={t("objinfo.roof.edgePitch")}
              onChange={(ev) => {
                const raw = ev.target.value;
                if (raw === "") return setEdge(e, { kind: "default" });
                const v = Number(raw);
                if (Number.isFinite(v)) setEdge(e, { kind: "pitch", deg: v });
              }}
            />
            <label className="objinfo-muted" title={t("objinfo.roof.edgeGableHint")}>
              <input
                type="checkbox"
                checked={gable}
                aria-label={`${label}: ${t("objinfo.roof.edgeGable")}`}
                onChange={(ev) => setEdge(e, ev.target.checked ? { kind: "gable" } : { kind: "default" })}
              />
              {t("objinfo.roof.edgeGable")}
            </label>
          </div>
        );
      })}
      {roof.hasEdgePitch && (
        <div className="objinfo-field">
          <button
            type="button"
            className="objinfo-typebtn"
            onClick={() => host.onSetRoofPatch({ edgePitchDeg: undefined })}
          >
            {t("objinfo.roof.edgesReset")}
          </button>
        </div>
      )}
    </>
  );
}

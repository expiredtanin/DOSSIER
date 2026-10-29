// Fenster-/Tür-Dialog: Detail-Panels ([102] Rahmen je Seite, Flügel, Pfosten/Kämpfer, Profile,
// Anschlag je Seite, Türzargen-Arten; [103] Schichteinzug je Wandschicht und Seite) und die Live-
// Vorschau aus dem Kern (Grundriss, Schnitt, Ansicht der Öffnung als SVG).
// Jedes Panel bearbeitet entweder den Typ (alle Öffnungen) oder nur diese Öffnung (Übersteuerung).

import { useEffect, useState } from "react";
import { t } from "../i18n";
import type {
  CasingSides,
  DoorFrameDetail,
  DoorType,
  FrameDetail,
  LayerReveal,
  Opening,
  OpeningSides,
  Project,
  RevealMode,
  RevealSide,
} from "../model/types";
import { openingPreviewSvgs, type OpeningPreviewSvgs } from "../core";

type Side = "left" | "right" | "top" | "bottom";
const SIDES: Side[] = ["left", "right", "top", "bottom"];

/** Zahlenfeld (Meter); leer = Vorgabe (`undefined`). */
function OptNum({ label, value, onChange, placeholder }: { label: string; value: number | undefined; onChange: (v: number | undefined) => void; placeholder?: string }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => setText(value == null ? "" : String(value)), [value]);
  return (
    <label className="oed-field">
      <span className="oed-flabel">{label}</span>
      <input
        className="oed-input"
        type="number"
        step={0.005}
        min={0}
        inputMode="decimal"
        placeholder={placeholder ?? t("oed.default")}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (e.target.value.trim() === "") return onChange(undefined);
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n >= 0) onChange(n);
        }}
      />
    </label>
  );
}

function clean<T extends object>(o: T): T | undefined {
  const out = Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  return Object.keys(out).length ? out : undefined;
}

/** Vier Seitenfelder (links/rechts/oben/unten). */
function SidesFields({ label, value, onChange, sides = SIDES }: { label: string; value: OpeningSides | undefined; onChange: (v: OpeningSides | undefined) => void; sides?: Side[] }) {
  return (
    <fieldset className="oed-group">
      <legend>{label}</legend>
      {sides.map((s) => (
        <OptNum key={s} label={t(`oed.side.${s}`)} value={value?.[s]} onChange={(v) => onChange(clean({ ...value, [s]: v }))} />
      ))}
    </fieldset>
  );
}

/** Umschalter: Änderungen gelten für den Typ (alle) oder nur für diese Öffnung. */
export function ScopeSwitch({ scope, onScope, overridden, onReset }: { scope: "type" | "opening"; onScope: (s: "type" | "opening") => void; overridden: boolean; onReset: () => void }) {
  return (
    <div className="oed-scope">
      <label>
        <input type="radio" checked={scope === "type"} onChange={() => onScope("type")} /> {t("oed.scope.type")}
      </label>
      <label>
        <input type="radio" checked={scope === "opening"} onChange={() => onScope("opening")} /> {t("oed.scope.opening")}
      </label>
      {overridden && (
        <button type="button" className="oed-btn" onClick={onReset} title={t("oed.scope.resetHint")}>
          {t("oed.scope.reset")}
        </button>
      )}
    </div>
  );
}

/** Rahmen-Detail: Blendrahmen je Seite, Flügelrahmen, Pfosten/Kämpfer, Zusatzprofile. */
export function FrameDetailPanel({ value, onChange, isDoor }: { value: FrameDetail | undefined; onChange: (v: FrameDetail | undefined) => void; isDoor: boolean }) {
  const set = (patch: Partial<FrameDetail>) => onChange(clean({ ...value, ...patch }));
  return (
    <>
      <SidesFields label={t("oed.fd.frameSides")} value={value?.frameSides} onChange={(v) => set({ frameSides: v })} />
      <fieldset className="oed-group">
        <legend>{t("oed.fd.position")}</legend>
        <OptNum label={t("oed.f.frameDepth")} value={value?.frameDepth} onChange={(v) => set({ frameDepth: v })} />
        <label className="oed-field">
          <span className="oed-flabel">{t("oed.f.insetFace")}</span>
          <select className="oed-select" value={value?.insetFace ?? ""} onChange={(e) => set({ insetFace: (e.target.value || undefined) as FrameDetail["insetFace"] })}>
            <option value="">{t("oed.default")}</option>
            <option value="aussen">{t("oed.insetFace.aussen")}</option>
            <option value="innen">{t("oed.insetFace.innen")}</option>
            <option value="mitte">{t("oed.insetFace.mitte")}</option>
          </select>
        </label>
        <OptNum label={t("oed.f.insetFromFace")} value={value?.insetFromFace} onChange={(v) => set({ insetFromFace: v })} />
      </fieldset>
      {!isDoor && (
        <>
          <fieldset className="oed-group">
            <legend>{t("oed.fd.sash")}</legend>
            <OptNum label={t("oed.fd.sashWidth")} value={value?.sashWidth} onChange={(v) => set({ sashWidth: v })} />
            <OptNum label={t("oed.fd.sashDepth")} value={value?.sashDepth} onChange={(v) => set({ sashDepth: v })} />
            <OptNum label={t("oed.fd.sashOverlap")} value={value?.sashOverlap} onChange={(v) => set({ sashOverlap: v })} />
          </fieldset>
          <fieldset className="oed-group">
            <legend>{t("oed.fd.mullions")}</legend>
            <OptNum label={t("oed.fd.mullionWidth")} value={value?.mullionWidth} onChange={(v) => set({ mullionWidth: v })} />
            <OptNum label={t("oed.fd.mullionDepth")} value={value?.mullionDepth} onChange={(v) => set({ mullionDepth: v })} />
            <OptNum label={t("oed.fd.transomWidth")} value={value?.transomWidth} onChange={(v) => set({ transomWidth: v })} />
            <OptNum label={t("oed.fd.transomDepth")} value={value?.transomDepth} onChange={(v) => set({ transomDepth: v })} />
          </fieldset>
          <SidesFields label={t("oed.fd.extension")} value={value?.extensionProfiles} onChange={(v) => set({ extensionProfiles: v })} sides={["left", "right"]} />
          <fieldset className="oed-group">
            <legend>{t("oed.fd.profiles")}</legend>
            <OptNum label={t("oed.fd.sillProfile")} value={value?.sillProfile} onChange={(v) => set({ sillProfile: v })} placeholder="0" />
            <OptNum label={t("oed.fd.shadingProfile")} value={value?.shadingProfile} onChange={(v) => set({ shadingProfile: v })} placeholder="0" />
          </fieldset>
        </>
      )}
    </>
  );
}

/** Anschlag je Seite (übersteuert `rebateDepth`). */
export function RebatePanel({ value, onChange, isDoor }: { value: FrameDetail | undefined; onChange: (v: FrameDetail | undefined) => void; isDoor: boolean }) {
  return (
    <>
      <div className="oed-hint">{t("oed.rebate.hint")}</div>
      <SidesFields label={t("oed.cat.anschlag")} value={value?.rebates} onChange={(v) => onChange(clean({ ...value, rebates: v }))} sides={isDoor ? ["left", "right", "top"] : SIDES} />
    </>
  );
}

const FRAME_KINDS: NonNullable<DoorType["frameKind"]>[] = ["zarge", "umfassungszarge", "eckzarge", "blockzarge", "blockrahmen", "blendrahmen", "futter"];

/** Türzarge/-rahmen: Art und Masse (Falz, Spiegel, Futter, Bekleidung). */
export function DoorFramePanel({ kind, onKind, value, onChange }: { kind: DoorType["frameKind"] | undefined; onKind: (k: DoorType["frameKind"] | undefined) => void; value: DoorFrameDetail | undefined; onChange: (v: DoorFrameDetail | undefined) => void }) {
  const set = (patch: Partial<DoorFrameDetail>) => onChange(clean({ ...value, ...patch }));
  const k = kind ?? "zarge";
  const steel = k === "umfassungszarge" || k === "eckzarge";
  return (
    <>
      <label className="oed-field">
        <span className="oed-flabel">{t("oed.df.kind")}</span>
        <select className="oed-select" value={kind ?? ""} onChange={(e) => onKind((e.target.value || undefined) as DoorType["frameKind"])}>
          <option value="">{t("oed.default")}</option>
          {FRAME_KINDS.map((f) => (
            <option key={f} value={f}>
              {t(`oed.df.kind.${f}`)}
            </option>
          ))}
        </select>
      </label>
      <div className="oed-hint">{t(`oed.df.hint.${k}`)}</div>
      {k !== "zarge" && (
        <fieldset className="oed-group">
          <legend>{t("oed.df.falz")}</legend>
          <OptNum label={t("oed.df.falzWidth")} value={value?.falzWidth} onChange={(v) => set({ falzWidth: v })} placeholder="0.015" />
          <OptNum label={t("oed.df.falzDepth")} value={value?.falzDepth} onChange={(v) => set({ falzDepth: v })} placeholder="0.04" />
        </fieldset>
      )}
      {steel && (
        <fieldset className="oed-group">
          <legend>{t("oed.df.steel")}</legend>
          <OptNum label={t("oed.df.spiegel")} value={value?.spiegel} onChange={(v) => set({ spiegel: v })} placeholder="0.05" />
          <OptNum label={t("oed.df.sheet")} value={value?.sheetThickness} onChange={(v) => set({ sheetThickness: v })} placeholder="0.002" />
        </fieldset>
      )}
      {k === "futter" && (
        <fieldset className="oed-group">
          <legend>{t("oed.df.casing")}</legend>
          <OptNum label={t("oed.df.lining")} value={value?.liningThickness} onChange={(v) => set({ liningThickness: v })} placeholder="0.025" />
          <OptNum label={t("oed.df.casingWidth")} value={value?.casingWidth} onChange={(v) => set({ casingWidth: v })} placeholder="0.07" />
          <OptNum label={t("oed.df.casingThickness")} value={value?.casingThickness} onChange={(v) => set({ casingThickness: v })} placeholder="0.012" />
          <label className="oed-field">
            <span className="oed-flabel">{t("oed.df.casingSides")}</span>
            <select className="oed-select" value={value?.casingSides ?? "beide"} onChange={(e) => set({ casingSides: e.target.value as CasingSides })}>
              {(["beide", "aufschlag", "gegen", "keine"] as const).map((c) => (
                <option key={c} value={c}>
                  {t(`oed.df.casingSides.${c}`)}
                </option>
              ))}
            </select>
          </label>
        </fieldset>
      )}
    </>
  );
}

const MODES: RevealMode[] = ["buendig", "zurueck", "leibung", "ueberdaemmt"];

/** Vorgaben (wie `opening_detail::reveal_presets` im Kern). */
export const REVEAL_PRESETS: { id: string; rules: LayerReveal[] }[] = [
  { id: "buendig", rules: [] },
  { id: "ueberdaemmt3_putzLeibung", rules: [{ layer: 0, mode: "ueberdaemmt", amount: 0.03 }, { layer: -1, mode: "leibung" }] },
  { id: "leibungsdaemmung_putzLeibung", rules: [{ layer: 0, mode: "leibung", amount: 0.03 }, { layer: -1, mode: "leibung" }] },
  { id: "innenZurueck", rules: [{ layer: -1, mode: "zurueck" }] },
  { id: "putzLeibungBeidseitig", rules: [{ layer: 0, mode: "leibung" }, { layer: -1, mode: "leibung" }] },
];

/** Id der Vorgabe, der die Regeln gleichen (Reihenfolge egal), sonst "custom". */
export function revealPresetOf(rules: LayerReveal[]): string {
  const key = (rs: LayerReveal[]) => JSON.stringify(rs.map((r) => [r.layer, r.mode, r.amount ?? null, !!(r.left || r.right || r.top || r.bottom)]).sort());
  return REVEAL_PRESETS.find((p) => key(p.rules) === key(rules))?.id ?? "custom";
}

/** Schichteinzug: je Schicht der Wirtswand Regel für alle Seiten, je Seite übersteuerbar. */
export function RevealPanel({ project, opening, value, onChange }: { project: Project; opening: Opening; value: LayerReveal[] | undefined; onChange: (v: LayerReveal[] | undefined) => void }) {
  const wall = project.walls.find((w) => w.id === opening.hostWallId);
  const layers = project.wallTypes.find((w) => w.id === wall?.wallTypeId)?.layers ?? [];
  const n = layers.length;
  const rules = value ?? [];
  const idx = (r: LayerReveal) => (r.layer < 0 ? n + Math.round(r.layer) : Math.round(r.layer));
  const ruleOf = (i: number) => rules.find((r) => idx(r) === i);
  const setRule = (i: number, r: LayerReveal | undefined) => {
    const rest = rules.filter((x) => idx(x) !== i);
    const next = r ? [...rest, r] : rest;
    onChange(next.length ? next : []);
  };
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <label className="oed-field">
        <span className="oed-flabel">{t("oed.rv.preset")}</span>
        <select
          className="oed-select"
          value=""
          onChange={(e) => {
            const p = REVEAL_PRESETS.find((x) => x.id === e.target.value);
            if (p) onChange(p.rules.map((r) => ({ ...r })));
          }}
        >
          <option value="">{t("oed.rv.choose")}</option>
          {REVEAL_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {t(`oed.rv.preset.${p.id}`)}
            </option>
          ))}
        </select>
      </label>
      {n === 0 && <div className="oed-hint">{t("oed.rv.noLayers")}</div>}
      <table className="oed-reveal-table">
        <thead>
          <tr>
            <th>{t("oed.rv.layer")}</th>
            <th>{t("oed.rv.mode")}</th>
            <th>{t("oed.rv.amount")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {layers.map((l, i) => {
            const r = ruleOf(i);
            const comp = project.components.find((c) => c.id === l.componentId);
            return [
              <tr key={i}>
                <td>
                  {comp?.name ?? l.componentId} <span className="oed-dim">{(l.thickness * 100).toFixed(1)} cm</span>
                </td>
                <td>
                  <select className="oed-select" value={r?.mode ?? "buendig"} onChange={(e) => setRule(i, e.target.value === "buendig" && !r?.left && !r?.right && !r?.top && !r?.bottom ? undefined : { ...(r ?? { layer: i }), layer: r?.layer ?? i, mode: e.target.value as RevealMode })}>
                    {MODES.map((m) => (
                      <option key={m} value={m}>
                        {t(`oed.rv.mode.${m}`)}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className="oed-input"
                    type="number"
                    step={0.005}
                    min={0}
                    placeholder={t("oed.default")}
                    value={r?.amount ?? ""}
                    disabled={!r || r.mode === "buendig"}
                    onChange={(e) => r && setRule(i, { ...r, amount: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) })}
                  />
                </td>
                <td>
                  <button type="button" className="oed-btn" disabled={!r} onClick={() => setOpen(open === i ? null : i)} title={t("oed.rv.perSideHint")}>
                    {t("oed.rv.perSide")}
                  </button>
                </td>
              </tr>,
              open === i && r ? (
                <tr key={`${i}-s`}>
                  <td colSpan={4}>
                    {SIDES.map((s) => {
                      const sr: RevealSide | undefined = r[s];
                      return (
                        <span key={s} className="oed-side-rule">
                          {t(`oed.side.${s}`)}{" "}
                          <select className="oed-select" value={sr?.mode ?? ""} onChange={(e) => setRule(i, { ...r, [s]: e.target.value ? { mode: e.target.value as RevealMode, amount: sr?.amount } : undefined })}>
                            <option value="">{t("oed.rv.likeAll")}</option>
                            {MODES.map((m) => (
                              <option key={m} value={m}>
                                {t(`oed.rv.mode.${m}`)}
                              </option>
                            ))}
                          </select>
                          {sr && (
                            <input
                              className="oed-input oed-input-short"
                              type="number"
                              step={0.005}
                              min={0}
                              value={sr.amount ?? ""}
                              placeholder={t("oed.default")}
                              onChange={(e) => setRule(i, { ...r, [s]: { ...sr, amount: e.target.value === "" ? undefined : Math.max(0, Number(e.target.value)) } })}
                            />
                          )}
                        </span>
                      );
                    })}
                  </td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
      <div className="oed-hint">{t("oed.rv.hint")}</div>
    </>
  );
}

/** Live-Vorschau aus dem Kern: Grundriss (fein), Schnitt und Ansicht der Öffnung. */
export function CorePreview({ project, openingId }: { project: Project; openingId: string }) {
  const [svgs, setSvgs] = useState<OpeningPreviewSvgs | null>(null);
  const [view, setView] = useState<"plan" | "section" | "elevation">("plan");
  useEffect(() => {
    let alive = true;
    const h = setTimeout(() => {
      openingPreviewSvgs(project, openingId)
        .then((s) => alive && setSvgs(s))
        .catch(() => alive && setSvgs(null));
    }, 120);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [project, openingId]);
  const svg = svgs?.[view] ?? null;
  return (
    <div className="oed-core-preview">
      <div className="oed-preview-tabs">
        {(["plan", "section", "elevation"] as const).map((v) => (
          <button key={v} type="button" className={`oed-cat${view === v ? " active" : ""}`} onClick={() => setView(v)}>
            {t(`oed.preview.${v}`)}
          </button>
        ))}
      </div>
      {svg ? <img className="oed-preview-svg" alt={t(`oed.preview.${view}`)} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`} /> : <div className="oed-hint">{t("oed.preview.none")}</div>}
    </div>
  );
}

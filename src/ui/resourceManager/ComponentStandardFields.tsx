// Bauteil-Kennwerte und Ansichtsschraffur ([94]–[95]): λ, Rohdichte, VKF-Brandverhalten, Ansichtsfarbe und
// das Oberflächenmuster (Art, Richtung, Masse). Teil des Bauteil-Details im Ressourcen-Manager.

import type { Component, SurfacePattern } from "../../model/types";
import { t } from "../../i18n";
import { ColorField, FieldRow, NumberField, SelectField } from "./fields";

type Kind = SurfacePattern["kind"];
const KINDS: Kind[] = ["lines", "boardBatten", "runningBond", "shingles", "trapezoid", "polygonal", "grid"];
const FIRE = ["", "RF1", "RF2", "RF3", "RF4"];

/** Vorgaben je Musterart (Meter), damit ein neu gewähltes Muster sofort sinnvoll aussieht. */
const DEFAULTS: Record<Kind, Omit<SurfacePattern, "kind">> = {
  lines: { spacing: 0.08 },
  boardBatten: { spacing: 0.2, width: 0.06 },
  runningBond: { spacing: 0.26, height: 0.075 },
  shingles: { spacing: 0.1, height: 0.12 },
  trapezoid: { spacing: 0.2, width: 0.06 },
  polygonal: { spacing: 0.45, height: 0.35 },
  grid: { spacing: 1.25, height: 0.625 },
};

const posOrUndef = (v: number) => (Number.isFinite(v) && v > 0 ? v : undefined);

export function ComponentStandardFields({
  component,
  onPatch,
}: {
  component: Component;
  onPatch: (patch: Partial<Component>) => void;
}) {
  const sp = component.surfacePattern;
  const patchPattern = (p: Partial<SurfacePattern>) => sp && onPatch({ surfacePattern: { ...sp, ...p } });
  return (
    <>
      <FieldRow label={t("resources.col.lambda")}>
        <NumberField value={component.lambda ?? 0} step={0.001} min={0} onChange={(v) => onPatch({ lambda: posOrUndef(v) })} />
      </FieldRow>
      <FieldRow label={t("resources.col.density")}>
        <NumberField value={component.density ?? 0} step={10} min={0} onChange={(v) => onPatch({ density: posOrUndef(v) })} />
      </FieldRow>
      <FieldRow label={t("resources.col.fireClass")}>
        <SelectField
          value={component.fireClass ?? ""}
          onChange={(v) => onPatch({ fireClass: v || undefined })}
          options={FIRE.map((f) => ({ value: f, label: f || t("resources.col.fireClass.none") }))}
        />
      </FieldRow>
      <FieldRow label={t("resources.col.elevationColor")}>
        <ColorField color={component.elevationColor ?? component.color} onChange={(elevationColor) => onPatch({ elevationColor })} />
      </FieldRow>
      <FieldRow label={t("resources.col.surfacePattern")} hint={t("resources.col.surfacePattern.hint")}>
        <SelectField
          value={sp?.kind ?? ""}
          onChange={(k) => onPatch({ surfacePattern: k ? { ...DEFAULTS[k as Kind], kind: k as Kind } : undefined })}
          options={[
            { value: "", label: t("resources.surfacePattern.none") },
            ...KINDS.map((k) => ({ value: k, label: t(`resources.surfacePattern.${k}`) })),
          ]}
        />
      </FieldRow>
      {sp && (
        <>
          <FieldRow label={t("resources.surfacePattern.direction")}>
            <SelectField
              value={sp.direction ?? ""}
              onChange={(d) => patchPattern({ direction: (d || undefined) as SurfacePattern["direction"] })}
              options={[
                { value: "", label: t("resources.surfacePattern.direction.auto") },
                { value: "vertical", label: t("resources.surfacePattern.direction.vertical") },
                { value: "horizontal", label: t("resources.surfacePattern.direction.horizontal") },
              ]}
            />
          </FieldRow>
          <FieldRow label={t("resources.surfacePattern.spacing")}>
            <NumberField value={sp.spacing} step={0.01} min={0.005} onChange={(v) => v > 0 && patchPattern({ spacing: v })} />
          </FieldRow>
          <FieldRow label={t("resources.surfacePattern.height")}>
            <NumberField value={sp.height ?? sp.spacing} step={0.005} min={0} onChange={(v) => patchPattern({ height: posOrUndef(v) })} />
          </FieldRow>
          <FieldRow label={t("resources.surfacePattern.width")}>
            <NumberField value={sp.width ?? 0} step={0.005} min={0} onChange={(v) => patchPattern({ width: posOrUndef(v) })} />
          </FieldRow>
        </>
      )}
    </>
  );
}

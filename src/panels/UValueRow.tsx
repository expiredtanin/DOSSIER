// U-Wert aus dem Schichtaufbau ([71], SIA 180 / EN ISO 6946) als Zeile im Objekt-Info (Wand/Decke/Dach) und als
// Zeile im Ressourcen-Manager (Wand-/Decken-/Dachtyp). Gerechnet wird im Kern (`u_value.rs`); fehlt einer Schicht
// λ, steht „unvollständig" statt einer falschen Zahl.

import { useMemo } from "react";
import type { Layer, Project } from "../model/types";
import { t } from "../i18n";
import { uValueOf } from "../core";
import type { ElementKind, UValueResult } from "../core";

function safe(f: () => UValueResult | null): UValueResult | null {
  try {
    return f();
  } catch {
    return null;
  }
}

function valueText(u: UValueResult): string {
  return u.complete && u.u !== null ? `${u.u.toFixed(2)} W/(m²K)` : t("uvalue.incomplete", { n: u.missing });
}

function hint(u: UValueResult): string {
  const base = `R = ${u.r.toFixed(2)} m²K/W`;
  return u.ventilated ? `${base} · ${t("uvalue.ventilated")}` : base;
}

/** Objekt-Info: U-Wert des Aufbaus (Typ-Id); nichts ohne Typ. */
export function UValueRow({ project, kind, typeId }: { project: Project; kind: ElementKind; typeId: string | undefined }) {
  const u = useMemo(() => (typeId ? safe(() => uValueOf(project, kind, { typeId })) : null), [project, kind, typeId]);
  if (!u) return null;
  return (
    <div className="objinfo-field" data-uvalue>
      <span className="objinfo-flabel">{t("uvalue.label")}</span>
      <span className="objinfo-fval" title={hint(u)}>{valueText(u)}</span>
    </div>
  );
}

/** Ressourcen-Manager: U-Wert der gerade bearbeiteten Schichten (live). */
export function UValueLine({ project, kind, layers }: { project: Project; kind: ElementKind; layers: readonly Layer[] }) {
  const u = useMemo(() => safe(() => uValueOf(project, kind, { layers })), [project, kind, layers]);
  if (!u) return null;
  return (
    <div className="res-hint" data-uvalue title={hint(u)}>
      {t("uvalue.label")}: <b>{valueText(u)}</b> · {hint(u)}
    </div>
  );
}

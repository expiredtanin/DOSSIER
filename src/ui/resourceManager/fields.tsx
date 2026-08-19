// Wiederverwendbare Feld-Bausteine (DOSSIER-Look) für den Ressourcen-Manager.
// Alle Steuerelemente füllen ihre Tabellenzelle (width:100%) und werden über
// die Spaltenbreite des Grids dimensioniert; Zahlenfelder sind rechtsbündig.
// Von ALLEN Tabs geteilt — hier ändern wirkt sich auf jede Ressourcen-Tabelle
// aus.

import { useRef } from "react";
import { Dropdown } from "../Dropdown";
import { t } from "../../i18n";

/** Kompaktes Textfeld (Pill) für Namen/Platzhalter. */
export function TextField({
  value,
  onChange,
  placeholder,
  mono = false,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <input
      type="text"
      className={`res-input${mono ? " mono" : ""}`}
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** Zahlenfeld (Pill, rechtsbündig, monospace) mit Live-Commit. */
export function NumberField({
  value,
  onChange,
  step = 1,
  min,
  max,
  list,
}: {
  value: number;
  onChange: (v: number) => void;
  step?: number;
  min?: number;
  max?: number;
  /** Optionale <datalist>-ID mit Vorschlagswerten (z. B. Stiftstärken). */
  list?: string;
}) {
  return (
    <input
      type="number"
      className="res-input mono num"
      value={Number.isFinite(value) ? value : 0}
      step={step}
      min={min}
      max={max}
      list={list}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (!Number.isNaN(v)) onChange(v);
      }}
    />
  );
}

/**
 * Farb-Swatch mit nativem Color-Picker. Das <label> umschließt einen
 * sichtbaren Swatch und den unsichtbaren color-input — Klick öffnet den
 * Picker, der Swatch zeigt die Farbe live (nach DOSSIER ColorBar).
 */
export function ColorField({
  color,
  onChange,
}: {
  color: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="res-color" title={color}>
      <span className="res-color-swatch" style={{ background: color }} />
      <input
        type="color"
        value={color}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

/** Pill-Dropdown (nutzt die gemeinsame Dropdown-Komponente statt <select>). */
export function SelectField<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <Dropdown
      value={value}
      onChange={(v) => onChange(v as T)}
      options={options}
    />
  );
}

/** Runder Löschen-Knopf (Mülleimer-Icon) in der letzten Spalte. */
export function DeleteButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button className="res-delete" title={title} onClick={onClick}>
      <svg
        width={15}
        height={15}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />
        <path d="M10 11v6M14 11v6" />
      </svg>
    </button>
  );
}

/**
 * Segmentierter Umschalter (Pillen-Gruppe) für kleine, sich ausschließende
 * Auswahlen — z. B. Schraffur-Typ Vektor/Bild oder Linien-Typ Strich/Zickzack.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="res-seg" role="group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`res-seg-btn${value === o.value ? " active" : ""}`}
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Eine beschriftete Detail-Zeile (Label links, Steuerelement rechts). Bewusst
 * ein <div> (kein <label>): Zeilen enthalten teils mehrere interaktive Elemente
 * (Segmented-Buttons), und ein umschließendes <label> würde den Klick an das
 * ERSTE labelbare Kind umleiten — das würde einen Segment-Klick sofort wieder
 * zurücksetzen. Die Steuerelemente sind selbst klickbar; ein Label ist unnötig.
 */
export function FieldRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="res-field" title={hint}>
      <span className="res-field-label">{label}</span>
      <span className="res-field-control">{children}</span>
    </div>
  );
}

/** Leerer Listen-/Ergebniszustand mit zentriertem Hinweistext. */
export function EmptyState({ text }: { text: string }) {
  return <div className="res-empty">{text}</div>;
}

/** Versteckter Bild-Datei-Picker mit sichtbarem Button. */
export function ImagePickButton({ onFile }: { onFile: (file: File | null) => void }) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button className="res-add mat-pick" onClick={() => ref.current?.click()}>
        {t("material.upload.choose")}
      </button>
      <input
        ref={ref}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          onFile(e.target.files?.[0] ?? null);
          e.target.value = "";
        }}
      />
    </>
  );
}

/**
 * Datei-Import-Schaltfläche (verstecktes <input type=file>). Liest die gewählte
 * Datei als Text und reicht ihn nach oben. Für .lin/.pat-Import.
 */
export function FileImportButton({
  accept,
  label,
  onText,
}: {
  accept: string;
  label: string;
  onText: (text: string) => void;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  return (
    <>
      <button className="res-add" onClick={() => ref.current?.click()}>
        {label}
      </button>
      <input
        ref={ref}
        type="file"
        accept={accept}
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            const r = new FileReader();
            r.onload = () => onText(String(r.result ?? ""));
            r.readAsText(f);
          }
          e.target.value = "";
        }}
      />
    </>
  );
}

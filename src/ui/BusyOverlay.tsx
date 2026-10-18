import { useBusy } from "../state/busyStore";

/** Vollflächiger "Bitte warten"-Hinweis, solange `busyStore` ein Label hält. */
export function BusyOverlay() {
  const label = useBusy();
  if (!label) return null;
  return (
    <div className="busy-overlay" role="status" aria-live="polite">
      <div className="busy-card">
        <div className="busy-spinner" aria-hidden="true" />
        <div className="busy-label">{label}</div>
      </div>
    </div>
  );
}

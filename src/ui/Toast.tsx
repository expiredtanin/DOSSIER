// Toast — nicht-blockierende Kurzmeldungen (Ersatz für `window.alert`, das im
// Tauri-WKWebView deaktiviert ist und lautlos nichts tut, siehe
// state/notifySlice.ts). Liest `notifications` aus dem Store und rendert
// einen gestapelten Container oben rechts; jede Meldung verschwindet
// automatisch nach ~4s oder per Klick sofort.
//
// Auto-Dismiss-Timer sitzt HIER (nicht in der Slice): jede gemountete Meldung
// bekommt so GENAU einen Timer, sauber an ihren Lebenszyklus gebunden (kein
// Doppel-Timer bei erneutem `notify()`-Aufruf mit identischer Nachricht).
//
// Bezeichner englisch, UI-Text/Kommentare deutsch (CONVENTIONS.md).

import { useEffect } from "react";
import { useStore } from "../state/appStore";
import { t } from "../i18n";
import type { NotifyKind } from "../state/notifySlice";

const AUTO_DISMISS_MS = 4000;

/** Top-level Toast-Stack — einmal in App.tsx gerendert. */
export function Toast() {
  const notifications = useStore((s) => s.notifications);
  const dismissNotify = useStore((s) => s.dismissNotify);

  if (notifications.length === 0) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {notifications.map((n) => (
        <ToastItem
          key={n.id}
          id={n.id}
          message={n.message}
          kind={n.kind}
          onDismiss={dismissNotify}
        />
      ))}
    </div>
  );
}

function ToastItem({
  id,
  message,
  kind,
  onDismiss,
}: {
  id: string;
  message: string;
  kind: NotifyKind;
  onDismiss: (id: string) => void;
}) {
  // Auto-Dismiss: EIN Timer pro gemounteter Meldung, an ihre id gebunden.
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
    // onDismiss ist referenzstabil (Store-Action) — bewusst nur auf `id` reagieren.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  return (
    <div
      className={`toast-item toast-${kind}`}
      onClick={() => onDismiss(id)}
      role="alert"
    >
      <span className="toast-message">{message}</span>
      <button
        type="button"
        className="toast-close"
        aria-label={t("dock.close")}
        onClick={(e) => {
          e.stopPropagation();
          onDismiss(id);
        }}
      >
        ×
      </button>
    </div>
  );
}

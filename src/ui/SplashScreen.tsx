// Kurzer Marken-Splash beim Start, bevor der Startbildschirm (StartScreen)
// erscheint. BEWUSST keine künstliche Wartezeit/„Ladebalken"-Inszenierung:
// kommerzielle CAD-Programme brauchen beim Start oft mehrere Sekunden für
// Lizenzserver-Handshakes, riesige Bauteil-/Vorlagenbibliotheken und
// historisch gewachsene Plugin-Ketten — wir starten schnell, WEIL es nichts
// dergleichen gibt, nicht obwohl wir etwas Echtes überspringen. Die einzige
// Wartezeit hier ist eine kurze, feste Mindestdauer für die Markenwirkung
// (sonst nur ein Flackern bei einem sehr schnellen Rechner) — kein Fake-Fortschritt.
//
// Der stille Update-Check (state/checkForUpdate.ts) läuft bewusst NICHT hier,
// sondern unabhängig im Hintergrund weiter (App.tsx) — ein langsames/nicht
// erreichbares Netz soll den Start nie verzögern.
import { useEffect } from "react";

/** Mindest-Anzeigedauer (ms) — rein für die Markenwirkung, kein simulierter Ladevorgang. */
const MIN_VISIBLE_MS = 500;

export function SplashScreen({ onDone }: { onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, MIN_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <div className="splash-screen">
      <div className="splash-brand">
        dossier<span className="brand-dot">.</span>
      </div>
    </div>
  );
}

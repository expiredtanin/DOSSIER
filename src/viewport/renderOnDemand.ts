// [290] Zeichnen nur auf Anforderung: Jede Änderung (Kamera, Modell, Sonne, Hervorhebung …) MELDET einen Frame an,
// gezeichnet wird höchstens einmal je Bildschirm-Frame (requestAnimationFrame). Vorher zeichnete der 3D-Viewport bei
// jedem Aufruf sofort — eine Maus mit 1000 Hz Abtastrate löste beim Drehen bis zu 1000 GPU-Frames je Sekunde aus, und
// eine Änderung, die mehrere Effekte berührt, zeichnete mehrfach hintereinander. Ohne Anforderung läuft keine Schleife;
// im Hintergrund/minimiert ruft der Browser rAF nicht auf, es wird also auch nicht gezeichnet.

type Raf = (cb: (t: number) => void) => number;
type Caf = (id: number) => void;

/** Gezeichnete Frames je Ansicht — Prüf-Hook für e2e (`window.__dossierFrames`), keine Logik hängt daran. */
export interface FrameCounters {
  "3d": number;
  "2d": number;
}

export function frameCounters(): FrameCounters {
  const g = globalThis as unknown as { __dossierFrames?: FrameCounters };
  if (!g.__dossierFrames) g.__dossierFrames = { "3d": 0, "2d": 0 };
  return g.__dossierFrames;
}

export function countFrame(kind: keyof FrameCounters): void {
  frameCounters()[kind] += 1;
}

export class FrameScheduler {
  private id: number | null = null;

  constructor(
    private readonly draw: () => void,
    private readonly raf: Raf = (cb) => requestAnimationFrame(cb),
    private readonly caf: Caf = (id) => cancelAnimationFrame(id),
  ) {}

  /** Ist ein Frame angemeldet, aber noch nicht gezeichnet? */
  get pending(): boolean {
    return this.id !== null;
  }

  /** Einen Frame anmelden; mehrere Anmeldungen vor dem nächsten Bildschirm-Frame ergeben EINEN Zeichenaufruf. */
  request(): void {
    if (this.id !== null) return;
    this.id = this.raf(() => {
      this.id = null;
      this.draw();
    });
  }

  /** Angemeldeten Frame sofort zeichnen (wer gleich danach die Leinwand ausliest, z. B. Vorschaubild). */
  flush(): void {
    if (this.id === null) return;
    this.caf(this.id);
    this.id = null;
    this.draw();
  }

  cancel(): void {
    if (this.id !== null) this.caf(this.id);
    this.id = null;
  }
}

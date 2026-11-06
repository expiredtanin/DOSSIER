/**
 * Frame-Aufrufe an die native Metal-Fläche (`native2d_frame`) bündeln ([145]).
 *
 * Höchstens ein Aufruf ist unterwegs; kommt währenddessen ein neuer, ersetzt er
 * den wartenden (der letzte gewinnt). `onSent` läuft SYNCHRON in dem Moment, in
 * dem der Aufruf abgeschickt wird — nicht erst, wenn er beantwortet ist. Dort
 * setzt die Plan-Ansicht den Ausschnitt des SVG-Overlays (Raumstempel, Textfelder,
 * Griffe): so landet er im SELBEN Rendering-Update der Webview, in dem die native
 * Fläche ihren Frame zeichnet. Früher wurde das Overlay erst nach der Antwort
 * gesetzt — die Webview malte es dann einen Frame später, und die Texte liefen
 * beim Zoomen sichtbar hinter der Geometrie her.
 */
export class NativeFrameQueue {
  private busy = false;
  private next: { job: () => Promise<unknown>; onSent?: () => void } | null = null;

  constructor(private readonly onError: (e: unknown) => void = () => {}) {}

  send(job: () => Promise<unknown>, onSent?: () => void): void {
    if (this.busy) {
      this.next = { job, onSent };
      return;
    }
    this.busy = true;
    this.run(job, onSent);
  }

  private run(job: () => Promise<unknown>, onSent?: () => void): void {
    let p: Promise<unknown>;
    try {
      p = job();
    } catch (e) {
      p = Promise.reject(e);
    }
    onSent?.();
    void p.catch(this.onError).finally(() => {
      const n = this.next;
      this.next = null;
      if (n) this.run(n.job, n.onSent);
      else this.busy = false;
    });
  }
}

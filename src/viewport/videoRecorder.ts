// [246] Video aus einem Canvas im Browser, ohne Server: `canvas.captureStream` + `MediaRecorder`. WebM (VP9/VP8) kennt jeder
// Chromium-Browser, MP4 (H.264) nur, wenn der Browser es aufnehmen kann (Safari, neuere Chromium). Unter Tauri/WKWebView
// kann `MediaRecorder` oder `captureStream` fehlen — dann liefern die Prüfungen false und der Aufrufer meldet es sauber.
// Rein: keine Abhängigkeit von React oder dem Viewport; die Browser-Klassen sind für Tests austauschbar.

export type VideoFormatId = "mp4" | "webm";

export interface VideoFormat {
  id: VideoFormatId;
  /** Der tatsächlich unterstützte MIME-Typ (mit Codec), den `MediaRecorder` bekommt. */
  mime: string;
  /** Dateiendung ohne Punkt. */
  ext: string;
}

const CANDIDATES: { id: VideoFormatId; ext: string; mimes: string[] }[] = [
  { id: "mp4", ext: "mp4", mimes: ["video/mp4;codecs=avc1.42E01E", "video/mp4;codecs=avc1", "video/mp4"] },
  { id: "webm", ext: "webm", mimes: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"] },
];

/** Kleinster gemeinsamer Teil von `MediaRecorder`, den wir brauchen (für Tests ersetzbar). */
export interface RecorderLike {
  state: string;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
  onerror: ((e: unknown) => void) | null;
  start(timesliceMs?: number): void;
  stop(): void;
}
export interface RecorderCtor {
  new (stream: MediaStream, options?: { mimeType?: string; videoBitsPerSecond?: number }): RecorderLike;
  isTypeSupported?(mime: string): boolean;
}

function recorderCtor(): RecorderCtor | null {
  const g = globalThis as { MediaRecorder?: RecorderCtor };
  return typeof g.MediaRecorder === "function" ? g.MediaRecorder : null;
}

/** Unterstützte Formate, MP4 zuerst (wenn der Browser es kann), dann WebM. Leer ohne `MediaRecorder`. */
export function availableVideoFormats(ctor: RecorderCtor | null = recorderCtor()): VideoFormat[] {
  if (!ctor || typeof ctor.isTypeSupported !== "function") return [];
  const out: VideoFormat[] = [];
  for (const c of CANDIDATES) {
    const mime = c.mimes.find((m) => {
      try {
        return ctor.isTypeSupported!(m);
      } catch {
        return false;
      }
    });
    if (mime) out.push({ id: c.id, mime, ext: c.ext });
  }
  return out;
}

/** Kann auf diesem Canvas aufgenommen werden (MediaRecorder und `captureStream` vorhanden, mindestens ein Format)? */
export function canRecordCanvas(canvas: { captureStream?: unknown } | null | undefined, ctor: RecorderCtor | null = recorderCtor()): boolean {
  return !!canvas && typeof canvas.captureStream === "function" && availableVideoFormats(ctor).length > 0;
}

export interface Recording {
  /** Beendet die Aufnahme und liefert das Video. */
  stop(): Promise<Blob>;
  /** Verwirft die Aufnahme ohne Ergebnis. */
  cancel(): void;
}

/**
 * Nimmt den Canvas mit `fps` Bildern/s auf. Wirft, wenn `captureStream`/`MediaRecorder` fehlen oder der Browser die
 * Aufnahme verweigert (der Aufrufer fängt das und meldet es).
 */
export function startRecording(
  canvas: HTMLCanvasElement,
  opts: { fps: number; format: VideoFormat; bitsPerSecond?: number },
  ctor: RecorderCtor | null = recorderCtor(),
): Recording {
  if (!ctor) throw new Error("MediaRecorder fehlt");
  if (typeof canvas.captureStream !== "function") throw new Error("captureStream fehlt");
  const stream = canvas.captureStream(opts.fps);
  const chunks: Blob[] = [];
  const rec = new ctor(stream, { mimeType: opts.format.mime, ...(opts.bitsPerSecond ? { videoBitsPerSecond: opts.bitsPerSecond } : {}) });
  let failure: unknown = null;
  let cancelled = false;
  const stopTracks = () => stream.getTracks().forEach((t) => t.stop());
  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  rec.onerror = (e) => {
    failure = e ?? new Error("Aufnahmefehler");
  };
  const done = new Promise<Blob>((resolve, reject) => {
    rec.onstop = () => {
      stopTracks();
      if (cancelled) return reject(new Error("abgebrochen"));
      if (failure) return reject(failure instanceof Error ? failure : new Error("Aufnahmefehler"));
      resolve(new Blob(chunks, { type: opts.format.mime.split(";")[0] }));
    };
  });
  // Ohne Beobachter soll ein verworfenes `done` keinen unbehandelten Fehler auslösen.
  done.catch(() => {});
  rec.start(250);
  return {
    stop: () => {
      if (rec.state !== "inactive") rec.stop();
      return done;
    },
    cancel: () => {
      cancelled = true;
      if (rec.state !== "inactive") rec.stop();
      else stopTracks();
    },
  };
}

/** Dateiname für das Video: `<projekt>-kamerafahrt.<ext>`. */
export function videoFileName(projectName: string, ext: string): string {
  return `${(projectName || "projekt").replace(/[^\w.-]+/g, "_")}-kamerafahrt.${ext}`;
}

import { describe, expect, it } from "vitest";
import { availableVideoFormats, canRecordCanvas, startRecording, videoFileName, type RecorderCtor, type RecorderLike } from "./videoRecorder";

function fakeCtor(supported: string[]): RecorderCtor & { last?: RecorderLike } {
  class Fake implements RecorderLike {
    static last?: Fake;
    state = "inactive";
    ondataavailable: RecorderLike["ondataavailable"] = null;
    onstop: RecorderLike["onstop"] = null;
    onerror: RecorderLike["onerror"] = null;
    constructor(public stream: MediaStream, public options?: { mimeType?: string }) {
      Fake.last = this;
    }
    static isTypeSupported(m: string) {
      return supported.includes(m);
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob(["abc"]) });
      this.onstop?.();
    }
  }
  return Fake as unknown as RecorderCtor & { last?: RecorderLike };
}

const canvasWith = (): HTMLCanvasElement => {
  let stopped = 0;
  const track = { stop: () => stopped++ };
  const c = { captureStream: () => ({ getTracks: () => [track] }), get stopped() { return stopped; } };
  return c as unknown as HTMLCanvasElement;
};

describe("[246] Videoaufnahme", () => {
  it("Formate: MP4 nur, wenn der Browser es kann; WebM mit dem besten Codec", () => {
    expect(availableVideoFormats(null)).toEqual([]);
    expect(availableVideoFormats(fakeCtor([])).length).toBe(0);
    expect(availableVideoFormats(fakeCtor(["video/webm;codecs=vp8", "video/webm"])).map((f) => f.id)).toEqual(["webm"]);
    const both = availableVideoFormats(fakeCtor(["video/mp4", "video/webm;codecs=vp9", "video/webm"]));
    expect(both.map((f) => f.id)).toEqual(["mp4", "webm"]);
    expect(both[1]!.mime).toBe("video/webm;codecs=vp9");
  });

  it("Aufnahme nur mit captureStream und Format", () => {
    const ctor = fakeCtor(["video/webm"]);
    expect(canRecordCanvas(canvasWith(), ctor)).toBe(true);
    expect(canRecordCanvas({}, ctor)).toBe(false);
    expect(canRecordCanvas(null, ctor)).toBe(false);
    expect(canRecordCanvas(canvasWith(), null)).toBe(false);
  });

  it("startRecording liefert nach stop ein Blob und stoppt die Spuren; ohne MediaRecorder wirft es", async () => {
    const ctor = fakeCtor(["video/webm"]);
    const canvas = canvasWith();
    const rec = startRecording(canvas, { fps: 30, format: { id: "webm", mime: "video/webm", ext: "webm" } }, ctor);
    const blob = await rec.stop();
    expect(blob.size).toBe(3);
    expect(blob.type).toBe("video/webm");
    expect((canvas as unknown as { stopped: number }).stopped).toBe(1);
    expect(() => startRecording(canvas, { fps: 30, format: { id: "webm", mime: "video/webm", ext: "webm" } }, null)).toThrow();
    expect(() => startRecording({} as HTMLCanvasElement, { fps: 30, format: { id: "webm", mime: "video/webm", ext: "webm" } }, ctor)).toThrow();
  });

  it("cancel verwirft ohne unbehandelten Fehler", async () => {
    const ctor = fakeCtor(["video/webm"]);
    const rec = startRecording(canvasWith(), { fps: 30, format: { id: "webm", mime: "video/webm", ext: "webm" } }, ctor);
    rec.cancel();
    await expect(rec.stop()).rejects.toThrow();
  });

  it("Dateiname", () => {
    expect(videoFileName("Haus Süd", "webm")).toBe("Haus_S_d-kamerafahrt.webm");
    expect(videoFileName("", "mp4")).toBe("projekt-kamerafahrt.mp4");
  });
});

// Visueller Farbwähler (klassisches Picker-Muster): eine Fläche für
// Sättigung (X) × Hellwert (Y) plus ein Farbton-Regler darunter. Arbeitet in
// HSV, weil genau das die zwei Achsen der Fläche sind — der Aufrufer
// (`ColorMixer.tsx`) hält den HSV-Puffer, damit der Farbton beim Ziehen in
// die schwarze/weisse Ecke nicht verloren geht (dort ist er mathematisch
// undefiniert, s. `model/color.ts`).
//
// Ohne Canvas: die Fläche ist die übliche Überlagerung aus zwei CSS-
// Verläufen (weiss→transparent horizontal, transparent→schwarz vertikal)
// über der vollgesättigten Farbtonfarbe.

import { useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { Hsv } from "../model/color";

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export function SpectrumPicker({ hsv, onChange }: { hsv: Hsv; onChange: (next: Hsv) => void }) {
  const areaRef = useRef<HTMLDivElement | null>(null);
  const hueRef = useRef<HTMLDivElement | null>(null);

  /** Zieh-Geste auf Fläche/Regler: Pointer-Capture, damit sie auch ausserhalb weiterläuft. */
  const drag = (
    ref: typeof areaRef,
    e: ReactPointerEvent,
    apply: (fx: number, fy: number) => void,
  ) => {
    const el = ref.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    const move = (clientX: number, clientY: number) => {
      const r = el.getBoundingClientRect();
      apply(clamp01((clientX - r.left) / r.width), clamp01((clientY - r.top) / r.height));
    };
    move(e.clientX, e.clientY);
    const onMove = (ev: PointerEvent) => move(ev.clientX, ev.clientY);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div className="spectrum-picker">
      <div
        ref={areaRef}
        className="spectrum-area"
        style={{ background: `hsl(${hsv.h}, 100%, 50%)` }}
        onPointerDown={(e) =>
          drag(areaRef, e, (fx, fy) =>
            onChange({ ...hsv, s: Math.round(fx * 100), v: Math.round((1 - fy) * 100) }),
          )
        }
      >
        <span className="spectrum-area-white" />
        <span className="spectrum-area-black" />
        <span
          className="spectrum-handle"
          style={{ left: `${hsv.s}%`, top: `${100 - hsv.v}%` }}
        />
      </div>
      <div
        ref={hueRef}
        className="spectrum-hue"
        onPointerDown={(e) => drag(hueRef, e, (fx) => onChange({ ...hsv, h: Math.round(fx * 360) }))}
      >
        <span className="spectrum-handle spectrum-handle-hue" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>
    </div>
  );
}

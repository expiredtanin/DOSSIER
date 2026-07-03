/**
 * Kompatibilitäts-Shim für die WASM-Engines (render2d/render3d, beide wgpu 22):
 * wgpu 22 sendet in `requestDevice` noch das Limit `maxInterStageShaderComponents`,
 * das AUS DER WebGPU-Spec ENTFERNT wurde. Neuere Chromium-Builds lehnen einen
 * nicht-`undefined`-Wert dafür mit `OperationError` ab (→ Device-Erzeugung
 * schlägt fehl). Wir entfernen den Schlüssel EINMAL global aus dem Descriptor,
 * bevor wgpu ihn stellt. Entfällt, sobald die Engines auf ein wgpu (+ glyphon)
 * hochgezogen werden, das dieses Limit nicht mehr mitschickt.
 */

let requestDevicePatched = false;

export function patchRequestDeviceLimits(): void {
  if (requestDevicePatched) return;
  const AdapterCtor = (globalThis as any).GPUAdapter;
  if (!AdapterCtor?.prototype?.requestDevice) return;
  const orig = AdapterCtor.prototype.requestDevice;
  AdapterCtor.prototype.requestDevice = function (
    this: unknown,
    desc?: any,
  ) {
    if (desc?.requiredLimits && "maxInterStageShaderComponents" in desc.requiredLimits) {
      const requiredLimits = { ...desc.requiredLimits };
      delete requiredLimits.maxInterStageShaderComponents;
      desc = { ...desc, requiredLimits };
    }
    return orig.call(this, desc);
  };
  requestDevicePatched = true;
}

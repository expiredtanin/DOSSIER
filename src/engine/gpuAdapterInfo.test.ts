import { describe, expect, it } from "vitest";
import { describeAdapter, isSoftwareAdapter, summarizeAdapter } from "./gpuAdapterInfo";

describe("[290] WebGPU-Adapter", () => {
  it("SwiftShader/llvmpipe/Fallback gelten als Software", () => {
    expect(isSoftwareAdapter({ vendor: "google", architecture: "swiftshader" })).toBe(true);
    expect(isSoftwareAdapter({ vendor: "mesa", description: "llvmpipe (LLVM 15.0.7, 256 bits)" })).toBe(true);
    expect(isSoftwareAdapter({ vendor: "amd", architecture: "rdna-3" }, true)).toBe(true);
    expect(isSoftwareAdapter({ vendor: "amd", architecture: "rdna-3", description: "AMD Radeon RX 7800 XT" })).toBe(false);
  });

  it("Kurztext", () => {
    expect(describeAdapter(summarizeAdapter({ vendor: "amd", architecture: "rdna-3", description: "AMD Radeon RX 7800 XT" }))).toBe("amd rdna-3 (AMD Radeon RX 7800 XT)");
    expect(describeAdapter(summarizeAdapter({ vendor: "apple", architecture: "metal-3" }))).toBe("apple metal-3");
    expect(describeAdapter(summarizeAdapter({}))).toBe("");
  });
});

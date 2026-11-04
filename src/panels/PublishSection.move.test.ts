// [79] Reihenfolge der Blätter im Publikationssatz: ↑/↓ tauschen Nachbarn, am Rand nichts.
import { describe, expect, it } from "vitest";
import { move } from "./PublishSection";

describe("move", () => {
  it("tauscht mit dem Nachbarn", () => {
    expect(move(["a", "b", "c"], 1, -1)).toEqual(["b", "a", "c"]);
    expect(move(["a", "b", "c"], 1, 1)).toEqual(["a", "c", "b"]);
  });
  it("am Rand unverändert", () => {
    expect(move(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(move(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { threadContentMatchLabel } from "./CommandPaletteResults";

describe("threadContentMatchLabel", () => {
  it("distinguishes previous titles from message authors", () => {
    expect(threadContentMatchLabel("title")).toBe("Previously titled:");
    expect(threadContentMatchLabel("user")).toBe("You:");
    expect(threadContentMatchLabel("assistant")).toBe("Agent:");
  });
});

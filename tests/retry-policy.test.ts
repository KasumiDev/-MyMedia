import { describe, expect, it } from "vitest";
import { isEmptySuggestion, randomDelay } from "../src/core/retry-policy";

describe("retry policy", () => {
  it("keeps randomized delays inside their range", () => {
    expect(randomDelay({ min: 4, max: 8 }, () => 0)).toBe(4);
    expect(randomDelay({ min: 4, max: 8 }, () => .999)).toBe(8);
  });
  it("identifies only the intermittent empty-suggestion shape", () => {
    expect(isEmptySuggestion({ response: { mediaOfferSuggestions: [] } })).toBe(true);
    expect(isEmptySuggestion({ response: { mediaOfferSuggestions: [], data: [] } })).toBe(false);
  });
});

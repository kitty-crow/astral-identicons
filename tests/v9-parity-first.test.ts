import { describe, expect, test } from "bun:test";
import { input } from "../src/input.ts";
import { decodeV9Candidates, uniqueV9Candidate } from "../src/scan-v9-core.ts";
import { v9Parity, type V9ByteObservation } from "../src/record-v9.ts";

const value = input({
  seed: "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
  solar: "capricorn",
  lunar: "virgo",
  ascendant: "capricorn",
  midheaven: "libra",
  descendant: "cancer",
  imumCoeli: "aries"
});

function parityWithErasures(count: number): V9ByteObservation[] {
  return [...v9Parity(value)].map((byte, index) => {
    return index < count
      ? { value: null, confidence: 0 }
      : { value: byte, confidence: 0.99 };
  });
}

function plain(candidate: typeof value): typeof value {
  return {
    seed: candidate.seed,
    solar: candidate.solar,
    lunar: candidate.lunar,
    ascendant: candidate.ascendant,
    midheaven: candidate.midheaven,
    descendant: candidate.descendant,
    imumCoeli: candidate.imumCoeli
  };
}

describe("V9 parity-first decoding", () => {
  test("recovers the complete key and signs from 37 readable parity bytes", () => {
    const candidates = decodeV9Candidates([], [], parityWithErasures(91));
    const unique = uniqueV9Candidate(candidates);

    expect(unique).toBeDefined();
    expect(plain(unique!.value)).toEqual(plain(value));
    expect(unique!.erasedBytes).toBe(128);
    expect(unique!.correctedErrors).toBe(0);
  });

  test("rejects when only 36 parity bytes remain readable", () => {
    const candidates = decodeV9Candidates([], [], parityWithErasures(92));
    expect(candidates).toEqual([]);
  });
});

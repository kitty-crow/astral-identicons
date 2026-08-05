import { describe, expect, test } from "bun:test";
import { input } from "../src/input.ts";
import { seedDataByteCount, seedSlotCount } from "../src/seed.ts";
import { starParityCodeword, type ByteObservation } from "../src/star-parity.ts";
import {
  VisualCaptureSeries,
  type VisualCaptureSnapshot
} from "../src/visual-series.ts";

const sample = input({
  seed: "6270f2-example",
  solar: "capricorn",
  lunar: "virgo",
  ascendant: "capricorn",
  midheaven: "libra",
  descendant: "cancer",
  imumCoeli: "aries"
});

function observations(
  values: Uint8Array,
  included: ReadonlySet<number>,
  confidence = 0.98
): readonly ByteObservation[] {
  return [...values].map((value, index) => ({
    value: included.has(index) ? value : null,
    confidence: included.has(index) ? confidence : 0
  }));
}

function conflictingObservations(
  values: Uint8Array,
  included: ReadonlySet<number>,
  maskValue: number,
  confidence: number
): readonly ByteObservation[] {
  return [...values].map((value, index) => ({
    value: included.has(index) ? value ^ maskValue : null,
    confidence: included.has(index) ? confidence : 0
  }));
}

function mask(length: number, indexes: readonly number[]): readonly boolean[] {
  const included = new Set(indexes);
  return Array.from({ length }, (_unused, index) => included.has(index));
}

function spread(count: number): number[] {
  const indexes = new Set<number>();
  let value = 7;

  while (indexes.size < count) {
    indexes.add(value % seedSlotCount);
    value += 29;
  }

  return [...indexes];
}

describe("human cumulative scanner capture", () => {
  test("combines two brief moments separated by a long gap", () => {
    const series = new VisualCaptureSeries();
    const codeword = starParityCodeword(sample);
    const selected = spread(seedDataByteCount);
    let snapshot: VisualCaptureSnapshot;

    snapshot = series.add({
      at: 0,
      stars: observations(codeword, new Set(selected.slice(0, 20))),
      quality: 0.88,
      centre: mask(9, [0, 1, 2, 3]),
      ring: mask(12, [0, 1, 2, 3, 4])
    });

    expect(snapshot.ready).toBe(false);
    expect(snapshot.observedStars).toBe(20);

    snapshot = series.add({
      at: 12_000,
      stars: observations(codeword, new Set(selected.slice(20))),
      quality: 0.91,
      centre: mask(9, [4, 5, 6, 7, 8]),
      ring: mask(12, [5, 6, 7, 8, 9, 10, 11])
    });

    expect(snapshot.ready).toBe(true);
    expect(snapshot.frames).toBe(2);
    expect(snapshot.usefulMilliseconds).toBe(350);
    expect(snapshot.observedStars).toBe(seedDataByteCount);
    expect(snapshot.requiredStars).toBe(seedDataByteCount);
    expect(snapshot.centreFound).toBe(9);
    expect(snapshot.ringFound).toBe(12);
    expect(snapshot.reading?.value).toEqual(sample);
    expect(snapshot.reading?.reconstructedStars).toBe(88);
  });

  test("does not lose saved stars when time passes", () => {
    const series = new VisualCaptureSeries();
    const codeword = starParityCodeword(sample);
    const selected = new Set(spread(25));

    series.add({
      at: 0,
      stars: observations(codeword, selected),
      quality: 0.8,
      centre: mask(9, [0, 1]),
      ring: mask(12, [0, 1])
    });

    const muchLater = series.snapshot();
    expect(muchLater.observedStars).toBe(25);
    expect(muchLater.centreFound).toBe(2);
    expect(muchLater.ringFound).toBe(2);
  });

  test("later shaky frames cannot reduce the saved count or erase a reconstruction", () => {
    const series = new VisualCaptureSeries();
    const codeword = starParityCodeword(sample);
    const selected = new Set(spread(80));

    const first = series.add({
      at: 0,
      stars: observations(codeword, selected, 0.99),
      quality: 0.94,
      centre: mask(9, [0, 1, 2, 3, 4, 5, 6, 7, 8]),
      ring: mask(12, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    });

    expect(first.observedStars).toBe(80);
    expect(first.reading?.value).toEqual(sample);

    series.add({
      at: 120,
      stars: conflictingObservations(codeword, selected, 0x55, 0.82),
      quality: 0.72,
      centre: mask(9, []),
      ring: mask(12, [])
    });

    const afterSecondShake = series.add({
      at: 240,
      stars: conflictingObservations(codeword, selected, 0xaa, 0.8),
      quality: 0.7,
      centre: mask(9, []),
      ring: mask(12, [])
    });

    expect(afterSecondShake.observedStars).toBe(80);
    expect(afterSecondShake.ready).toBe(true);
    expect(afterSecondShake.reading?.value).toEqual(sample);
    expect(afterSecondShake.centreFound).toBe(9);
    expect(afterSecondShake.ringFound).toBe(12);
  });

  test("continued agreement after frame eight can overturn an early wrong consensus", () => {
    const series = new VisualCaptureSeries();
    const codeword = starParityCodeword(sample);
    const selected = new Set(spread(seedSlotCount));
    let at = 0;
    let snapshot: VisualCaptureSnapshot | undefined;

    for (let frame = 0; frame < 8; frame += 1) {
      snapshot = series.add({
        at,
        stars: conflictingObservations(codeword, selected, 0x55, 0.98),
        quality: 0.94,
        centre: mask(9, [0, 1, 2, 3, 4, 5, 6, 7, 8]),
        ring: mask(12, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
      });
      at += 100;
    }

    expect(snapshot?.reading).toBe(undefined);

    for (let frame = 0; frame < 40; frame += 1) {
      snapshot = series.add({
        at,
        stars: observations(codeword, selected, 0.78),
        quality: 0.82,
        centre: mask(9, [0, 1, 2, 3, 4, 5, 6, 7, 8]),
        ring: mask(12, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
      });
      at += 100;
    }

    expect(snapshot?.frames).toBe(48);
    expect(snapshot?.observedStars).toBe(seedSlotCount);
    expect(snapshot?.reading?.value).toEqual(sample);
  });
});

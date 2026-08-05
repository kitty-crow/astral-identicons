import { seedDataByteCount, seedSlotCount } from "./seed.ts";
import {
  byteObservation,
  type ByteObservation,
  type StarComponentObservation
} from "./star-parity.ts";
import { recoverVisualCode, type VisualCodeReading } from "./visual-code.ts";

export interface VisualCaptureEvidence {
  readonly at: number;
  readonly stars: readonly ByteObservation[];
  readonly quality: number;
  readonly centre: readonly boolean[];
  readonly ring: readonly boolean[];
}

export interface VisualCaptureSnapshot {
  readonly usefulMilliseconds: number;
  readonly frames: number;
  readonly locatedStars: number;
  readonly observedStars: number;
  readonly requiredStars: number;
  readonly centreFound: number;
  readonly ringFound: number;
  readonly stars: readonly ByteObservation[];
  readonly reading: VisualCodeReading | undefined;
  readonly ready: boolean;
}

interface ComponentEvidence {
  readonly scores: Float64Array;
  readonly support: Uint32Array;
}

interface SlotEvidence {
  readonly position: ComponentEvidence;
  readonly size: ComponentEvidence;
  readonly opacity: ComponentEvidence;
}

interface ComponentReading {
  readonly value: number | null;
  readonly confidence: number;
}

type Components = Omit<StarComponentObservation, "value" | "confidence">;

function componentEvidence(values: number): ComponentEvidence {
  return {
    scores: new Float64Array(values),
    support: new Uint32Array(values)
  };
}

function slotEvidence(): SlotEvidence {
  return {
    position: componentEvidence(16),
    size: componentEvidence(4),
    opacity: componentEvidence(4)
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function componentReading(evidence: ComponentEvidence): ComponentReading {
  let bestValue = 0;
  let best = 0;
  let second = 0;
  let bestSupport = 0;

  for (let value = 0; value < evidence.scores.length; value += 1) {
    const score = evidence.scores[value] ?? 0;

    if (score > best) {
      second = best;
      best = score;
      bestValue = value;
      bestSupport = evidence.support[value] ?? 0;
      continue;
    }

    if (score > second) second = score;
  }

  if (best < 0.12 || bestSupport === 0) {
    return { value: null, confidence: 0 };
  }

  const margin = (best - second) / Math.max(best, 0.001);
  const repetition = Math.min(1, bestSupport / 4);

  return {
    value: bestValue,
    confidence: clamp(margin * 0.82 + repetition * 0.18)
  };
}

function starReading(evidence: SlotEvidence): StarComponentObservation {
  const position = componentReading(evidence.position);
  const size = componentReading(evidence.size);
  const opacity = componentReading(evidence.opacity);
  const components: Components = {
    position: position.value,
    sizeLevel: size.value,
    opacityLevel: opacity.value,
    positionConfidence: position.confidence,
    sizeConfidence: size.confidence,
    opacityConfidence: opacity.confidence
  };
  const combined = byteObservation(components);

  return {
    ...components,
    value: combined.value,
    confidence: combined.confidence
  };
}

function componentsOf(observation: ByteObservation): Components {
  if (
    "position" in observation &&
    "sizeLevel" in observation &&
    "opacityLevel" in observation &&
    "positionConfidence" in observation &&
    "sizeConfidence" in observation &&
    "opacityConfidence" in observation
  ) {
    return observation as StarComponentObservation;
  }

  if (observation.value === null) {
    return {
      position: null,
      sizeLevel: null,
      opacityLevel: null,
      positionConfidence: observation.confidence,
      sizeConfidence: observation.confidence,
      opacityConfidence: observation.confidence
    };
  }

  return {
    position: observation.value >>> 4,
    sizeLevel: (observation.value & 0x0f) >>> 2,
    opacityLevel: observation.value & 0x03,
    positionConfidence: observation.confidence,
    sizeConfidence: observation.confidence,
    opacityConfidence: observation.confidence
  };
}

export class VisualCaptureSeries {
  readonly #stars = Array.from({ length: seedSlotCount }, slotEvidence);
  #centre: boolean[] = [];
  #ring: boolean[] = [];
  #frames = 0;
  #usefulMilliseconds = 0;
  #lastUsefulAt: number | undefined;
  #reading: VisualCodeReading | undefined;

  clear(): void {
    for (const evidence of this.#stars) {
      for (const component of [
        evidence.position,
        evidence.size,
        evidence.opacity
      ]) {
        component.scores.fill(0);
        component.support.fill(0);
      }
    }
    this.#centre = [];
    this.#ring = [];
    this.#frames = 0;
    this.#usefulMilliseconds = 0;
    this.#lastUsefulAt = undefined;
    this.#reading = undefined;
  }

  add(value: VisualCaptureEvidence): VisualCaptureSnapshot {
    if (value.stars.length !== this.#stars.length) {
      throw new Error(`capture requires ${this.#stars.length} parity stars`);
    }

    const weight = 0.35 + Math.max(0, Math.min(1, value.quality)) * 0.65;
    this.addEvidence(value.stars, weight);
    this.mergeRegions(value.centre, value.ring);

    if (this.#lastUsefulAt === undefined) {
      this.#usefulMilliseconds += 100;
    } else {
      this.#usefulMilliseconds += Math.max(
        40,
        Math.min(250, value.at - this.#lastUsefulAt)
      );
    }

    this.#lastUsefulAt = value.at;
    this.#frames += 1;
    return this.snapshot();
  }

  snapshot(): VisualCaptureSnapshot {
    const components = this.#stars.map(starReading);
    const stars: ByteObservation[] = components.map((value) => ({
      value: value.value,
      confidence: value.confidence
    }));
    const locatedStars = components.filter((value) => {
      return value.position !== null;
    }).length;
    const observedStars = stars.filter((value) => value.value !== null).length;

    if (!this.#reading && observedStars >= seedDataByteCount) {
      try {
        this.#reading = recoverVisualCode(stars);
      } catch {
        this.#reading = undefined;
      }
    }

    return {
      usefulMilliseconds: this.#usefulMilliseconds,
      frames: this.#frames,
      locatedStars,
      observedStars,
      requiredStars: seedDataByteCount,
      centreFound: this.#centre.filter(Boolean).length,
      ringFound: this.#ring.filter(Boolean).length,
      stars,
      reading: this.#reading,
      ready: Boolean(this.#reading)
    };
  }

  private addComponent(
    evidence: ComponentEvidence,
    value: number | null,
    confidence: number,
    weight: number
  ): void {
    if (value === null) return;

    const certainty = Math.max(0, Math.min(1, confidence));
    const score = weight * (0.02 + certainty * certainty * 0.98);

    evidence.scores[value] = (evidence.scores[value] ?? 0) + score;
    evidence.support[value] = (evidence.support[value] ?? 0) + 1;
  }

  private addEvidence(
    observations: readonly ByteObservation[],
    weight: number
  ): void {
    for (let index = 0; index < observations.length; index += 1) {
      const observation = componentsOf(observations[index]!);
      const evidence = this.#stars[index]!;

      this.addComponent(
        evidence.position,
        observation.position,
        observation.positionConfidence,
        weight
      );
      this.addComponent(
        evidence.size,
        observation.sizeLevel,
        observation.sizeConfidence,
        weight
      );
      this.addComponent(
        evidence.opacity,
        observation.opacityLevel,
        observation.opacityConfidence,
        weight
      );
    }
  }

  private mergeRegions(
    centre: readonly boolean[],
    ring: readonly boolean[]
  ): void {
    if (this.#centre.length === 0) this.#centre = Array(centre.length).fill(false);
    if (this.#ring.length === 0) this.#ring = Array(ring.length).fill(false);

    for (let index = 0; index < this.#centre.length; index += 1) {
      this.#centre[index] ||= centre[index] ?? false;
    }

    for (let index = 0; index < this.#ring.length; index += 1) {
      this.#ring[index] ||= ring[index] ?? false;
    }
  }
}

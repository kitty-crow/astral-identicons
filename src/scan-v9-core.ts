import {
  planetaryIdentityCandidates,
  type PlanetaryObservation
} from "./planet-code.ts";
import {
  recoverV9Record,
  v9DataByteCount,
  v9IdentityByteCount,
  v9Record,
  v9RecordMagic,
  v9RecordVersion,
  type V9ByteObservation
} from "./record-v9.ts";
import { base64Url, bindPublicKey } from "./seed-value.ts";
import type { Sign } from "./sign.ts";
import type { IdenticonInput } from "./types.ts";

export const v9SignRoles = [
  "solar",
  "lunar",
  "ascendant",
  "midheaven",
  "descendant",
  "imumCoeli"
] as const;

export type V9SignRole = (typeof v9SignRoles)[number];

export interface V9SignAlternative {
  readonly sign: Sign;
  readonly confidence: number;
}

export interface V9SignObservation {
  readonly role: V9SignRole;
  readonly alternatives: readonly V9SignAlternative[];
}

export interface V9DecodedCandidate {
  readonly value: IdenticonInput;
  readonly score: number;
  readonly primaryConfidence: number;
  readonly parityConfidence: number;
  readonly correctedErrors: number;
  readonly erasedBytes: number;
}

export interface V9DecodeOptions {
  readonly planetCandidateLimit?: number;
  readonly signCandidateLimit?: number;
  readonly resultLimit?: number;
  readonly alternativesPerPlanet?: number;
  readonly alternativesPerSign?: number;
}

interface SignBeam {
  readonly signs: Readonly<Record<V9SignRole, Sign>>;
  readonly score: number;
}

const emptySigns = {} as Record<V9SignRole, Sign>;
const knownHeader: readonly V9ByteObservation[] = [
  { value: v9RecordMagic, confidence: 1 },
  { value: v9RecordVersion, confidence: 1 },
  { value: v9IdentityByteCount, confidence: 1 }
] as const;

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return result;
}

function signCandidates(
  observations: readonly V9SignObservation[],
  limit: number,
  alternativesPerRole: number
): readonly SignBeam[] {
  const byRole = new Map<V9SignRole, V9SignObservation>();

  for (const observation of observations) {
    if (byRole.has(observation.role)) {
      throw new Error(`duplicate sign observation for ${observation.role}`);
    }
    byRole.set(observation.role, observation);
  }

  let beams: readonly SignBeam[] = [{
    signs: emptySigns,
    score: 0
  }];

  for (const role of v9SignRoles) {
    const observation = byRole.get(role);
    if (!observation || observation.alternatives.length === 0) return [];

    const alternatives = [...observation.alternatives]
      .filter((alternative) => Number.isFinite(alternative.confidence))
      .filter((alternative) => alternative.confidence > 0)
      .sort((left, right) => right.confidence - left.confidence)
      .slice(0, alternativesPerRole);
    const expanded: SignBeam[] = [];

    for (const beam of beams) {
      for (const alternative of alternatives) {
        expanded.push({
          signs: {
            ...beam.signs,
            [role]: alternative.sign
          },
          score: beam.score + Math.log(Math.max(alternative.confidence, 1e-12))
        });
      }
    }

    beams = expanded
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
  }

  return beams;
}

function value(
  identity: Uint8Array,
  signs: Readonly<Record<V9SignRole, Sign>>
): IdenticonInput {
  return bindPublicKey({
    seed: base64Url(identity),
    solar: signs.solar,
    lunar: signs.lunar,
    ascendant: signs.ascendant,
    midheaven: signs.midheaven,
    descendant: signs.descendant,
    imumCoeli: signs.imumCoeli
  }, identity);
}

function observationRecord(
  candidate: IdenticonInput,
  confidence: number
): readonly V9ByteObservation[] {
  return [...v9Record(candidate)].map((byte) => ({
    value: byte,
    confidence
  }));
}

function parityOnlyRecord(): readonly V9ByteObservation[] {
  return Array.from({ length: v9DataByteCount }, (_unused, index) => {
    return knownHeader[index] ?? { value: null, confidence: 0 };
  });
}

function key(value: IdenticonInput): string {
  return [
    value.seed,
    value.solar,
    value.lunar,
    value.ascendant,
    value.midheaven,
    value.descendant,
    value.imumCoeli
  ].join("|");
}

function score(
  primaryConfidence: number,
  parityConfidence: number,
  errors: number
): number {
  const primary = Math.max(primaryConfidence, 1e-12);
  const parity = Math.max(parityConfidence, 1e-12);
  return Math.sqrt(primary * parity) / (1 + errors * 0.25);
}

function parityOnlyCandidate(
  parity: readonly V9ByteObservation[]
): V9DecodedCandidate | undefined {
  try {
    const recovered = recoverV9Record({
      data: parityOnlyRecord(),
      parity
    });
    return {
      value: recovered.value,
      score: score(1, recovered.confidence, recovered.errors),
      primaryConfidence: 1,
      parityConfidence: recovered.confidence,
      correctedErrors: recovered.errors,
      erasedBytes: recovered.erasures
    };
  } catch {
    return undefined;
  }
}

export function decodeV9Candidates(
  planets: readonly PlanetaryObservation[],
  signs: readonly V9SignObservation[],
  parity: readonly V9ByteObservation[],
  options: V9DecodeOptions = {}
): readonly V9DecodedCandidate[] {
  const planetCandidateLimit = boundedInteger(
    options.planetCandidateLimit,
    64,
    1,
    4_096,
    "planet candidate limit"
  );
  const signCandidateLimit = boundedInteger(
    options.signCandidateLimit,
    64,
    1,
    4_096,
    "sign candidate limit"
  );
  const resultLimit = boundedInteger(
    options.resultLimit,
    32,
    1,
    1_024,
    "result limit"
  );
  const alternativesPerPlanet = boundedInteger(
    options.alternativesPerPlanet,
    8,
    1,
    64,
    "alternatives per planet"
  );
  const alternativesPerSign = boundedInteger(
    options.alternativesPerSign,
    4,
    1,
    12,
    "alternatives per sign"
  );

  const decoded = new Map<string, V9DecodedCandidate>();
  const parityOnly = parityOnlyCandidate(parity);
  if (parityOnly) decoded.set(key(parityOnly.value), parityOnly);

  const identities = planetaryIdentityCandidates(
    planets,
    planetCandidateLimit,
    alternativesPerPlanet
  );
  const signSets = signCandidates(
    signs,
    signCandidateLimit,
    alternativesPerSign
  );

  for (const identity of identities) {
    for (const signSet of signSets) {
      const primaryConfidence = Math.sqrt(
        Math.max(identity.confidence, 1e-12) *
        Math.exp(signSet.score / v9SignRoles.length)
      );
      const candidate = value(identity.identity, signSet.signs);

      try {
        const recovered = recoverV9Record({
          data: observationRecord(candidate, primaryConfidence),
          parity
        });
        const candidateScore = score(
          primaryConfidence,
          recovered.confidence,
          recovered.errors
        );
        const decodedCandidate: V9DecodedCandidate = {
          value: recovered.value,
          score: candidateScore,
          primaryConfidence,
          parityConfidence: recovered.confidence,
          correctedErrors: recovered.errors,
          erasedBytes: recovered.erasures
        };
        const decodedKey = key(recovered.value);
        const previous = decoded.get(decodedKey);

        if (!previous || decodedCandidate.score > previous.score) {
          decoded.set(decodedKey, decodedCandidate);
        }
      } catch {
        // This primary candidate is inconsistent with the readable parity.
      }
    }
  }

  return [...decoded.values()]
    .sort((left, right) => right.score - left.score)
    .slice(0, resultLimit);
}

export function uniqueV9Candidate(
  candidates: readonly V9DecodedCandidate[],
  minimumMargin = 1.35
): V9DecodedCandidate | undefined {
  if (!Number.isFinite(minimumMargin) || minimumMargin <= 1) {
    throw new Error("v9 uniqueness margin must be greater than one");
  }

  const first = candidates[0];
  if (!first) return undefined;
  const second = candidates[1];
  if (!second) return first;
  return first.score >= second.score * minimumMargin ? first : undefined;
}

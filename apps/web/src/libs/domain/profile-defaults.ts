import type { ClientProfile } from "./profile";

const ADJECTIVES = [
  "brave",
  "calm",
  "clear",
  "bold",
  "cool",
  "quick",
  "crisp",
  "fresh",
  "eager",
  "fair",
  "soft",
  "gold",
  "happy",
  "kind",
  "light",
  "lucky",
  "mild",
  "merry",
  "misty",
  "noble",
  "quiet",
  "rapid",
  "blue",
  "snowy",
  "solar",
  "still",
  "sunny",
  "swift",
  "vivid",
  "warm",
  "wild",
  "wise",
] as const;

const NOUNS = [
  "acorn",
  "amber",
  "apple",
  "birch",
  "bird",
  "brook",
  "cedar",
  "cloud",
  "coral",
  "dawn",
  "dune",
  "fern",
  "fox",
  "owl",
  "grove",
  "bay",
  "hill",
  "lake",
  "leaf",
  "maple",
  "field",
  "moon",
  "ocean",
  "olive",
  "pearl",
  "pine",
  "river",
  "rock",
  "sky",
  "star",
  "sun",
  "oak",
] as const;

export function createDefaultProfileNames(): Pick<
  ClientProfile,
  "name" | "roomId"
> {
  const random = crypto.getRandomValues(new Uint32Array(5));
  // Only room names need the extra combinations; display names may repeat.
  // The suffix is not a room password or an identity/authentication token.
  const suffix = (random[4] % 1000)
    .toString()
    .padStart(3, "0");
  return {
    name: `${ADJECTIVES[random[0] % ADJECTIVES.length]} ${NOUNS[random[1] % NOUNS.length]}`,
    roomId: `${ADJECTIVES[random[2] % ADJECTIVES.length]}-${NOUNS[random[3] % NOUNS.length]}-${suffix}`,
  };
}

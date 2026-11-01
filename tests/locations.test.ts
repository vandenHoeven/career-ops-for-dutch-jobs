import test from "node:test";
import assert from "node:assert/strict";
import { scoreLocation } from "../src/locations.js";
import type { ProfileConfig, WorkArrangement } from "../src/types.js";

const profile: ProfileConfig = {
  country: "Netherlands", countryAliases: ["netherlands"], remoteAliases: ["remote netherlands"], roleFamilies: {}, excludeTitleTerms: [], expiryAfterMissedScans: 3,
  locationPreferences: { anchor: { city: "'s-Hertogenbosch", latitude: 51.6978, longitude: 5.3037 }, stronglyPreferredCities: ["Den Bosch", "Utrecht", "Eindhoven"], nearbyCities: ["Vught", "Tilburg"], distanceBandKm: 60, includeRestOfNetherlands: true, foreignLocations: "exclude" }
};
const score = (location: string, workArrangement: WorkArrangement = "unknown") => scoreLocation({ location, workArrangement }, profile);

test("location gradient prioritizes preferred region while retaining the Netherlands", () => {
  assert.equal(score("Utrecht, Netherlands").awarded, 10);
  assert.equal(score("Tilburg, Noord-Brabant").awarded, 9);
  assert.equal(score("Nijmegen, Netherlands").awarded, 7);
  assert.match(score("Nijmegen, Netherlands").evidence.join(" "), /km straight-line/);
  assert.equal(score("Amsterdam, Netherlands").awarded, 4);
  assert.equal(score("Remote Netherlands", "remote").awarded, 7);
});

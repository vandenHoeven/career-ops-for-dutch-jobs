import test from "node:test";
import assert from "node:assert/strict";
import { classifyLocationAccess, scoreLocation } from "../src/locations.js";
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

const accessProfile:ProfileConfig={...profile,locationPreferences:{...profile.locationPreferences!,accessibility:{easyMaxMinutes:45,mediumMaxMinutes:75,closeOverrideKm:40,modePenalties:{'direct-train':0,'train-transfer':10,bus:20},cityProfiles:[
  {city:'Utrecht',distanceKm:47,publicTransportMinutes:29,mode:'direct-train'},
  {city:'Amsterdam',distanceKm:81,publicTransportMinutes:56,mode:'direct-train'},
  {city:'Waalwijk',distanceKm:23,publicTransportMinutes:35,mode:'bus'},
  {city:'Delft',distanceKm:75,publicTransportMinutes:70,mode:'train-transfer'},
  {city:'Car Park',distanceKm:60,mode:'car-only'}
]}}};
const access=(location:string,workArrangement:WorkArrangement='unknown')=>classifyLocationAccess({location,workArrangement,raw:{}},accessProfile);

test('commute accessibility is explainable and independent of ranking points',()=>{
  assert.equal(access('Utrecht, Netherlands').tier,'easy');
  assert.equal(access('Amsterdam, Netherlands').tier,'medium');
  assert.equal(access('Waalwijk, Netherlands').tier,'easy','nearby bus locations use the local override');
  assert.equal(access('Delft, Netherlands').tier,'hard','transfer burden is included in effective minutes');
  assert.equal(access('Car Park, Netherlands').tier,'hard');
  assert.equal(access('Netherlands').tier,'unknown');
  assert.equal(access('Remote Netherlands','remote').tier,'remote');
  assert.equal(scoreLocation({location:'Amsterdam, Netherlands',workArrangement:'unknown'},accessProfile).awarded,4,'access settings do not alter location scoring');
});

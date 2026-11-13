import type { LocationAccessAssessment, LocationAccessCityProfile, LocationAccessTier, ProfileConfig, RawJob, WorkArrangement } from "./types.js";
import { DUTCH_LOCALITIES } from './dutch-localities.js';
import { normalize, phrase } from './text.js';

export interface LocationAssessment { state: 'netherlands' | 'foreign' | 'unknown'; evidence: string[] }
export function assessLocation(job: RawJob, profile: ProfileConfig): LocationAssessment {
  const raw = (job.raw ?? {}) as any;
  const countries: string[] = [];
  const country = (value: any) => { if (typeof value === 'string' && value.trim()) countries.push(value); else if(value && typeof value === 'object') country(value.name ?? value.addressCountry ?? value.countryCode ?? value.value); };
  country(job.countryCode); country(raw._diegoCountryCode); country(raw.countryCode); country(raw.country_code); country(raw.country);
  for(const loc of [raw.jobLocation, raw.jobLocations].flat().filter(Boolean)) country(loc.address?.addressCountry ?? loc.addressCountry);
  const nl = (s: string) => ['nl','nld','netherlands','the netherlands','nederland','holland'].includes(normalize(s));
  if([raw.jobLocationType].flat().includes('TELECOMMUTE')||job.workArrangement==='remote') {
    const eligibility=[raw.applicantLocationRequirements].flat().filter(Boolean).map((x:any)=>typeof x==='string'?x:x.name??x.addressCountry).filter((x:any)=>typeof x==='string') as string[];
    if(eligibility.some(nl))return {state:'netherlands',evidence:['Explicit Netherlands remote eligibility',...eligibility.filter(nl)]};
    if(eligibility.some(x=>/^(europe|eu|european union|eea)$/i.test(x)))return {state:'unknown',evidence:eligibility};
  }
  if(countries.length) return {state: countries.some(nl) ? 'netherlands' : 'foreign', evidence: countries};
  const value = job.location;
  if(/^(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY) - /.test(value)||/,(?:\s*)(?:CA|NY|NV|TX|FL|MA|MI|WA|IL)(?:\b|$)/.test(value))return {state:'foreign',evidence:[value,'US state location']};
  const explicitNL = [...profile.countryAliases.filter(x=>!DUTCH_LOCALITIES.some(c=>normalize(c)===normalize(x))), ...profile.remoteAliases].find(x=>phrase(value,x));
  const foreign = ['Germany','Deutschland','Belgium','Belgie','Belgique','France','United Kingdom','United States','UK','USA','Spain','Portugal','Poland','Ireland','Switzerland','Austria','Sweden','Denmark','Norway','Italy','Canada','Australia','India','China','Singapore','Luxembourg'].find(x=>phrase(value,x));
  if(foreign && !['netherlands','nederland','nl','holland'].some(x=>phrase(value,x))) return {state:'foreign', evidence:[foreign]};
  const local = [...DUTCH_LOCALITIES,...profile.countryAliases,...(profile.preferredLocations??[]),...(profile.locationPreferences?.anchor.aliases??[]),profile.locationPreferences?.anchor.city??'',...(profile.locationPreferences?.nearbyCities??[]),...(profile.locationPreferences?.stronglyPreferredCities??[])].find(x=>phrase(value,x));
  if(explicitNL || local) return {state:'netherlands',evidence:[explicitNL ?? local!]};
  return {state:'unknown',evidence:value?[value]:[]};
}

const coordinates: Record<string, [number, number]> = {
  "'s-hertogenbosch": [51.6978, 5.3037], "den bosch": [51.6978, 5.3037],
  utrecht: [52.0907, 5.1214], eindhoven: [51.4416, 5.4697], vught: [51.6533, 5.2877],
  rosmalen: [51.7167, 5.3667], boxtel: [51.5908, 5.3294], oss: [51.7650, 5.5181],
  tilburg: [51.5555, 5.0913], waalwijk: [51.6825, 5.0708], veghel: [51.6167, 5.5486],
  zaltbommel: [51.8100, 5.2500], nijmegen: [51.8426, 5.8528], breda: [51.5719, 4.7683],
  amsterdam: [52.3676, 4.9041], rotterdam: [51.9244, 4.4777], "den haag": [52.0705, 4.3007],
  "the hague": [52.0705, 4.3007], arnhem: [51.9851, 5.8987], amersfoort: [52.1561, 5.3878],
  apeldoorn: [52.2112, 5.9699], leiden: [52.1601, 4.4970], haarlem: [52.3874, 4.6462],
  zwolle: [52.5168, 6.0830], groningen: [53.2194, 6.5665], maastricht: [50.8514, 5.6910]
};

const normalized = (value: string) => value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const contains = (location: string, city: string) => ` ${normalized(location)} `.includes(` ${normalized(city)} `);
const canonical = (city: string) => normalized(city).replace(/^s hertogenbosch$/, "'s-hertogenbosch");
const cityCoordinates = (city: string) => coordinates[canonical(city)] ?? coordinates[normalized(city)];
const distance = (a: [number, number], b: [number, number]) => {
  const rad = (value: number) => value * Math.PI / 180, earth = 6371;
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return earth * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

export interface LocationScore { awarded: number; evidence: string[]; explanation: string }

const accessRank: Record<LocationAccessTier, number> = { easy: 0, medium: 1, hard: 2, remote: 3, unknown: 4 };

function assessCityAccess(city: LocationAccessCityProfile, profile: ProfileConfig): LocationAccessAssessment {
  const preferences=profile.locationPreferences!.accessibility!;
  if(city.distanceKm<=preferences.closeOverrideKm)return {tier:'easy',matchedCity:city.city,distanceKm:city.distanceKm,publicTransportMinutes:city.publicTransportMinutes,mode:city.mode,penaltyMinutes:0,effectiveMinutes:city.publicTransportMinutes,confidence:'configured',explanation:`Local override: ${city.city} is ${city.distanceKm} km from ${profile.locationPreferences!.anchor.city}`};
  if(city.mode==='car-only')return {tier:'hard',matchedCity:city.city,distanceKm:city.distanceKm,mode:city.mode,confidence:'configured',explanation:`${city.city} is car-oriented and outside the ${preferences.closeOverrideKm} km local area`};
  if(city.publicTransportMinutes===undefined)return {tier:'unknown',matchedCity:city.city,distanceKm:city.distanceKm,mode:city.mode,confidence:'unknown',explanation:`No public-transport time is configured for ${city.city}`};
  const penalty=preferences.modePenalties[city.mode]??0,effective=city.publicTransportMinutes+penalty;
  const tier:LocationAccessTier=effective<=preferences.easyMaxMinutes?'easy':effective<=preferences.mediumMaxMinutes?'medium':'hard';
  const detail=penalty?`${city.publicTransportMinutes} min plus ${penalty} min ${city.mode} burden`:`${city.publicTransportMinutes} min by direct train`;
  return {tier,matchedCity:city.city,distanceKm:city.distanceKm,publicTransportMinutes:city.publicTransportMinutes,mode:city.mode,penaltyMinutes:penalty,effectiveMinutes:effective,confidence:'configured',explanation:`${city.city}: ${detail} (${effective} effective min)`};
}

/** Commute filtering is intentionally independent from recommendation scoring. */
export function classifyLocationAccess(job: Pick<RawJob,'location'|'raw'> & {workArrangement:WorkArrangement}, profile:ProfileConfig):LocationAccessAssessment {
  const profiles=profile.locationPreferences?.accessibility?.cityProfiles;
  const matches=(profiles??[]).filter(city=>[city.city,...(city.aliases??[])].some(alias=>contains(job.location,alias))).map(city=>assessCityAccess(city,profile));
  const eligibility=assessLocation({title:'',company:'',url:'',...job},profile);
  if(job.workArrangement==='remote'&&eligibility.state==='netherlands')return {tier:'remote',confidence:'configured',explanation:'Explicitly remote and eligible in the Netherlands'};
  if(eligibility.state==='foreign')return {tier:'unknown',confidence:'unknown',explanation:'Outside the Netherlands'};
  if(!profiles?.length)return {tier:'unknown',confidence:'unknown',explanation:'No accessibility profile is configured'};
  if(!matches.length)return {tier:'unknown',confidence:'unknown',explanation:eligibility.state==='unknown'?'Dutch commute location is unconfirmed':'No configured city could be identified from the job location'};
  return matches.sort((a,b)=>accessRank[a.tier]-accessRank[b.tier]||((a.effectiveMinutes??Infinity)-(b.effectiveMinutes??Infinity)))[0];
}

export function scoreLocation(job: Pick<RawJob, "location"> & { workArrangement: WorkArrangement }, profile: ProfileConfig): LocationScore {
  const assessment=assessLocation({title:'',company:'',url:'',raw:{},...job},profile);
  if(assessment.state!=='netherlands')return {awarded:0,evidence:assessment.evidence,explanation:assessment.state==='unknown'?'Netherlands eligibility is unconfirmed; retained for review':'Explicit foreign location'};
  const preferences = profile.locationPreferences;
  if (!preferences) {
    const matched = profile.preferredLocations?.find(city => contains(job.location, city));
    return { awarded: matched ? 10 : 4, evidence: [job.location, ...(matched ? [matched] : [])], explanation: matched ? `Matched preferred city “${matched}”` : "Netherlands vacancy outside the preferred-city list" };
  }
  const strong = preferences.stronglyPreferredCities.find(city => contains(job.location, city));
  if (strong) return { awarded: 10, evidence: [job.location, strong], explanation: `Matched strongly preferred city “${strong}”` };
  const nearby = preferences.nearbyCities.find(city => contains(job.location, city));
  if (nearby) return { awarded: 9, evidence: [job.location, nearby], explanation: `Matched nearby city “${nearby}”` };
  if (job.workArrangement === "remote" && profile.remoteAliases.some(alias => contains(job.location, alias))) return { awarded: 7, evidence: [job.location, "Netherlands remote"], explanation: "Explicitly eligible for remote work in the Netherlands" };
  const detectedCity = Object.keys(coordinates).find(city => contains(job.location, city));
  const anchor: [number, number] = [preferences.anchor.latitude, preferences.anchor.longitude];
  const point = detectedCity ? cityCoordinates(detectedCity) : undefined;
  if (detectedCity && point) {
    const km = Math.round(distance(anchor, point));
    if (km <= (preferences.distanceBandKm ?? 60)) return { awarded: 7, evidence: [job.location, detectedCity, `${km} km straight-line from ${preferences.anchor.city}`], explanation: `Within the configured ${preferences.distanceBandKm ?? 60} km distance band` };
  }
  return { awarded: 4, evidence: [job.location, "Netherlands"], explanation: "Elsewhere in the Netherlands; retained with lower location priority" };
}

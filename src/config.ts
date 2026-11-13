import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProfileConfig, SourceConfig } from "./types.js";

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const moduleParent = resolve(moduleDirectory, "..");
export const projectRoot = basename(moduleParent) === "dist" ? resolve(moduleParent, "..") : moduleParent;
export const dataDir = resolve(process.env.DIEGO_DATA_DIR ?? resolve(projectRoot, "data"));
export const databasePath = resolve(process.env.DIEGO_DB_PATH ?? resolve(dataDir, "diego-career-ops.sqlite"));

async function readJson<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }
export const loadProfile = () => readJson<ProfileConfig>(resolve(projectRoot, "config/profile.json"));
export async function saveProfile(profile: ProfileConfig): Promise<void> {
  if (!profile.country || !Array.isArray(profile.countryAliases) || !profile.roleFamilies || !Array.isArray(profile.excludeTitleTerms)) throw new Error("Invalid profile configuration");
  const access=profile.locationPreferences?.accessibility;
  if(access){
    if(!Number.isFinite(access.easyMaxMinutes)||!Number.isFinite(access.mediumMaxMinutes)||access.easyMaxMinutes<0||access.easyMaxMinutes>=access.mediumMaxMinutes)throw new Error("Location access thresholds must be non-negative and easy must be lower than medium");
    if(!Number.isFinite(access.closeOverrideKm)||access.closeOverrideKm<0)throw new Error("Location close override must be a non-negative distance");
    const modes=new Set(['direct-train','train-transfer','bus','car-only']),aliases=new Set<string>();
    for(const value of Object.values(access.modePenalties))if(!Number.isFinite(value)||value<0)throw new Error("Location mode penalties must be non-negative");
    for(const city of access.cityProfiles){
      if(!city.city.trim()||!modes.has(city.mode)||!Number.isFinite(city.distanceKm)||city.distanceKm<0||city.publicTransportMinutes!==undefined&&(!Number.isFinite(city.publicTransportMinutes)||city.publicTransportMinutes<0))throw new Error(`Invalid location access profile for ${city.city||'unnamed city'}`);
      for(const alias of [city.city,...(city.aliases??[])]){const key=alias.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();if(!key)throw new Error(`Invalid empty alias for ${city.city}`);if(aliases.has(key))throw new Error(`Duplicate location alias: ${alias}`);aliases.add(key);}
    }
  }
  const path = resolve(projectRoot, "config/profile.json"), temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, "utf8"); await rename(temporary, path);
}
export const loadSources = async () => (await readJson<SourceConfig[]>(resolve(projectRoot, "config/sources.json"))).filter(source => source.enabled !== false);

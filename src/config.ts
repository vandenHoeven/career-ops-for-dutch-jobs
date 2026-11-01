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
  const path = resolve(projectRoot, "config/profile.json"), temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, "utf8"); await rename(temporary, path);
}
export const loadSources = async () => (await readJson<SourceConfig[]>(resolve(projectRoot, "config/sources.json"))).filter(source => source.enabled !== false);

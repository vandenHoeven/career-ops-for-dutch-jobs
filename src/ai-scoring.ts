import { createHash } from "node:crypto";
import type { ProfileConfig } from "./types.js";

export interface AiAssessment { score: number; rationale: string; strengths: string[]; concerns: string[]; missingInformation: string[] }
export interface AiJobInput { title: string; company: string; location: string; description?: string; summary?: string }
export const AI_PROMPT_VERSION = "1";

export function aiConfig() {
  return { enabled: process.env.DIEGO_AI_ENABLED === "true", baseUrl: process.env.DIEGO_AI_BASE_URL, apiKey: process.env.DIEGO_AI_API_KEY, model: process.env.DIEGO_AI_MODEL };
}

export function aiCacheKey(job: AiJobInput, profile: ProfileConfig, model: string, profileHash: string): string {
  return createHash("sha256").update(JSON.stringify({ job, profile, model, profileHash, prompt: AI_PROMPT_VERSION })).digest("hex");
}

export function validateAiAssessment(value: unknown): AiAssessment {
  const row = value as any;
  if (!row || !Number.isFinite(row.score) || row.score < 0 || row.score > 100 || typeof row.rationale !== "string") throw new Error("AI response did not match the required score schema");
  const list = (name: string): string[] => { if (!Array.isArray(row[name]) || row[name].some((item: unknown) => typeof item !== "string")) throw new Error(`AI response field '${name}' must be a string array`); return row[name].slice(0, 10); };
  return { score: Math.round(row.score), rationale: row.rationale.slice(0, 2000), strengths: list("strengths"), concerns: list("concerns"), missingInformation: list("missingInformation") };
}

export async function requestAiAssessment(job: AiJobInput, profile: ProfileConfig, signal?: AbortSignal): Promise<AiAssessment> {
  const config = aiConfig();
  if (!config.enabled) throw new Error("AI scoring is disabled");
  if (!config.baseUrl || !config.apiKey || !config.model) throw new Error("AI scoring configuration is incomplete");
  const endpoint = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const safeProfile = { preferredRoleFamilies: profile.preferredRoleFamilies, acceptableRoleFamilies: profile.acceptableRoleFamilies, skills: profile.skills, desiredSeniority: profile.desiredSeniority, excludedSeniority: profile.excludedSeniority, languages: profile.languages, preferredLocations: profile.preferredLocations, preferredWorkArrangements: profile.preferredWorkArrangements, dealBreakers: profile.dealBreakers, negativeTerms: profile.negativeTerms };
  const response = await fetch(endpoint, { method: "POST", signal, headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" }, body: JSON.stringify({ model: config.model, response_format: { type: "json_object" }, temperature: 0, messages: [{ role: "system", content: "Score this vacancy against the supplied non-identifying preferences. Return JSON with score (0-100), rationale, strengths, concerns, missingInformation." }, { role: "user", content: JSON.stringify({ job, preferences: safeProfile }) }] }) });
  if (!response.ok) throw new Error(`AI scoring failed with HTTP ${response.status}`);
  const payload: any = await response.json();
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("AI scoring response contained no message content");
  return validateAiAssessment(JSON.parse(content));
}

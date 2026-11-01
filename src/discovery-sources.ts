import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from './config.js';
import { parsePublicPostings } from './posting-parser.js';
import type {
  DiscoveryCandidate,
  DiscoverySource,
  ProviderId,
  RawJob,
} from "./types.js";
import { BENCHMARK_EMPLOYERS } from "./benchmark.js";
import { unflatten } from "devalue";
import { configuredLinkedInGuestSource, linkedInGuestEnabled } from './linkedin-guest.js';
import { configuredJobSpySources, JOBSPY_SITES } from './jobspy.js';

const BOARD_DIRECTORY =
  "https://kalebconfer-sys.github.io/job-board-directory/job-board-directory.json";
const GIGSIGNAL = "https://gigsignal-api.fly.dev/api/jobs?location=amsterdam";
const WERKEN_VOOR_NEDERLAND =
  "https://www.werkenvoornederland.nl/vacatures?type=vacature";
const FEASHLIAA_BASE =
  "https://raw.githubusercontent.com/Feashliaa/job-board-aggregator/main/data";
const ACADEMIC_TRANSFER =
  "https://www.academictransfer.com/en/jobs/?order=published";
const supported = new Set<ProviderId>([
  "greenhouse",
  "lever",
  "ashby",
  "workable",
  "recruitee",
  "personio",
  "smartrecruiters",
  "workday",
  "icims",
]);
const provider = (value: unknown): ProviderId | undefined =>
  supported.has(String(value).toLowerCase() as ProviderId)
    ? (String(value).toLowerCase() as ProviderId)
    : undefined;
const str = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const safeHttps = (value: unknown): string | undefined => {
  try {
    const url = new URL(str(value));
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};
const safeDomain = (value: unknown): string | undefined => {
  const raw = str(value);
  if (!raw) return undefined;
  try {
    return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return undefined;
  }
};
const clean = (value: string) =>
  value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
export const providerFromUrl = (value: string): ProviderId | undefined => {
  const host = safeDomain(value) ?? "";
  if (/greenhouse\.io$/.test(host)) return "greenhouse";
  if (/lever\.co$/.test(host)) return "lever";
  if (host === "jobs.ashbyhq.com") return "ashby";
  if (host === "apply.workable.com") return "workable";
  if (/recruitee\.com$/.test(host)) return "recruitee";
  if (/jobs\.personio\.(de|com)$/.test(host)) return "personio";
  if (/smartrecruiters\.com$/.test(host)) return "smartrecruiters";
  if (/myworkdayjobs\.com$|myworkdaysite\.com$/.test(host)) return "workday";
  if (/icims\.com$/.test(host)) return "icims";
  return undefined;
};

export function parseBoardDirectory(
  payload: unknown,
  sourceId = "job-board-directory",
): DiscoveryCandidate[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((row: any) => {
    const boardUrl = safeHttps(row?.board_url),
      company = str(row?.company),
      platform = provider(row?.platform);
    return boardUrl && company
      ? [
          {
            sourceId,
            company,
            boardUrl,
            apiUrl: safeHttps(row?.api_url),
            provider: platform,
          },
        ]
      : [];
  });
}

export function parseGigsignal(payload: unknown): DiscoveryCandidate[] {
  if (!Array.isArray(payload)) return [];
  return payload.flatMap((row: any) => {
    const url = safeHttps(row?.apply_url),
      company = str(row?.company_name),
      title = str(row?.title);
    if (!url || !company || !title) return [];
    const job: RawJob = {
      company,
      title,
      location: str(row?.location),
      summary: str(row?.gist) || undefined,
      url,
      firstObservedAt: str(row?.first_seen_at) || undefined,
      raw: row,
    };
    return [
      {
        sourceId: "gigsignal",
        company,
        domain: safeDomain(row?.company_website),
        headquarters: "unknown" as const,
        jobs: [job],
      },
    ];
  });
}

export function parseWerkenVoorNederland(
  html: string,
  fallbackUrl?: string,
): DiscoveryCandidate[] {
  const rows: any[] = [];
  for (const match of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const value = JSON.parse(match[1]);
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item?.["@type"] === "JobPosting") rows.push(item);
        if (Array.isArray(item?.itemListElement))
          rows.push(...item.itemListElement.map((x: any) => x.item ?? x));
      }
    } catch {
      /* malformed page data */
    }
  }
  return rows.flatMap((row) => {
    const title = str(row.title ?? row.name),
      company = str(row.hiringOrganization?.name),
      url = safeHttps(row.url) ?? safeHttps(fallbackUrl);
    if (!title || !company || !url) return [];
    const address = row.jobLocation?.address;
    const location = [
      str(address?.addressLocality),
      str(address?.addressCountry) || "Netherlands",
    ]
      .filter(Boolean)
      .join(", ");
    const job: RawJob = {
      company,
      title,
      location,
      description: str(row.description).replace(/<[^>]+>/g, " "),
      url,
      postedAt: str(row.datePosted) || undefined,
      raw: row,
    };
    return [
      {
        sourceId: "werken-voor-nederland",
        company,
        headquarters: "netherlands" as const,
        sizeConfidence: "unknown" as const,
        jobs: [job],
      },
    ];
  });
}

export function parseWerkenVoorNederlandLinks(html: string): string[] {
  const links = [
    ...html.matchAll(
      /href=["'](\/vacatures\/[A-Za-z0-9%_.~()'!*:@,+-]+)["']/gi,
    ),
  ].map((match) =>
    new URL(match[1], "https://www.werkenvoornederland.nl").toString(),
  );
  return [...new Set(links)];
}

export function parseWerkenVoorNederlandComponentUrl(
  html: string,
  pageUrl: string,
): string | undefined {
  const encoded = html.match(
    /["'](\/vacatures\?_hn:type=component-rendering&amp;_hn:ref=[^"']+)["']/i,
  )?.[1];
  if (!encoded) return undefined;
  return new URL(encoded.replaceAll("&amp;", "&"), pageUrl).toString();
}

export function parseWerkenVoorNederlandDetail(
  html: string,
  url: string,
): DiscoveryCandidate[] {
  const structured = parseWerkenVoorNederland(html, url);
  if (structured.length) return structured;
  const clean = (value: string) =>
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/\s+/g, " ")
      .trim();
  const title = clean(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? "");
  const employer = clean(
    html.match(
      /<a[^>]+href=["']\/organisaties\/[^"']+["'][^>]*>([\s\S]*?)<\/a>/i,
    )?.[1] ?? "",
  );
  const main = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? html;
  const location = clean(
    main.match(/<li[^>]*>([\s\S]*?)<\/li>/i)?.[1] ?? "Netherlands",
  ).split(" - ")[0];
  const posted = clean(
    main.match(/Plaatsingsdatum:\s*([^<\r\n]+)/i)?.[1] ?? "",
  );
  if (!title || !employer) return [];
  const job: RawJob = {
    company: employer,
    title,
    location: location || "Netherlands",
    description: clean(main),
    url,
    postedAt: posted || undefined,
    raw: { source: "werken-voor-nederland", url },
  };
  return [
    {
      sourceId: "werken-voor-nederland",
      company: employer,
      headquarters: "netherlands",
      sizeConfidence: "unknown",
      jobs: [job],
    },
  ];
}

export function parseAcademicTransferLinks(html: string): string[] {
  return [
    ...new Set(
      [
        ...html.matchAll(/href=["']([^"']*\/(?:en|nl)\/jobs\/\d+[^"']*)["']/gi),
      ].map((match) =>
        new URL(match[1], "https://www.academictransfer.com").toString(),
      ),
    ),
  ];
}

export function parseAcademicTransferDetail(
  html: string,
  url: string,
): DiscoveryCandidate[] {
  const rows: any[] = [];
  for (const match of html.matchAll(
    /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const value = JSON.parse(match[1]);
      for (const item of Array.isArray(value) ? value : [value])
        if (item?.["@type"] === "JobPosting") rows.push(item);
    } catch {
      /* invalid block */
    }
  }
  if (!rows.length) {
    const payload = html.match(
      /<script[^>]+id=["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
    )?.[1];
    if (payload) {
      try {
        const root = unflatten(JSON.parse(payload), {
            ShallowReactive: (value) => value,
            Reactive: (value) => value,
            Ref: (value) => value,
            EmptyRef: (value) => value,
          }),
          seen = new Set<unknown>();
        let vacancy: any;
        const visit = (value: any): void => {
          if (vacancy || !value || typeof value !== "object" || seen.has(value))
            return;
          seen.add(value);
          if (
            typeof value.title === "string" &&
            (typeof value.organisation_name === "string" ||
              typeof value.organization_name === "string") &&
            (value.absolute_url || value.application_url || value.description)
          ) {
            vacancy = value;
            return;
          }
          for (const child of Object.values(value)) visit(child);
        };
        visit(root);
        if (vacancy) rows.push(vacancy);
      } catch {
        /* malformed Nuxt payload */
      }
    }
  }
  return rows.flatMap((row) => {
    const title = str(row.title),
      company = str(
        row.hiringOrganization?.name ??
          row.organisation_name ??
          row.organization_name,
      ),
      address = Array.isArray(row.jobLocation)
        ? row.jobLocation[0]?.address
        : row.jobLocation?.address,
      location = [
        str(address?.addressLocality ?? row.city),
        str(address?.addressCountry ?? row.country_code),
      ]
        .filter(Boolean)
        .join(", ");
    if (!title || !company) return [];
    const description = [
      row.description,
      row.requirements,
      row.contract_terms,
      row.additional_info,
    ]
      .map(str)
      .filter(Boolean)
      .map(clean)
      .join("\n\n");
    const job: RawJob = {
      externalId:
        str(row.identifier?.value ?? row.id) || url.match(/\/jobs\/(\d+)/)?.[1],
      company,
      title,
      location,
      description,
      url: safeHttps(row.url ?? row.absolute_url) || url,
      applyUrl:
        safeHttps(row.application_url ?? row.url ?? row.absolute_url) || url,
      postedAt: str(row.datePosted ?? row.start_date) || undefined,
      validThrough: str(row.validThrough ?? row.end_date) || undefined,
      summary: str(row.teaser) || undefined,
      structuredRoleTerms: [
        str(row.occupationalCategory),
        str(row.employmentType),
        ...(Array.isArray(row.keywords) ? row.keywords.map(str) : []),
      ].filter(Boolean),
      raw: row,
    };
    return [
      {
        sourceId: "academictransfer",
        company,
        headquarters: "unknown" as const,
        boardUrl: job.url,
        provider: "academictransfer" as const,
        jobs: [job],
      },
    ];
  });
}

const boardDirectory: DiscoverySource = {
  id: "job-board-directory",
  label: "Confirmed public ATS boards",
  license: "Public directory; no attribution required",
  kind: "board-directory",
  async discover(ctx, cursor, limit) {
    const all = parseBoardDirectory(await ctx.fetchJson(BOARD_DIRECTORY));
    const start = all.length ? cursor % all.length : 0;
    return {
      candidates: [...all, ...all].slice(start, start + limit),
      nextCursor: all.length ? (start + limit) % all.length : 0,
      total: all.length,
    };
  },
};
const gigsignal: DiscoverySource = {
  id: "gigsignal",
  label: "Amsterdam and Netherlands career-page jobs",
  license: "Public read-only API; cache >=30 minutes",
  kind: "job-feed",
  async discover(ctx, cursor, limit) {
    const all = parseGigsignal(await ctx.fetchJson(GIGSIGNAL));
    return {
      candidates: all.slice(cursor, cursor + limit),
      nextCursor: all.length ? (cursor + limit) % all.length : 0,
      total: all.length,
    };
  },
};
const government: DiscoverySource = {
  id: "werken-voor-nederland",
  label: "Werken voor Nederland",
  license: "Public Netherlands government vacancies",
  kind: "job-feed",
  async discover(ctx, cursor, limit) {
    const pageSize = 12,
      candidates: DiscoveryCandidate[] = [],
      seenPages = new Set<string>();
    let page = Math.floor(cursor / pageSize) + 1,
      offset = cursor % pageSize,
      total = 0;
    while (candidates.length < limit && page <= 100) {
      const listingUrl = `${WERKEN_VOOR_NEDERLAND}&pagina=${page}`;
      const shell = await ctx.fetchText(listingUrl);
      const componentUrl = parseWerkenVoorNederlandComponentUrl(
        shell,
        listingUrl,
      );
      if (!componentUrl && /vacature overzicht wordt geladen/i.test(shell))
        throw new Error(
          "Werken voor Nederland loading shell did not expose a component URL",
        );
      const listing = componentUrl ? await ctx.fetchText(componentUrl) : shell;
      const totalMatch = listing.match(/Er zijn\s+([\d.]+)\s+zoekresultaten/i);
      if (totalMatch) total = Number(totalMatch[1].replace(/\./g, ""));
      const links = parseWerkenVoorNederlandLinks(listing).slice(offset);
      offset = 0;
      if (!links.length) {
        if (page === 1)
          throw new Error(
            "Werken voor Nederland component contained no vacancy links",
          );
        break;
      }
      const signature = links.join("\n");
      if (seenPages.has(signature))
        throw new Error(`Werken voor Nederland repeated page ${page}`);
      seenPages.add(signature);
      for (const link of links) {
        if (candidates.length >= limit) break;
        candidates.push({
          sourceId: "werken-voor-nederland",
          company: "Rijksoverheid",
          headquarters: "netherlands",
          boardUrl: link,
          provider: "government",
        });
      }
      page++;
    }
    const nextCursor = total
      ? (cursor + candidates.length) % total
      : cursor + candidates.length;
    return { candidates, nextCursor, total: total || undefined };
  },
};
const academicTransfer: DiscoverySource = {
  id: "academictransfer",
  label: "AcademicTransfer",
  license: "Public Dutch research and knowledge-sector vacancies",
  kind: "job-feed",
  async discover(ctx, cursor, limit) {
    const pageSize = 10,
      candidates: DiscoveryCandidate[] = [];
    let page = Math.floor(cursor / pageSize) + 1,
      offset = cursor % pageSize,
      total: number | undefined;
    const seen = new Set<string>();
    while (candidates.length < limit && page <= 100) {
      const listing = await ctx.fetchText(`${ACADEMIC_TRANSFER}&page=${page}`);
      const count = clean(listing).match(/(?:All|Alle)\s+(\d+)/i);
      if (count) total = Number(count[1]);
      const links = parseAcademicTransferLinks(listing).slice(offset);
      offset = 0;
      if (!links.length) {
        if (page === 1)
          throw new Error(
            "AcademicTransfer listing contained no active vacancy links",
          );
        break;
      }
      const signature = links.join("|");
      if (seen.has(signature))
        throw new Error(`AcademicTransfer repeated page ${page}`);
      seen.add(signature);
      for (const link of links) {
        if (candidates.length >= limit) break;
        candidates.push({
          sourceId: "academictransfer",
          company: "AcademicTransfer employer — pending verification",
          boardUrl: link,
          provider: "academictransfer",
        });
      }
      page++;
    }
    return {
      candidates,
      nextCursor: total
        ? (cursor + candidates.length) % total
        : cursor + candidates.length,
      total,
    };
  },
};

export async function benchmarkCandidate(
  ctx: import("./types.js").FetchContext,
  employer: (typeof BENCHMARK_EMPLOYERS)[number],
  overrides?:Array<{id:string;careersUrl:string;evidenceUrl:string;verifiedAt:string;provider?:ProviderId}>,
): Promise<DiscoveryCandidate> {
  if(!overrides)try{overrides=JSON.parse(await readFile(resolve(projectRoot,'config/employers.json'),'utf8'));}catch{overrides=[];}
  const override=overrides?.find(row=>row.id===employer.id&&row.evidenceUrl&&row.verifiedAt);
  if(override)return {sourceId:'benchmark-employers',company:employer.name,domain:employer.domain,benchmarkId:employer.id,boardUrl:override.careersUrl,provider:override.provider??providerFromUrl(override.careersUrl)??'browser',discoveryEvidence:{method:'verified-configuration',queryOrUrl:override.evidenceUrl,resolvedUrl:override.careersUrl,confidence:1,result:'board-found'}};
  // Reuse the configured directory as exact identity evidence, never fuzzy names.
  const identity = (value: string) =>
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  try {
    const names = new Set([employer.name, ...employer.aliases].map(identity));
    const matches = parseBoardDirectory(
      await ctx.fetchJson(BOARD_DIRECTORY),
    ).filter((row) => names.has(identity(row.company)) && row.provider);
    if (matches.length === 1) {
      const match = matches[0];
      return {
        ...match,
        sourceId: "benchmark-employers",
        company: employer.name,
        domain: employer.domain,
        benchmarkId: employer.id,
        discoveryEvidence: {
          method: "directory-exact-name",
          queryOrUrl: BOARD_DIRECTORY,
          resolvedUrl: match.boardUrl,
          confidence: 0.9,
          result: "board-found",
        },
      };
    }
  } catch {
    /* Official-site probing remains available when the directory is unavailable. */
  }
  if (!employer.domain)
    return {
      sourceId: "benchmark-employers",
      company: employer.name,
      benchmarkId: employer.id,
      discoveryEvidence: {
        method: "official-site",
        queryOrUrl: employer.name,
        confidence: 0,
        result: "no-domain",
      },
    };
  const origin = `https://${employer.domain}`,
    urls = [
      origin,
      `${origin}/careers`,
      `${origin}/jobs`,
      `${origin}/vacatures`,
      `${origin}/werken-bij`,
      `${origin}/sitemap.xml`,
    ];
  const found: string[] = [];
  let evidencePage=origin;
  let unsupportedPage: string | undefined;
  const visited = new Set<string>();
  for (const page of urls) {
    if (visited.size >= 12) break;
    if (visited.has(page)) continue;
    visited.add(page);
    try {
      const html = await ctx.fetchText(page);
      const publicJobs=parsePublicPostings(html,page,employer.name);
      if(publicJobs.length)return {sourceId:'benchmark-employers',company:employer.name,domain:employer.domain,benchmarkId:employer.id,boardUrl:page,provider:'browser',discoveryEvidence:{method:'official-site-structured-data',queryOrUrl:page,resolvedUrl:page,confidence:1,result:'board-found'}};
      for (const match of html.matchAll(/href=["']([^"']+)["']/gi)) {
        try {
          const parsed = new URL(match[1], page);
          parsed.hash = "";
          const value = parsed.toString();
          if (providerFromUrl(value)) {found.push(value);evidencePage=page;}
          else {
            const target = new URL(value);
            if (
              (target.hostname === employer.domain ||
                target.hostname.endsWith(`.${employer.domain}`)) &&
              /careers|vacatures|werken.?bij|\/jobs/i.test(
                target.pathname + target.hostname,
              )
            ) {
              unsupportedPage ??= value;
              if (!visited.has(value) && urls.length < 20) urls.push(value);
            }
          }
        } catch {
          /* invalid link */
        }
      }
      for (const match of html.matchAll(/<loc>\s*([^<]+)\s*<\/loc>/gi)) {
        const value = safeHttps(match[1]);
        if (
          value &&
          safeDomain(value)?.endsWith(employer.domain) &&
          /career|vacature|werken.?bij|\/jobs/i.test(value) &&
          urls.length < 20
        )
          urls.push(value);
      }
      if (found.length) break;
    } catch {
      /* continue probing */
    }
  }
  let method = "official-site";
  if (
    !found.length &&
    process.env.DIEGO_SEARCH_ENABLED === "true" &&
    process.env.DIEGO_SEARCH_API_KEY
  ) {
    method = "brave-search";
    const endpoint =
        process.env.DIEGO_SEARCH_BASE_URL ||
        "https://api.search.brave.com/res/v1/web/search",
      query = `${employer.name} careers jobs`;
    const payload: any = await ctx.fetchJson(
        `${endpoint}?q=${encodeURIComponent(query)}`,
        {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": process.env.DIEGO_SEARCH_API_KEY,
          },
        },
      ),
      identity = employer.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .split(" ")
        .filter((x) => x.length > 2);
    for (const item of payload?.web?.results ?? []) {
      const value = safeHttps(item?.url);
      if (!value) continue;
      const host = safeDomain(value),
        p = providerFromUrl(value),
        evidence =
          `${item?.title ?? ""} ${item?.description ?? ""} ${value}`.toLowerCase();
      if (
        p &&
        (host === employer.domain ||
          identity.every((term) => evidence.includes(term)))
      )
        found.push(value);
    }
  }
  const detected = found.find(Boolean);
  let board = detected ?? unsupportedPage ?? origin;
  if (detected) {
    const url = new URL(detected),
      provider = providerFromUrl(detected);
    if (provider === "personio" || provider === "recruitee") board = url.origin;
    else if (provider === "greenhouse" && url.searchParams.has("for"))
      board = `https://job-boards.greenhouse.io/${encodeURIComponent(url.searchParams.get("for")!)}`;
    else if (
      ["greenhouse", "lever", "ashby", "workable", "smartrecruiters"].includes(
        provider ?? "",
      )
    )
      board = `${url.origin}/${url.pathname.split("/").filter(Boolean)[0] ?? ""}`;
  }
  return {
    sourceId: "benchmark-employers",
    company: employer.name,
    domain: employer.domain,
    boardUrl: board,
    provider: board ? providerFromUrl(board) ?? 'browser' : undefined,
    headquarters: "unknown",
    benchmarkId: employer.id,
    discoveryEvidence: {
      method,
      queryOrUrl: evidencePage,
      resolvedUrl: board,
      confidence: board?.includes(employer.domain)
        ? 1
        : board?.length
          ? 0.8
          : 0,
      result: detected ? "board-found" : "unsupported-or-not-found",
    },
  };
}
const benchmarkEmployers: DiscoverySource = {
  id: "benchmark-employers",
  label: "Representative benchmark employer board discovery",
  license:
    "Version-controlled local benchmark; official-site probing and optional Brave Search API",
  kind: "board-directory",
  async discover(ctx, cursor, limit) {
    const start = cursor % BENCHMARK_EMPLOYERS.length,
      selected = [...BENCHMARK_EMPLOYERS, ...BENCHMARK_EMPLOYERS].slice(
        start,
        start + limit,
      ),
      candidates: DiscoveryCandidate[] = [];
    for (const employer of selected)
      candidates.push({
        sourceId: "benchmark-employers",
        company: employer.name,
        domain: employer.domain,
        benchmarkId: employer.id,
      });
    return {
      candidates,
      nextCursor: (start + selected.length) % BENCHMARK_EMPLOYERS.length,
      total: BENCHMARK_EMPLOYERS.length,
    };
  },
};
function feashliaaSource(
  id: ProviderId,
  file: string,
  build: (slug: string) => string,
): DiscoverySource {
  return {
    id: `feashliaa-${id}`,
    label: `Feashliaa ${id} directory`,
    license: "CC BY-NC 4.0 — Riley Dorrington / job-board-aggregator",
    kind: "board-directory",
    async discover(ctx, cursor, limit) {
      const payload = await ctx.fetchJson(`${FEASHLIAA_BASE}/${file}`);
      const slugs = Array.isArray(payload)
        ? payload.map(String).filter((value) => /^[A-Za-z0-9._-]+$/.test(value))
        : [];
      const start = slugs.length ? cursor % slugs.length : 0;
      const selected = [...slugs, ...slugs].slice(start, start + limit);
      return {
        candidates: selected.map((slug) => ({
          sourceId: `feashliaa-${id}`,
          company: slug,
          boardUrl: build(slug),
          provider: id,
        })),
        nextCursor: slugs.length ? (start + limit) % slugs.length : 0,
        total: slugs.length,
      };
    },
  };
}
export const discoverySources: DiscoverySource[] = [
  gigsignal,
  government,
  academicTransfer,
  benchmarkEmployers,
  boardDirectory,
  feashliaaSource(
    "greenhouse",
    "greenhouse_companies.json",
    (slug) => `https://job-boards.greenhouse.io/${slug}`,
  ),
  feashliaaSource(
    "lever",
    "lever_companies.json",
    (slug) => `https://jobs.lever.co/${slug}`,
  ),
  feashliaaSource(
    "ashby",
    "ashby_companies.json",
    (slug) => `https://jobs.ashbyhq.com/${slug}`,
  ),
];
export function getDiscoverySources(id?: string): DiscoverySource[] {
  const available=[...discoverySources,...configuredJobSpySources(),...(linkedInGuestEnabled()?[configuredLinkedInGuestSource()]:[])];
  if (!id) return available;
  const match = available.find((source) => source.id === id);
  if (!match)
    throw new Error(
      id==='linkedin-guest'
        ? "LinkedIn Guest is disabled. It requires DIEGO_ENABLE_LINKEDIN_GUEST=true and DIEGO_LINKEDIN_GUEST_PERMISSION_CONFIRMED=true."
        : id.startsWith('jobspy-') && (JOBSPY_SITES as readonly string[]).includes(id.slice('jobspy-'.length))
          ? `JobSpy ${id.slice('jobspy-'.length)} is disabled. Configure DIEGO_JOBSPY_SITES and confirm that platform's permission explicitly.`
        : `Unknown discovery source '${id}'. Available: ${available.map((source) => source.id).join(", ")}`,
    );
  return [match];
}

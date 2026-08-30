import candidatesFile from "./brand-candidates.json";
import type { Brand } from "./db/schema";

/**
 * Turns one raw engine response into rows: the links it returned, and
 * which of the tracked brands its answer named.
 *
 * Everything here is mechanical — unnest an array, lowercase a host, match
 * a literal string. Nothing scores or ranks an answer; the judgement of
 * which brands matter is the user's, declared in the `brands` table.
 */

/** Bump when the rules below change, so finished results are re-derived. */
export const EXTRACTION_REVISION = 2;

/**
 * Names to watch for without tracking them. See `brand-candidates.json`.
 */
// Typed through `unknown[]` rather than trusting the import: an empty
// array in the shipped JSON infers as `never[]`, and a user editing the
// file by hand is exactly the case that puts a non-string in it.
export const BRAND_CANDIDATES: string[] = (
  (candidatesFile as { candidates?: unknown[] }).candidates ?? []
).filter(
  (name): name is string => typeof name === "string" && name.trim().length > 0,
);

/** FNV-1a, folded to 31 bits so it fits the integer column. */
function fingerprint(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash & 0x7fffffff;
}

/**
 * What `results.extraction_revision` stores: a fingerprint of everything
 * that decides the output, not a version number.
 *
 * The candidate list is a FILE, so nothing calls
 * `markAllForReextraction()` when it changes — unlike the brands table,
 * which has a write path that can. Folding the list into the stamp means
 * an edited file simply no longer matches what is stored, and the next
 * tick re-derives the history on its own. Sorted first so reordering the
 * file is not a change.
 */
export const EXTRACTION_STAMP = fingerprint(
  `${EXTRACTION_REVISION}:${[...BRAND_CANDIDATES].sort().join("\u0000")}`,
);

export interface ExtractedSource {
  kind: string;
  position: number | null;
  url: string;
  domain: string;
  label: string | null;
}

export interface ExtractedMention {
  brandId: string;
  mentioned: boolean;
  mentionCount: number;
  firstPosition: number | null;
  cited: boolean;
  citedSourceCount: number;
}

export interface ExtractedQuery {
  kind: string;
  position: number | null;
  query: string;
}

export interface ExtractedCandidate {
  name: string;
  mentionCount: number;
}

export interface Extraction {
  text: string;
  sources: ExtractedSource[];
  mentions: ExtractedMention[];
  queries: ExtractedQuery[];
  candidates: ExtractedCandidate[];
}

/**
 * Host of a URL, lowercased and stripped of a leading "www.".
 *
 * Deliberately not a public-suffix lookup: that needs a list dependency
 * that goes stale, and every panel here groups by what the engine actually
 * linked to. "docs.example.com" and "example.com" stay distinct, which is
 * the honest answer — they are different pages to get listed on.
 */
export function toDomain(url: string): string | null {
  try {
    const parsed = new URL(url);
    // `new URL` happily parses "javascript:void" and "mailto:x", which have
    // no hostname at all — without this they land in the table as rows with
    // an empty domain that every GROUP BY then reports as a real site.
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    const host = parsed.hostname.toLowerCase();
    if (host.length === 0) return null;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

function pushSource(
  into: ExtractedSource[],
  seen: Set<string>,
  kind: string,
  raw: unknown,
  urlKey = "url",
  labelKey = "label",
): void {
  if (typeof raw !== "object" || raw === null) return;
  const item = raw as Record<string, unknown>;
  const url = item[urlKey];
  if (typeof url !== "string" || url.length === 0) return;

  const domain = toDomain(url);
  if (domain === null) return;

  // One link can arrive twice — as a source rail entry and again as an
  // inline citation pill. Both are real, but a panel counting "pages the
  // engine retrieved" must not count the page twice for one answer.
  const key = `${kind} ${url}`;
  if (seen.has(key)) return;
  seen.add(key);

  const position = item.position;
  const label = item[labelKey] ?? item.title;
  into.push({
    kind,
    position: typeof position === "number" ? position : null,
    url,
    domain,
    label: typeof label === "string" ? label : null,
  });
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The response body geo-tracker stored, unwrapped.
 *
 * The async API nests the payload under `result`, but a webhook redelivery
 * or a hand-inserted row may hold the result object directly. Accepting
 * both costs one line and avoids an extraction that silently finds nothing.
 */
function unwrap(response: unknown): Record<string, unknown> | null {
  if (typeof response !== "object" || response === null) return null;
  const body = response as Record<string, unknown>;
  const inner = body.result;
  if (typeof inner === "object" && inner !== null) {
    return inner as Record<string, unknown>;
  }
  return body;
}

/**
 * The prose an engine wrote, or "" for the engines that write none.
 *
 * Google returns a page of links, not an answer, so its only text is the
 * AI Overview when one was served. A brand cannot be "named in the answer"
 * on a plain SERP, and reporting 0 mentions there is correct rather than
 * missing data.
 */
export function answerText(response: unknown): string {
  const result = unwrap(response);
  if (result === null) return "";

  if (typeof result.text === "string") return result.text;

  const overview = result.aioverview;
  if (typeof overview === "object" && overview !== null) {
    const text = (overview as Record<string, unknown>).text;
    if (typeof text === "string") return text;
  }
  return "";
}

/** Every link in the payload, tagged by where it came from. */
export function extractSources(response: unknown): ExtractedSource[] {
  const result = unwrap(response);
  if (result === null) return [];

  const sources: ExtractedSource[] = [];
  const seen = new Set<string>();

  // Chat engines: the source rail and the inline pills.
  for (const item of asArray(result.sources)) {
    pushSource(sources, seen, "source", item);
  }
  for (const item of asArray(result.citationPills)) {
    pushSource(sources, seen, "citation_pill", item);
  }

  // Google: organic links, the news list, ads, and the AI Overview's own
  // rail. Kept apart by `kind` — an ad is not a citation.
  for (const item of asArray(result.organicResults)) {
    pushSource(sources, seen, "organic", item, "link", "title");
  }
  for (const item of asArray(result.newsResults)) {
    pushSource(sources, seen, "news", item, "link", "title");
  }
  for (const item of asArray(result.ads)) {
    pushSource(sources, seen, "ad", item);
  }
  for (const item of asArray(result.videos)) {
    pushSource(sources, seen, "video", item, "link", "title");
  }
  for (const item of asArray(result.peopleAlsoAsk)) {
    if (typeof item !== "object" || item === null) continue;
    const entry = item as Record<string, unknown>;
    pushSource(sources, seen, "people_also_ask", entry, "link", "title");
    for (const nested of asArray(entry.sources)) {
      pushSource(sources, seen, "people_also_ask", nested);
    }
  }

  const overview = result.aioverview;
  if (typeof overview === "object" && overview !== null) {
    const entry = overview as Record<string, unknown>;
    for (const item of asArray(entry.sources)) {
      pushSource(sources, seen, "ai_overview", item);
    }
    for (const item of asArray(entry.citationPills)) {
      pushSource(sources, seen, "ai_overview", item);
    }
  }

  return sources;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a brand name as a whole word, case-insensitively.
 *
 * `\b` is wrong at both ends for the names this deals with: it does not
 * fire next to a dot, so "acme.io" would never match its own alias, and it
 * fires inside a hyphenated word, so "acme" would match "acme-killer".
 *
 * The lookarounds below count letters, digits, underscores AND hyphens as
 * word characters, so "acme-killer" and "acmecorp" are both left alone,
 * while a dot stays a boundary — which is what lets a brand tracked as
 * "acme" match the "acme.io" an engine wrote.
 */
function countMatches(haystack: string, needle: string): [number, number] {
  const trimmed = needle.trim();
  if (trimmed.length === 0) return [0, -1];

  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_-])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_-])`,
    "giu",
  );
  let count = 0;
  let first = -1;
  for (const match of haystack.matchAll(pattern)) {
    count += 1;
    if (first === -1) first = match.index ?? -1;
  }
  return [count, first];
}

/**
 * How each tracked brand fared in one answer.
 *
 * Returns a row for every enabled brand, mentioned or not — see the table
 * comment in `lib/db/schema.ts` for why the misses have to be stored.
 */
export function extractMentions(
  text: string,
  sources: ExtractedSource[],
  brandList: Brand[],
): ExtractedMention[] {
  const domains = sources.map((source) => source.domain);

  return brandList.map((brand) => {
    let mentionCount = 0;
    let firstPosition = -1;

    for (const term of [brand.name, ...brand.aliases]) {
      const [count, index] = countMatches(text, term);
      mentionCount += count;
      if (index !== -1 && (firstPosition === -1 || index < firstPosition)) {
        firstPosition = index;
      }
    }

    // A brand's own domain counts, and so does a subdomain of it: an
    // answer citing "blog.acme.io" cited Acme. Suffix-matched on a dot so
    // "notacme.io" cannot match "acme.io".
    const brandDomains = brand.domains.map((d) => d.toLowerCase());
    const citedSourceCount = domains.filter((domain) =>
      brandDomains.some(
        (owned) => domain === owned || domain.endsWith(`.${owned}`),
      ),
    ).length;

    return {
      brandId: brand.id,
      mentioned: mentionCount > 0,
      mentionCount,
      firstPosition: firstPosition === -1 ? null : firstPosition,
      cited: citedSourceCount > 0,
      citedSourceCount,
    };
  });
}

/**
 * The queries an engine typed, and the follow-ups it offered.
 *
 * Only ChatGPT, Copilot, Grok and Perplexity report what they searched;
 * the rest return nothing here, and an empty result for those is the
 * honest answer rather than missing data.
 */
export function extractSearchQueries(response: unknown): ExtractedQuery[] {
  const result = unwrap(response);
  if (result === null) return [];

  const queries: ExtractedQuery[] = [];
  const seen = new Set<string>();

  const push = (kind: string, value: unknown) => {
    const query = typeof value === "string" ? value.trim() : "";
    if (query.length === 0) return;
    const key = `${kind} ${query.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    queries.push({ kind, position: queries.length + 1, query });
  };

  // What the model actually searched. Perplexity names the same thing
  // differently; both are the engine's own reformulation of the prompt.
  for (const item of asArray(result.searchQueries)) push("issued", item);
  for (const item of asArray(result.search_model_queries)) {
    push("issued", item);
  }

  // Follow-up chips shown to the reader. Navigation furniture, not the
  // engine's reasoning, so it never pools with the above.
  for (const item of asArray(result.related_queries)) push("suggested", item);
  for (const item of asArray(result.relatedSearches)) {
    if (typeof item === "object" && item !== null) {
      push("suggested", (item as Record<string, unknown>).query);
    } else {
      push("suggested", item);
    }
  }

  return queries;
}

/**
 * Candidate names the answer mentioned.
 *
 * Same literal matching as a tracked brand, and deliberately no more: this
 * cannot discover a brand nobody listed. It tells you which of the names
 * YOU wrote down are turning up, so promoting one into `brands` is a
 * decision you make on evidence rather than a guess the code made for you.
 *
 * Only the hits are returned. A candidate is not tracked, so it has no
 * denominator to preserve and a row of zeroes would say nothing.
 */
export function extractCandidates(
  text: string,
  names: string[] = BRAND_CANDIDATES,
): ExtractedCandidate[] {
  const found: ExtractedCandidate[] = [];
  for (const name of names) {
    const [count] = countMatches(text, name);
    if (count > 0) found.push({ name, mentionCount: count });
  }
  return found;
}

/** Everything derived from one stored response, in one pass. */
export function extractResult(
  response: unknown,
  brandList: Brand[],
): Extraction {
  const text = answerText(response);
  const sources = extractSources(response);
  return {
    text,
    sources,
    mentions: extractMentions(text, sources, brandList),
    queries: extractSearchQueries(response),
    candidates: extractCandidates(text),
  };
}

import { describe, expect, it } from "vitest";

import {
  BRAND_CANDIDATES,
  EXTRACTION_STAMP,
  answerText,
  extractCandidates,
  extractMentions,
  extractSearchQueries,
  extractSources,
  toDomain,
  type ExtractedSource,
} from "./extract";
import type { Brand } from "./db/schema";

function brand(overrides: Partial<Brand> & { name: string }): Brand {
  return {
    id: overrides.name,
    aliases: [],
    domains: [],
    isOwn: false,
    enabled: true,
    createdAt: new Date(),
    ...overrides,
  };
}

function source(domain: string): ExtractedSource {
  return {
    kind: "source",
    position: 1,
    url: `https://${domain}/x`,
    domain,
    label: null,
  };
}

describe("toDomain", () => {
  it("lowercases and drops a www prefix", () => {
    expect(toDomain("https://WWW.Example.com/a?b=c")).toBe("example.com");
  });

  it("keeps subdomains distinct", () => {
    expect(toDomain("https://docs.example.com/a")).toBe("docs.example.com");
  });

  it("returns null for something that is not a URL", () => {
    expect(toDomain("not a url")).toBeNull();
  });
});

describe("answerText", () => {
  it("unwraps the async envelope", () => {
    expect(answerText({ success: true, result: { text: "hi" } })).toBe("hi");
  });

  it("accepts a bare result object", () => {
    expect(answerText({ text: "hi" })).toBe("hi");
  });

  it("falls back to the AI Overview on a Google payload", () => {
    expect(
      answerText({
        result: { organicResults: [], aioverview: { text: "ov" } },
      }),
    ).toBe("ov");
  });

  it("is empty for a plain SERP, which wrote no prose", () => {
    expect(
      answerText({ result: { organicResults: [], aioverview: null } }),
    ).toBe("");
  });

  it("is empty rather than throwing on junk", () => {
    expect(answerText(null)).toBe("");
    expect(answerText("nonsense")).toBe("");
  });
});

describe("extractSources", () => {
  it("tags each link with where it came from", () => {
    const sources = extractSources({
      result: {
        sources: [{ position: 1, url: "https://a.com/1", label: "A" }],
        citationPills: [{ position: 2, url: "https://b.com/2", label: "B" }],
      },
    });

    expect(sources).toEqual([
      {
        kind: "source",
        position: 1,
        url: "https://a.com/1",
        domain: "a.com",
        label: "A",
      },
      {
        kind: "citation_pill",
        position: 2,
        url: "https://b.com/2",
        domain: "b.com",
        label: "B",
      },
    ]);
  });

  it("keeps a link that is both a source and a pill, once per kind", () => {
    const sources = extractSources({
      result: {
        sources: [{ url: "https://a.com/1" }],
        citationPills: [{ url: "https://a.com/1" }],
      },
    });
    expect(sources.map((s) => s.kind)).toEqual(["source", "citation_pill"]);
  });

  it("does not count one link twice within a kind", () => {
    const sources = extractSources({
      result: {
        sources: [{ url: "https://a.com/1" }, { url: "https://a.com/1" }],
      },
    });
    expect(sources).toHaveLength(1);
  });

  it("reads Google's organic list, ads and people-also-ask", () => {
    const sources = extractSources({
      result: {
        organicResults: [{ position: 1, link: "https://o.com", title: "O" }],
        ads: [{ position: 1, url: "https://ad.com" }],
        peopleAlsoAsk: [
          { link: "https://paa.com", sources: [{ url: "https://deep.com" }] },
        ],
      },
    });
    expect(sources.map((s) => [s.kind, s.domain])).toEqual([
      ["organic", "o.com"],
      ["ad", "ad.com"],
      ["people_also_ask", "paa.com"],
      ["people_also_ask", "deep.com"],
    ]);
  });

  it("skips entries with no usable URL instead of failing the batch", () => {
    const sources = extractSources({
      result: { sources: [{ url: "" }, { url: "javascript:void" }, null, 7] },
    });
    expect(sources).toEqual([]);
  });
});

describe("extractMentions", () => {
  it("returns a row per brand, including the ones never named", () => {
    const mentions = extractMentions(
      "Acme is great.",
      [],
      [brand({ name: "Acme" }), brand({ name: "Globex" })],
    );

    expect(mentions.map((m) => [m.brandId, m.mentioned])).toEqual([
      ["Acme", true],
      ["Globex", false],
    ]);
  });

  it("matches case-insensitively and counts every occurrence", () => {
    const [mention] = extractMentions(
      "acme, then ACME.",
      [],
      [brand({ name: "Acme" })],
    );
    expect(mention.mentionCount).toBe(2);
  });

  it("records where the brand was first named", () => {
    const [mention] = extractMentions(
      "First Globex, then Acme.",
      [],
      [brand({ name: "Acme" })],
    );
    expect(mention.firstPosition).toBe(19);
  });

  it("takes the earliest position across name and aliases", () => {
    const [mention] = extractMentions(
      "acme.io beats Acme Corp",
      [],
      [brand({ name: "Acme Corp", aliases: ["acme.io"] })],
    );
    expect(mention.firstPosition).toBe(0);
    expect(mention.mentionCount).toBe(2);
  });

  it("does not match a brand inside a longer word", () => {
    const [mention] = extractMentions(
      "acmecorp and acme-killer",
      [],
      [brand({ name: "acme" })],
    );
    expect(mention.mentioned).toBe(false);
  });

  it("matches a name that ends at a dot, which \\b would miss", () => {
    const [mention] = extractMentions(
      "We use acme.io daily.",
      [],
      [brand({ name: "acme.io" })],
    );
    expect(mention.mentioned).toBe(true);
  });

  it("treats a subdomain of a brand domain as a citation", () => {
    const [mention] = extractMentions(
      "",
      [source("blog.acme.io")],
      [brand({ name: "Acme", domains: ["acme.io"] })],
    );
    expect(mention.cited).toBe(true);
    expect(mention.citedSourceCount).toBe(1);
  });

  it("does not let a lookalike domain count as a citation", () => {
    const [mention] = extractMentions(
      "",
      [source("notacme.io")],
      [brand({ name: "Acme", domains: ["acme.io"] })],
    );
    expect(mention.cited).toBe(false);
  });

  it("separates being cited from being named", () => {
    const [mention] = extractMentions(
      "The answer names nobody.",
      [source("acme.io")],
      [brand({ name: "Acme", domains: ["acme.io"] })],
    );
    expect(mention.mentioned).toBe(false);
    expect(mention.cited).toBe(true);
  });

  it("does not count a name and its own alias twice in one phrase", () => {
    const [mention] = extractMentions(
      "Acme Corp is the vendor.",
      [],
      [brand({ name: "Acme", aliases: ["Acme Corp"] })],
    );
    expect(mention.mentionCount).toBe(1);
  });

  it("still counts the bare name where it stands alone", () => {
    const [mention] = extractMentions(
      "Acme Corp shipped it. Acme is well known.",
      [],
      [brand({ name: "Acme", aliases: ["Acme Corp"] })],
    );
    expect(mention.mentionCount).toBe(2);
  });

  it("ignores an empty alias rather than matching everything", () => {
    const [mention] = extractMentions(
      "anything at all",
      [],
      [brand({ name: "Acme", aliases: ["", "  "] })],
    );
    expect(mention.mentioned).toBe(false);
  });
});

describe("extractSearchQueries", () => {
  it("separates what the engine searched from what it suggested", () => {
    const queries = extractSearchQueries({
      result: {
        searchQueries: ["best crm 2026"],
        related_queries: ["crm for startups"],
      },
    });
    expect(queries.map((q) => [q.kind, q.query])).toEqual([
      ["issued", "best crm 2026"],
      ["suggested", "crm for startups"],
    ]);
  });

  it("reads Perplexity's differently-named field as the same thing", () => {
    const queries = extractSearchQueries({
      result: { search_model_queries: ["find the best crm"] },
    });
    expect(queries).toEqual([
      { kind: "issued", position: 1, query: "find the best crm" },
    ]);
  });

  it("unwraps Google's related searches, which are objects not strings", () => {
    const queries = extractSearchQueries({
      result: { relatedSearches: [{ query: "cheap crm", link: "https://g" }] },
    });
    expect(queries).toEqual([
      { kind: "suggested", position: 1, query: "cheap crm" },
    ]);
  });

  it("drops blanks and repeats, case-insensitively", () => {
    const queries = extractSearchQueries({
      result: { searchQueries: ["Best CRM", "best crm", "  ", ""] },
    });
    expect(queries).toHaveLength(1);
  });

  it("is empty for an engine that reports no queries", () => {
    expect(extractSearchQueries({ result: { text: "an answer" } })).toEqual([]);
  });
});

describe("extractCandidates", () => {
  const cand = (name: string, aliases: string[] = []) => ({ name, aliases });

  it("ships a worked example list, not an empty one", () => {
    expect(BRAND_CANDIDATES.length).toBeGreaterThan(0);
    // A blank or untrimmed entry would be silently dropped and the panel
    // would quietly under-report.
    for (const candidate of BRAND_CANDIDATES) {
      expect(candidate.name.trim()).toBe(candidate.name);
      expect(candidate.name.length).toBeGreaterThan(0);
      for (const alias of candidate.aliases) {
        expect(alias.trim()).toBe(alias);
        expect(alias.length).toBeGreaterThan(0);
      }
    }
  });

  it("accepts a bare string as shorthand for a candidate with no aliases", () => {
    const shorthand = BRAND_CANDIDATES.find((c) => c.aliases.length === 0);
    expect(shorthand).toBeDefined();
  });

  it("returns only the hits, never a row of zeroes", () => {
    const found = extractCandidates("Globex leads, Globex again", [
      cand("Globex"),
      cand("Initech"),
    ]);
    expect(found).toEqual([{ name: "Globex", mentionCount: 2 }]);
  });

  it("folds an alias into the canonical name rather than splitting it", () => {
    // Two mentions, not three: the bare "Acme", then "Acme, Inc" claiming
    // the phrase the shorter term would otherwise have double-counted.
    const found = extractCandidates(
      "Acme is good. Acme, Inc is the same firm.",
      [cand("Acme", ["Acme, Inc"])],
    );
    expect(found).toEqual([{ name: "Acme", mentionCount: 2 }]);
  });

  it("finds a candidate named only by an alias", () => {
    const found = extractCandidates("We evaluated Vandelay Industries.", [
      cand("Vandelay", ["Vandelay Industries"]),
    ]);
    expect(found).toEqual([{ name: "Vandelay", mentionCount: 1 }]);
  });

  it("uses the same word-boundary rule as a tracked brand", () => {
    expect(extractCandidates("globexcorp ships", [cand("Globex")])).toEqual([]);
    expect(extractCandidates("we use globex.com", [cand("Globex")])).toEqual([
      { name: "Globex", mentionCount: 1 },
    ]);
  });

  it("finds nothing in an answer with no prose", () => {
    expect(extractCandidates("", [cand("Globex")])).toEqual([]);
  });
});

describe("EXTRACTION_STAMP", () => {
  it("is a stable non-negative integer that fits the column", () => {
    expect(Number.isInteger(EXTRACTION_STAMP)).toBe(true);
    expect(EXTRACTION_STAMP).toBeGreaterThanOrEqual(0);
    expect(EXTRACTION_STAMP).toBeLessThanOrEqual(2147483647);
  });
});

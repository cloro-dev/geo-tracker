import { describe, expect, it } from "vitest";

import {
  answerText,
  extractMentions,
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

  it("ignores an empty alias rather than matching everything", () => {
    const [mention] = extractMentions(
      "anything at all",
      [],
      [brand({ name: "Acme", aliases: ["", "  "] })],
    );
    expect(mention.mentioned).toBe(false);
  });
});

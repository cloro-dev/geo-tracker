/**
 * Fills a local database with synthetic answers, so the Grafana panels can
 * be built and looked at without waiting a month for real data.
 *
 * Development only. It writes prompts, brands and completed results — the
 * raw material — and derives nothing. Run the scheduler tick afterwards
 * (`curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron`)
 * and the app itself fills the derived tables, through exactly the code
 * that runs in production. A seed script that wrote those tables directly
 * would prove only that the seed script works.
 *
 * The prompts are seeded DISABLED on purpose: an enabled prompt is due the
 * moment it exists, so the tick would try to submit it to the real cloro
 * API before getting to the refresh.
 *
 *   node scripts/seed.mjs          # add to whatever is there
 *   node scripts/seed.mjs --reset  # delete existing rows first
 */
import { Pool } from "pg";

const DAYS = 30;
const RESET = process.argv.includes("--reset");

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

/**
 * Deterministic PRNG, so two runs produce the same database and a panel
 * that looks wrong stays wrong while you fix it.
 */
let seed = 1337;
function random() {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
}

function pick(items) {
  return items[Math.floor(random() * items.length)];
}

const BRANDS = [
  { name: "Acme", aliases: ["Acme Corp"], domains: ["acme.io"], isOwn: true },
  { name: "Globex", aliases: [], domains: ["globex.com"], isOwn: false },
  { name: "Initech", aliases: ["Init Tech"], domains: ["initech.io"] },
  // Never named in prose, but its pages get cited. This is the case that a
  // single "mentioned" boolean would hide, and the reason `cited` is stored
  // separately — check a panel can still see it.
  { name: "Umbrella", aliases: [], domains: ["umbrella.co"] },
];

const PROMPTS = [
  "best CRM for startups",
  "top project management tools 2026",
  "how to choose a help desk platform",
  "best analytics tools for small teams",
  "cheapest CRM with an API",
  "which CRM integrates with Slack",
];

const ENGINES = ["chatgpt", "perplexity", "gemini", "aimode", "google"];

// Third-party pages the engines cite. Two are strong (cited constantly),
// the rest thin out — a realistic long tail for "pages to get listed on".
const PUBLISHER_PAGES = [
  ["g2.com", "/categories/crm"],
  ["capterra.com", "/crm-software"],
  ["reddit.com", "/r/sales/comments/best-crm"],
  ["techcrunch.com", "/2026/01/crm-roundup"],
  ["youtube.com", "/watch?v=crm-review"],
  ["forbes.com", "/advisor/business/software/best-crm"],
  ["nytimes.com", "/wirecutter/reviews/best-crm"],
];

/**
 * How often each brand is named, by engine. Deliberately uneven: a chart
 * where every line sits on top of every other proves nothing about whether
 * the panel separates them.
 */
const MENTION_RATE = {
  chatgpt: { Acme: 0.55, Globex: 0.8, Initech: 0.2, Umbrella: 0 },
  perplexity: { Acme: 0.45, Globex: 0.7, Initech: 0.35, Umbrella: 0 },
  gemini: { Acme: 0.3, Globex: 0.75, Initech: 0.15, Umbrella: 0 },
  aimode: { Acme: 0.4, Globex: 0.6, Initech: 0.25, Umbrella: 0 },
  // Google writes prose only when an AI Overview was served.
  google: { Acme: 0.25, Globex: 0.4, Initech: 0.1, Umbrella: 0 },
};

const BRAND_SITE = {
  Acme: ["acme.io", "/product"],
  Globex: ["globex.com", "/platform"],
  Initech: ["initech.io", "/pricing"],
  Umbrella: ["umbrella.co", "/solutions"],
};

/** Prose that names the given brands, in a plausible listicle voice. */
function answerProse(query, named) {
  if (named.length === 0) {
    return `There are many options for "${query}". The right choice depends on your team size, budget and the tools you already use.`;
  }
  const sentences = named.map(
    (brand, index) =>
      `${index + 1}. ${brand} — a strong option for teams that care about ${pick(["price", "integrations", "onboarding", "reporting", "support"])}.`,
  );
  return `Here are the leading tools for "${query}":\n\n${sentences.join("\n")}\n\nEach has a free tier worth trying before you commit.`;
}

/**
 * Links an answer cites: some of the named brands' own sites, plus
 * publishers.
 *
 * A named brand is linked only about three times in four. Real answers
 * recommend tools without linking them, and if naming always implied
 * citing then the two columns would agree on every row — which would hide
 * a panel that read the same column twice.
 */
function sourceList(named, alsoCited) {
  const links = [...named.filter(() => random() < 0.75), ...alsoCited].map(
    (brand) => {
      const [host, path] = BRAND_SITE[brand];
      return {
        url: `https://${host}${path}`,
        label: `${brand} — official site`,
      };
    },
  );

  const publisherCount = 2 + Math.floor(random() * 4);
  for (let i = 0; i < publisherCount; i += 1) {
    const [host, path] = pick(PUBLISHER_PAGES);
    links.push({ url: `https://${host}${path}`, label: `Guide on ${host}` });
  }

  return links.map((link, index) => ({ position: index + 1, ...link }));
}

/** The payload shape cloro returns, per engine. */
function buildResponse(engine, query, named, alsoCited) {
  const sources = sourceList(named, alsoCited);

  if (engine !== "google") {
    return {
      success: true,
      result: {
        text: answerProse(query, named),
        sources,
        citationPills: sources.slice(0, 3).map((source, index) => ({
          position: index + 1,
          url: source.url,
          label: source.label,
          domain: new URL(source.url).hostname,
        })),
      },
    };
  }

  // Google is a page of links, not an answer. An AI Overview appears on
  // roughly half of them; the rest have no prose at all, and a brand
  // genuinely cannot be "named in the answer" there.
  const hasOverview = random() < 0.5;
  return {
    success: true,
    result: {
      organicResults: sources.map((source, index) => ({
        position: index + 1,
        title: source.label,
        link: source.url,
        snippet: "A comparison of the leading tools in this category.",
      })),
      aioverview: hasOverview
        ? { text: answerProse(query, named), sources: sources.slice(0, 4) }
        : null,
      peopleAlsoAsk: [
        {
          question: `What is the best ${query}?`,
          link: "https://g2.com/categories/crm",
          title: "Category overview",
        },
      ],
    },
  };
}

async function main() {
  const pool = new Pool({ connectionString, max: 3 });

  if (RESET) {
    await pool.query("TRUNCATE results, prompts, brands CASCADE");
    console.log("Cleared prompts, results and brands.");
  }

  const brandIds = {};
  for (const brand of BRANDS) {
    const { rows } = await pool.query(
      `INSERT INTO brands (name, aliases, domains, is_own)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (lower(name)) DO UPDATE SET aliases = EXCLUDED.aliases
       RETURNING id`,
      [brand.name, brand.aliases, brand.domains, brand.isOwn ?? false],
    );
    brandIds[brand.name] = rows[0].id;
  }
  console.log(`Tracking ${BRANDS.length} brands.`);

  let results = 0;
  let failures = 0;

  for (const prompt of PROMPTS) {
    const { rows } = await pool.query(
      `INSERT INTO prompts (name, prompt, engines, runs_per_day, enabled)
       VALUES ($1, $2, $3, 1, false)
       RETURNING id`,
      [prompt, `What are the ${prompt}?`, ENGINES],
    );
    const promptId = rows[0].id;

    for (let day = DAYS; day > 0; day -= 1) {
      const completedAt = new Date(Date.now() - day * 24 * 60 * 60 * 1000);

      for (const engine of ENGINES) {
        // A few runs fail, as they do in production. They must stay out of
        // every visibility denominator: a failed scrape is not an answer
        // that declined to name you.
        if (random() < 0.04) {
          await pool.query(
            `INSERT INTO results (prompt_id, engine, task_id, status, error, created_at, completed_at)
             VALUES ($1, $2, $3, 'failed', 'Task failed', $4, $4)`,
            [promptId, engine, `seed_${++results}`, completedAt],
          );
          failures += 1;
          continue;
        }

        const rates = MENTION_RATE[engine];
        const named = Object.keys(rates).filter(
          (brand) => random() < rates[brand],
        );
        // Umbrella is cited without ever being named, and the others get
        // linked sometimes without appearing in the prose.
        const alsoCited = ["Umbrella"].filter(() => random() < 0.3);

        await pool.query(
          `INSERT INTO results (prompt_id, engine, task_id, status, response, credits_charged, created_at, completed_at)
           VALUES ($1, $2, $3, 'completed', $4, $5, $6, $6)`,
          [
            promptId,
            engine,
            `seed_${++results}`,
            JSON.stringify(buildResponse(engine, prompt, named, alsoCited)),
            1 + Math.floor(random() * 4),
            completedAt,
          ],
        );
      }
    }
  }

  console.log(
    `Seeded ${PROMPTS.length} prompts and ${results} results over ${DAYS} days (${failures} failed).`,
  );
  console.log(
    "\nNow run the scheduler tick to derive the tables the panels read:\n" +
      '  curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron',
  );

  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

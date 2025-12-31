/* build_news.mjs — PontoView News builder (RSS + Google News)
   - Supports:
     1) Traditional RSS/Atom feeds
     2) Google News via its official RSS endpoints (search + topics) with optional
        "indirect scraping": follow redirect to the original article and extract OG image + publish date.
   - Output: data/news.json (same shape used by news.html)
   - Node: 18+ (global fetch). Recommended: Node 20 on GitHub Actions.

   Config file: data/news_sources_web.json (or any path passed as argv[2])
*/

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Repo root = parent of /scripts
const ROOT = path.resolve(__dirname, "..");
const DEFAULT_SOURCES = path.join(ROOT, "data", "news_sources_web.json");
const OUT_PATH = path.join(ROOT, "data", "news.json");

const UA =
  "PontoViewBot/1.0 (+https://pontoview.com.br) NodeFetch (GitHub Actions)";

const BLOCKLIST = [
  "morte","morto","assassin","homic","crime","violên","tirote","trág","trag",
  "estupro","roubo","furto","sequestro","corpo",
  "política","eleição","partido","corrup","escând",
  "acidente grave","desastre","catástro","explos"
];

function nowIso() {
  return new Date().toISOString();
}

function stripHtml(s = "") {
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}


function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanTitle(title, sourceName) {
  const t = String(title || "").trim();
  if (!t) return "";
  if (sourceName) {
    const s = String(sourceName).trim();
    const re1 = new RegExp(`\\s+[-–—]\\s*${escapeRegex(s)}\\s*$`, "i");
    if (re1.test(t)) return t.replace(re1, "").trim();
  }
  return t.replace(/\\s+[|]\\s+[^|]{2,40}\\s*$/i, "").trim();
}

function normalizeImageUrl(u) {
  const url = String(u || "").trim();
  if (!url) return "";
  if (url.startsWith("data:")) return "";
  if (url.startsWith("http://")) return "https://" + url.slice("http://".length);
  return url;
}


function isBlocked(title = "", summary = "") {
  const hay = (title + " " + summary).toLowerCase();
  return BLOCKLIST.some((w) => hay.includes(w));


function tryParsePtBrDate(s) {
  // Accept: "03/12/2025 09:00", "03/12/2025 - 09:00", "03/12/2025", "3 de dezembro de 2025"
  const str = String(s || "").trim();

  // dd/mm/yyyy [hh:mm]
  let m = str.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\D+(\d{1,2}):(\d{2}))?/);
  if (m) {
    let dd = int(m[1]), mm = int(m[2]), yyyy = int(m[3]);
    if (yyyy < 100) yyyy = 2000 + yyyy;
    const hh = m[4] ? int(m[4]) : 0;
    const mi = m[5] ? int(m[5]) : 0;
    // Construct in UTC to avoid TZ drift on Actions
    return new Date(Date.UTC(yyyy, mm - 1, dd, hh, mi, 0));
  }

  // "3 de dezembro de 2025"
  m = str.toLowerCase().match(/(\d{1,2})\s+de\s+([a-zç]+)\s+de\s+(\d{4})/);
  if (m) {
    const dd = int(m[1]);
    const mon = m[2];
    const yyyy = int(m[3]);
    const months = {
      janeiro:0, fevereiro:1, março:2, marco:2, abril:3, maio:4, junho:5,
      julho:6, agosto:7, setembro:8, outubro:9, novembro:10, dezembro:11
    };
    if (months[mon] !== undefined) {
      return new Date(Date.UTC(yyyy, months[mon], dd, 12, 0, 0));
    }
  }

  return null;
}

function normalizeDate(value) {
  const now = new Date();
  const minYear = 2000;
  const maxYear = now.getUTCFullYear() + 2;

  const raw = String(value || "").trim();
  if (!raw) return "";

  // 1) Standard Date parse
  let d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    // 2) PT-BR patterns
    const pt = tryParsePtBrDate(raw);
    if (pt && !Number.isNaN(pt.getTime())) d = pt;
  }

  if (Number.isNaN(d.getTime())) return "";

  const y = d.getUTCFullYear();
  if (y < minYear || y > maxYear) return "";

  return d.toISOString();
}

function int(x) {
  const n = parseInt(x, 10);
  return Number.isFinite(n) ? n : 0;
}
}

function stableId(input) {
  // deterministic-ish id without crypto dependency
  let h = 0;
  for (let i = 0; i < input.length; i++) h = (h * 31 + input.charCodeAt(i)) >>> 0;
  return String(h);
}

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
    const text = await res.text();
    return { res, text };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Minimal RSS/Atom parsing without external deps:
 * - Extracts items/entries
 * - Reads common fields: title, link, pubDate/published/updated, description/summary/content
 * - Extracts image via enclosure/media:content/media:thumbnail where possible
 *
 * This is not a fully compliant XML parser, but works for the majority of feeds.
 */
function parseRss(xml) {
  const cleaned = xml.replace(/\r/g, "");
  const isAtom = /<feed[\s>]/i.test(cleaned) && /<entry[\s>]/i.test(cleaned);

  const itemTag = isAtom ? "entry" : "item";
  const itemRegex = new RegExp(`<${itemTag}[\\s\\S]*?<\\/${itemTag}>`, "gi");
  const items = cleaned.match(itemRegex) || [];

  const pick = (chunk, patterns) => {
    for (const p of patterns) {
      const m = chunk.match(p);
      if (m) return (m[1] ?? "").trim();
    }
    return "";
  };

  const unescapeCdata = (s) => s
    .replace(/^<!\\[CDATA\\[/, "")
    .replace(/\\]\\]>$/,"")
    .trim();

  const decodeEntities = (s) => s
    .replace(/&amp;/g,"&")
    .replace(/&lt;/g,"<")
    .replace(/&gt;/g,">")
    .replace(/&quot;/g,'"')
    .replace(/&#39;/g,"'");

  const getLink = (chunk) => {
    if (isAtom) {
      // <link href="..."/>
      const m1 = chunk.match(/<link[^>]+href="([^"]+)"[^>]*\\/?>/i);
      if (m1) return m1[1].trim();
      // <link>url</link>
      const m2 = chunk.match(/<link[^>]*>([\\s\\S]*?)<\\/link>/i);
      if (m2) return stripHtml(decodeEntities(unescapeCdata(m2[1])));
    }
    const m3 = chunk.match(/<link[^>]*>([\\s\\S]*?)<\\/link>/i);
    if (m3) return stripHtml(decodeEntities(unescapeCdata(m3[1])));
    return "";
  };

  const getImage = (chunk) => {
    // RSS enclosure
    const enc = chunk.match(/<enclosure[^>]+url="([^"]+)"[^>]*>/i);
    if (enc) return enc[1].trim();

    // media:content url
    const mc = chunk.match(/<media:content[^>]+url="([^"]+)"[^>]*>/i);
    if (mc) return mc[1].trim();

    // media:thumbnail url
    const mt = chunk.match(/<media:thumbnail[^>]+url="([^"]+)"[^>]*>/i);
    if (mt) return mt[1].trim();

    // content:encoded may contain an <img src=...>
    const ce = chunk.match(/<content:encoded[^>]*>([\\s\\S]*?)<\\/content:encoded>/i);
    if (ce) {
      const img = ce[1].match(/<img[^>]+src="([^"]+)"[^>]*>/i);
      if (img) return img[1].trim();
    }
    // description may contain <img>
    const desc = chunk.match(/<description[^>]*>([\\s\\S]*?)<\\/description>/i);
    if (desc) {
      const img = desc[1].match(/<img[^>]+src="([^"]+)"[^>]*>/i);
      if (img) return img[1].trim();
    }
    return "";
  };

  const getDate = (chunk) => pick(chunk, [
    /<pubDate[^>]*>([\\s\\S]*?)<\\/pubDate>/i,
    /<published[^>]*>([\\s\\S]*?)<\\/published>/i,
    /<updated[^>]*>([\\s\\S]*?)<\\/updated>/i,
    /<dc:date[^>]*>([\\s\\S]*?)<\\/dc:date>/i,
  ]);

  const getTitle = (chunk) => pick(chunk, [
    /<title[^>]*>([\\s\\S]*?)<\\/title>/i
  ]);

  const getSummary = (chunk) => pick(chunk, [
    /<description[^>]*>([\\s\\S]*?)<\\/description>/i,
    /<summary[^>]*>([\\s\\S]*?)<\\/summary>/i,
    /<content[^>]*>([\\s\\S]*?)<\\/content>/i,
    /<content:encoded[^>]*>([\\s\\S]*?)<\\/content:encoded>/i,
  ]);

  const parsed = [];
  for (const chunk of items) {
    const rawTitle = decodeEntities(unescapeCdata(getTitle(chunk)));
    const title = stripHtml(rawTitle);
    if (!title) continue;

    const link = getLink(chunk);
    const rawSummary = decodeEntities(unescapeCdata(getSummary(chunk)));
    const summaryFull = stripHtml(rawSummary);
    const summary = summaryFull.length > 220 ? summaryFull.slice(0, 220).trimEnd() + "…" : summaryFull;

    const publishedAt = normalizeDate(stripHtml(decodeEntities(unescapeCdata(getDate(chunk)))));
    const image = getImage(chunk);

    parsed.push({ title, url: link, summary, publishedAt, image });
  }
  return parsed;
}

function buildGoogleNewsRssUrl({
  query,
  hl = "pt-BR",
  gl = "BR",
  ceid = "BR:pt-419",
}) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&ceid=${encodeURIComponent(ceid)}`;
}

function extractOg(html, prop) {
  // prop: og:image, article:published_time
  const re = new RegExp(
    `<meta\\s+[^>]*(?:property|name)="${prop.replace(/[-/\\^$*+?.()|[\]{}]/g,"\\$&")}"[^>]*content="([^"]+)"[^>]*>`,
    "i"
  );
  const m = html.match(re);
  return m ? m[1].trim() : "";
}

function extractTimeDatetime(html) {
  // try <time datetime="...">
  const m = html.match(/<time[^>]+datetime="([^"]+)"[^>]*>/i);
  return m ? m[1].trim() : "";
}

async function enrichFromArticle(url) {
  try {
    const { res, text: html } = await fetchText(url, 20000);

    // If the publisher blocks, this may be the Google News redirect page.
    // We still try OG tags; if missing, we return empty.
    const ogImage = extractOg(html, "og:image") || extractOg(html, "twitter:image");
    const pub =
      extractOg(html, "article:published_time") ||
      extractOg(html, "og:updated_time") ||
      extractTimeDatetime(html);

    return { finalUrl: res.url || url, ogImage, publishedAt: normalizeDate(pub) };
  } catch {
    return { finalUrl: url, ogImage: "", publishedAt: "" };
  }
}

async function collectFromSource(src) {
  const name = src.name || "Fonte";
  const type = (src.type || "rss").toLowerCase();

  let feedUrl = src.rss;
  let allowArticleEnrich = true;

  if (type === "google_news") {
    // You can provide either "query" OR "rss" directly.
    if (!feedUrl) {
      feedUrl = buildGoogleNewsRssUrl({
        query: src.query || "",
        hl: src.hl || "pt-BR",
        gl: src.gl || "BR",
        ceid: src.ceid || "BR:pt-419",
      });
    }
    allowArticleEnrich = src.enrich !== false; // default true
  }

  if (!feedUrl) {
    return { items: [], error: "missing rss/query url" };
  }

  const { text: xml } = await fetchText(feedUrl, 20000);
  const entries = parseRss(xml);

  const out = [];
  for (const e of entries) {
    const title = cleanTitle(e.title || "", name);
    const summary = e.summary || "";
    if (!title) continue;
    if (isBlocked(title, summary)) continue;

    let url = (e.url || "").trim();
    let image = (e.image || "").trim();
    let publishedAt = normalizeDate((e.publishedAt || "").trim());

    // Optional: follow to publisher and extract OG image + publish date
    if ((!image || !publishedAt) && allowArticleEnrich && url) {
      const enriched = await enrichFromArticle(url);
      url = enriched.finalUrl || url;
      if (!image) image = enriched.ogImage || "";
      if (!publishedAt) publishedAt = enriched.publishedAt || "";
    }

    const id = `${name}:${stableId(url || title)}`;

    out.push({
      id,
      title,
      summary: summary || "",
      source: name,
      logo: src.logo || "",
      scope: src.scope || "",
      city: src.city || "",
      publishedAt: normalizeDate(publishedAt) || "",
      url: url || "",
      image: normalizeImageUrl(image || "")
    });
  }

  return { items: out, error: "" };
}

async function main() {
  const sourcesPath = process.argv[2]
    ? path.resolve(process.cwd(), process.argv[2])
    : DEFAULT_SOURCES;

  if (!fs.existsSync(sourcesPath)) {
    const payload = {
      generatedAt: nowIso(),
      items: [],
      stats: { error: `missing ${path.relative(ROOT, sourcesPath)}` },
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
    process.exit(0);
  }

  const cfg = JSON.parse(fs.readFileSync(sourcesPath, "utf-8"));
  const outPath = process.argv[3] ? path.resolve(process.cwd(), process.argv[3]) : OUT_PATH;
  const sources = Array.isArray(cfg.sources) ? cfg.sources : [];

  const allItems = [];
  const perSource = [];
  const failures = [];

  for (const s of sources) {
    const name = s.name || "Fonte";
    try {
      const { items, error } = await collectFromSource(s);
      if (error) failures.push({ source: name, error });
      perSource.push({ source: name, count: items.length });
      allItems.push(...items);
    } catch (e) {
      failures.push({ source: name, error: String(e?.message || e) });
    }
  }

  // Basic shuffle to avoid same-source clustering (optional)
  const shuffled = allItems
    .map((x) => ({ x, r: Math.random() }))
    .sort((a, b) => a.r - b.r)
    .map((o) => o.x);

  const payload = {
    generatedAt: nowIso(),
    items: shuffled.slice(0, cfg.limit ?? 80),
    stats: {
      sources: sources.length,
      items_before_limit: allItems.length,
      per_source: perSource,
      failures,
      notes: {
        sources_path: path.relative(ROOT, sourcesPath),
        supports: ["rss", "google_news"],
        enrich: "Follows redirects and tries og:image + published_time when missing",
      }
    },
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`Wrote ${path.relative(process.cwd(), outPath)} with ${payload.items.length} items`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

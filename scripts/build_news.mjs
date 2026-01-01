#!/usr/bin/env node
/**
 * build_news.mjs (plug-and-play)
 * - Lê fontes em ./data/news_sources_web_es_plus.json (ou NEWS_SOURCES)
 * - Suporta:
 *    - type: "rss" com campo rss
 *    - type: "google_news" com campo query (usa RSS oficial do Google News Search)
 * - Gera ./docs/data/news.json
 * - Baixa imagens para ./docs/data/img/* e referencia localmente (sem hotlink)
 *
 * Requisitos: Node 20+
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";

const ROOT = process.cwd();
const SOURCES = process.env.NEWS_SOURCES || path.join(ROOT, "data", "news_sources_web_es_plus.json");
const OUT_JSON = process.env.NEWS_OUT || path.join(ROOT, "docs", "data", "news.json");
const IMG_DIR = process.env.NEWS_IMG_DIR || path.join(ROOT, "docs", "data", "img");

const USER_AGENT = "PontoViewBot/1.0 (+GitHub Actions)";
const MAX_ITEMS_TOTAL = 80;

const BLOCKLIST = [
  "morte","morto","assassin","homic","crime","violên","tirote","trág","trag",
  "estupro","roubo","furto","sequestro","corpo",
  "política","eleição","partido","corrup","escând",
  "acidente grave","desastre","catástro","explos"
];

function nowIso(){
  return new Date().toISOString();
}

function stripHtml(s=""){
  return String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBlocked(title="", summary=""){
  const hay = (title + " " + summary).toLowerCase();
  return BLOCKLIST.some(w => hay.includes(w));
}

async function fetchText(url){
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }});
  if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
  return await res.text();
}

async function fetchBuf(url){
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }});
  if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  return { buf, contentType: ct };
}

function sha1(s){
  return crypto.createHash("sha1").update(s).digest("hex");
}

function guessExt(contentType, fallbackUrl=""){
  if(contentType.includes("image/webp")) return ".webp";
  if(contentType.includes("image/png")) return ".png";
  if(contentType.includes("image/gif")) return ".gif";
  if(contentType.includes("image/jpeg") || contentType.includes("image/jpg")) return ".jpg";
  const m = fallbackUrl.match(/\.(webp|png|gif|jpe?g)(\?|#|$)/i);
  if(m) return "." + m[1].toLowerCase().replace("jpeg","jpg");
  return ".jpg";
}

function ensureDir(p){
  fs.mkdirSync(p, { recursive: true });
}

function googleNewsRssUrl(query){
  // RSS oficial de busca do Google News (sem scraping)
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=pt-BR&gl=BR&ceid=BR:pt-419`;
}

function faviconForUrl(u){
  try{
    const host = new URL(u).hostname;
    // Serviço público de favicon (leve); se falhar, o painel apenas oculta
    return `https://www.google.com/s2/favicons?domain=${host}&sz=64`;
  }catch{
    return null;
  }
}

function extractImgFromHtml(html){
  // 1) og:image
  let m = html.match(/property=["']og:image["'][^>]*content=["']([^"']+)["']/i);
  if(m && m[1]) return m[1];
  // 2) twitter:image
  m = html.match(/name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);
  if(m && m[1]) return m[1];
  // 3) primeira <img src>
  m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if(m && m[1]) return m[1];
  return null;
}

function normalizeDate(d){
  if(!d) return null;
  const s = String(d).trim();
  // RSS pubDate geralmente parseia bem no Date
  const dt = new Date(s);
  if(!isNaN(dt.getTime())) return dt.toISOString();
  return s;
}

function getXmlItems(xml){
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    removeNSPrefix: true, // media:content => content
    allowBooleanAttributes: true
  });
  const j = parser.parse(xml);

  // RSS 2.0: rss.channel.item
  const channel = j?.rss?.channel || j?.feed;
  const items = channel?.item || channel?.entry || [];
  return Array.isArray(items) ? items : [items];
}

function pickFirst(...vals){
  for(const v of vals){
    if(v === undefined || v === null) continue;
    if(typeof v === "string" && v.trim() === "") continue;
    return v;
  }
  return null;
}

function extractRssImage(it){
  // media:content url
  const media = it?.content || it?.media?.content;
  if(media){
    if(Array.isArray(media)){
      const u = media.map(x => x?.["@_url"]).find(Boolean);
      if(u) return u;
    }else{
      const u = media?.["@_url"] || media?.["@_href"];
      if(u) return u;
    }
  }
  // enclosure url
  const enc = it?.enclosure;
  if(enc){
    const u = enc?.["@_url"] || enc?.["@_href"];
    if(u) return u;
  }
  // description html img
  const desc = pickFirst(it?.description, it?.summary, it?.["content:encoded"]);
  const html = typeof desc === "string" ? desc : (desc?.["#text"] || "");
  const m = html && html.match(/<img[^>]+src=["']([^"']+)["']/i);
  return m?.[1] || null;
}

function extractTitle(it){
  return stripHtml(pickFirst(it?.title?.["#text"], it?.title, it?.headline, it?.name) || "");
}

function extractLink(it){
  // RSS item.link pode ser string; Atom entry.link pode ser objeto/array com @href
  const link = it?.link;
  if(typeof link === "string") return link;
  if(Array.isArray(link)){
    const href = link.map(x => x?.["@_href"]).find(Boolean);
    if(href) return href;
  }
  if(link && typeof link === "object"){
    return link?.["@_href"] || link?.["@_url"] || null;
  }
  return null;
}

function extractSummary(it){
  const s = pickFirst(it?.description, it?.summary, it?.["content:encoded"], it?.content);
  const txt = typeof s === "string" ? s : (s?.["#text"] || "");
  return stripHtml(txt);
}

function extractPubDate(it){
  return pickFirst(it?.pubDate, it?.published, it?.updated, it?.date, it?.["dc:date"]);
}

async function downloadImageToLocal(url){
  if(!url) return null;
  ensureDir(IMG_DIR);

  const key = sha1(url);
  // Se já existe, reaproveita
  const existing = fs.readdirSync(IMG_DIR).find(f => f.startsWith(key));
  if(existing) return `./data/img/${existing}`;

  try{
    const { buf, contentType } = await fetchBuf(url);
    const ext = guessExt(contentType, url);
    const file = `${key}${ext}`;
    fs.writeFileSync(path.join(IMG_DIR, file), buf);
    return `./data/img/${file}`;
  }catch{
    return null;
  }
}

async function toItem(it, source){
  const title = extractTitle(it);
  const link = extractLink(it);
  const summary = extractSummary(it);
  if(!title) return null;
  if(isBlocked(title, summary)) return null;

  let image = extractRssImage(it);

  // Se não veio imagem no feed, tenta OG:image do artigo
  if(!image && link){
    try{
      const html = await fetchText(link);
      image = extractImgFromHtml(html);
    }catch{}
  }

  const localImage = image ? await downloadImageToLocal(image) : null;

  const publishedAt = normalizeDate(extractPubDate(it));

  const idBase = `${source.name}|${link || title}`;
  const id = sha1(idBase);

  const logo = link ? faviconForUrl(link) : null;

  return {
    id: `${source.name}:${id}`,
    title,
    summary: summary ? (summary.slice(0, 220) + (summary.length > 220 ? "…" : "")) : "",
    source: source.name,
    publishedAt,
    url: link,
    image: localImage || image || null,
    logo,
    scope: source.scope || "national",
    city: source.city || null
  };
}

async function main(){
  ensureDir(path.dirname(OUT_JSON));

  if(!fs.existsSync(SOURCES)){
    const payload = { generatedAt: nowIso(), items: [], stats: { error: `missing ${SOURCES}` } };
    fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2), "utf-8");
    console.log("Missing sources file:", SOURCES);
    process.exit(0);
  }

  const cfg = JSON.parse(fs.readFileSync(SOURCES, "utf-8"));
  const sources = cfg.sources || [];

  const all = [];
  const perSource = [];
  const failures = [];

  for(const s of sources){
    const name = s.name || "Fonte";
    const type = s.type || "rss";
    let url = s.rss;

    if(type === "google_news"){
      const q = s.query || s.q;
      if(!q){
        failures.push({ source: name, error: "missing query" });
        continue;
      }
      url = googleNewsRssUrl(q);
    }

    if(!url){
      failures.push({ source: name, error: "missing rss url" });
      continue;
    }

    try{
      const xml = await fetchText(url);
      const items = getXmlItems(xml);

      let count = 0;
      for(const it of items){
        const item = await toItem(it, { ...s, name });
        if(item){
          all.push(item);
          count++;
        }
        if(all.length >= MAX_ITEMS_TOTAL) break;
      }
      perSource.push({ source: name, count });
      if(all.length >= MAX_ITEMS_TOTAL) break;
    }catch(e){
      failures.push({ source: name, url, error: String(e?.message || e) });
    }
  }

  const payload = {
    generatedAt: nowIso(),
    items: all,
    stats: {
      sources: sources.length,
      items_before_limit: all.length,
      per_source: perSource,
      failures
    }
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`Wrote ${OUT_JSON} with ${all.length} items`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

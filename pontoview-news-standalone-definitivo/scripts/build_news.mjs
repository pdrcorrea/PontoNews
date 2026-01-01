
/* scripts/build_news.mjs — PontoView News builder (Definitivo)
   - Lê: docs/data/news_sources_web.json
   - Gera: docs/data/news.json
   - Baixa imagens (og:image / media) e salva localmente em docs/data/img/
   - Node 18+ (GitHub Actions)
*/
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Parser from "rss-parser";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const SOURCES_PATH = process.env.SOURCES_PATH || path.join(ROOT, "docs", "data", "news_sources_web.json");
const OUT_PATH     = process.env.OUT_PATH     || path.join(ROOT, "docs", "data", "news.json");
const IMG_DIR      = process.env.IMG_DIR      || path.join(ROOT, "docs", "data", "img");

const USER_AGENT = "PontoViewBot/2.0 (GitHub Actions; news builder)";

function nowIso(){
  return new Date().toISOString();
}
function ensureDir(p){
  fs.mkdirSync(p, { recursive: true });
}
function sha1(s){
  return crypto.createHash("sha1").update(String(s)).digest("hex");
}
function stripHtml(s){
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function fetchText(url, {timeoutMs=20000} = {}){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try{
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": USER_AGENT, "Accept": "text/html,application/xml;q=0.9,*/*;q=0.8" },
      signal: ctrl.signal
    });
    const txt = await res.text();
    return { ok: res.ok, status: res.status, url: res.url, text: txt };
  } finally {
    clearTimeout(t);
  }
}

function metaContent(html, prop){
  const re = new RegExp(
    `<meta\\s+[^>]*(?:property|name)="${prop.replace(/[-/\\^$*+?.()|[\]{}]/g,"\\$&")}"[^>]*content="([^"]+)"[^>]*>`,
    "i"
  );
  const m = html.match(re);
  return m ? m[1].trim() : "";
}

function extractTime(html){
  const m1 = metaContent(html, "article:published_time") || metaContent(html, "og:updated_time");
  if(m1) return m1;
  const m2 = html.match(/<time[^>]+datetime="([^"]+)"[^>]*>/i);
  return m2 ? m2[1].trim() : "";
}

async function resolveFinalUrl(url){
  // HEAD às vezes é bloqueado; usa GET leve
  try{
    const res = await fetch(url, { method:"GET", redirect:"follow", headers:{ "User-Agent": USER_AGENT } });
    // não precisa ler body inteiro
    res.body?.cancel?.();
    return res.url || url;
  }catch{
    return url;
  }
}

function guessExtFromContentType(ct){
  if(!ct) return "";
  ct = ct.toLowerCase();
  if(ct.includes("image/jpeg")) return ".jpg";
  if(ct.includes("image/png")) return ".png";
  if(ct.includes("image/webp")) return ".webp";
  if(ct.includes("image/gif")) return ".gif";
  return "";
}

async function downloadImage(url){
  if(!url) return "";
  ensureDir(IMG_DIR);

  const key = sha1(url);
  // evita baixar repetido (qualquer ext)
  const existing = fs.readdirSync(IMG_DIR).find(f => f.startsWith(key + "."));
  if(existing) return `./data/img/${existing}`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try{
    const res = await fetch(url, { redirect:"follow", headers:{ "User-Agent": USER_AGENT, "Accept": "image/*" }, signal: ctrl.signal });
    if(!res.ok) return "";
    const ct = res.headers.get("content-type") || "";
    const ext = guessExtFromContentType(ct) || path.extname(new URL(res.url).pathname) || ".jpg";
    const file = `${key}${ext.slice(0,5)}`;
    const buf = Buffer.from(await res.arrayBuffer());
    // limite ~1.5MB por imagem
    if(buf.length > 1_500_000) return "";
    fs.writeFileSync(path.join(IMG_DIR, file), buf);
    return `./data/img/${file}`;
  } catch {
    return "";
  } finally {
    clearTimeout(t);
  }
}

function buildGoogleNewsRss(query, dflt){
  const q = encodeURIComponent(query);
  const hl = encodeURIComponent(dflt.hl || "pt-BR");
  const gl = encodeURIComponent(dflt.gl || "BR");
  const ceid = encodeURIComponent(dflt.ceid || "BR:pt-419");
  return `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${ceid}`;
}

const parser = new Parser({
  timeout: 20000,
  headers: { "User-Agent": USER_AGENT }
});

async function parseFeed(url){
  return await parser.parseURL(url);
}

function pickMedia(item){
  // rss-parser coloca enclosure em item.enclosure?.url
  if(item?.enclosure?.url) return item.enclosure.url;
  // tenta media:content
  const mc = item["media:content"] || item.media?.content;
  if(Array.isArray(mc) && mc[0]?.$?.url) return mc[0].$.url;
  if(mc?.$?.url) return mc.$.url;
  // thumbnails
  const mt = item["media:thumbnail"];
  if(Array.isArray(mt) && mt[0]?.$?.url) return mt[0].$.url;
  if(mt?.$?.url) return mt.$.url;
  return "";
}

async function enrichFromArticle(articleUrl){
  if(!articleUrl) return { imageUrl:"", publishedAt:"" };

  // resolve redirects (especial google news)
  const finalUrl = await resolveFinalUrl(articleUrl);

  // 1) fetch direto
  let html = "";
  let pub = "";
  let img = "";
  try{
    const r = await fetchText(finalUrl, {timeoutMs: 20000});
    if(r.ok && r.text) html = r.text;
  }catch{}

  // 2) fallback via jina.ai (mais robusto)
  if(!html){
    const jina = "https://r.jina.ai/http://" + finalUrl.replace(/^https?:\/\//,"");
    try{
      const r2 = await fetchText(jina, {timeoutMs: 20000});
      if(r2.ok && r2.text) html = r2.text;
    }catch{}
  }

  if(html){
    img = metaContent(html, "og:image") || metaContent(html, "twitter:image") || "";
    pub = extractTime(html) || "";
  }

  return { imageUrl: img, publishedAt: pub, finalUrl };
}

function normalizeDate(s){
  if(!s) return "";
  try{
    const d = new Date(s);
    if(String(d) === "Invalid Date") return "";
    return d.toISOString();
  }catch{ return ""; }
}

function stableId(source, title, url){
  return `${source}:${sha1((url||"") + "|" + (title||""))}`;
}

async function main(){
  ensureDir(path.dirname(OUT_PATH));
  ensureDir(IMG_DIR);

  const cfg = JSON.parse(fs.readFileSync(SOURCES_PATH, "utf-8"));
  const dflt = cfg.defaults || {};
  const sources = cfg.sources || [];

  const all = [];
  const failures = [];
  const perSource = [];

  for(const s of sources){
    const name = s.name || "Fonte";
    const scope = (s.scope || "LOCAL").toUpperCase();
    let feedUrl = s.rss || s.url || "";

    if((s.type || "rss") === "google_news"){
      feedUrl = buildGoogleNewsRss(s.query || name, dflt);
    }

    if(!feedUrl){
      failures.push({ source: name, error: "missing url" });
      continue;
    }

    try{
      const feed = await parseFeed(feedUrl);
      const items = Array.isArray(feed.items) ? feed.items : [];
      let count = 0;

      for(const it of items){
        const title = stripHtml(it.title || "").trim();
        if(!title) continue;

        const link = (it.link || "").trim();
        const summary = stripHtml(it.contentSnippet || it.content || it.summary || "").slice(0, 220);
        const publishedAt0 = normalizeDate(it.isoDate || it.pubDate || it.published || it.updated || "");

        // imagem do feed se existir
        let imageRemote = pickMedia(it);

        // enriquece com og:image/published_time (limitado)
        let publishedAt = publishedAt0;
        let finalUrl = link;
        if((!imageRemote || !publishedAt) && link){
          const enr = await enrichFromArticle(link);
          if(!imageRemote) imageRemote = enr.imageUrl || "";
          if(!publishedAt) publishedAt = normalizeDate(enr.publishedAt || "");
          if(enr.finalUrl) finalUrl = enr.finalUrl;
          // evita bater muito
          await sleep(250);
        }

        // baixa e serve localmente (definitivo p/ imagens)
        const image = await downloadImage(imageRemote);

        all.push({
          id: stableId(name, title, finalUrl),
          title,
          summary: summary ? (summary + (summary.length >= 220 ? "…" : "")) : "",
          source: name,
          scope,
          publishedAt,
          url: finalUrl,
          image
        });

        count++;
        if(count >= 18) break; // por fonte
        if(all.length >= 80) break;
      }

      perSource.push({ source: name, count });
    }catch(e){
      failures.push({ source: name, url: feedUrl, error: String(e?.message || e) });
    }
  }

  // Ordena por data desc
  all.sort((a,b) => (b.publishedAt || "").localeCompare(a.publishedAt || ""));

  // Limpa imagens não usadas (mantém repo leve)
  const used = new Set(all.map(x => (x.image || "").replace("./data/img/","")).filter(Boolean));
  for(const f of fs.readdirSync(IMG_DIR)){
    if(!used.has(f)) {
      try{ fs.unlinkSync(path.join(IMG_DIR, f)); } catch {}
    }
  }

  const payload = {
    generatedAt: nowIso(),
    items: all.slice(0,80),
    stats: {
      sources: sources.length,
      items_before_limit: all.length,
      per_source: perSource,
      failures
    }
  };

  fs.writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), "utf-8");
  console.log(`Wrote ${OUT_PATH} with ${payload.items.length} items; images in ${IMG_DIR}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});

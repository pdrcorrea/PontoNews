# PontoView • Página de Notícias (plug and play)

Este repositório entrega **uma página única** de notícias para TV corporativa/sala de espera,
com **layout pronto** e atualização automática do `news.json` via GitHub Actions.

## Estrutura

- `docs/index.html` — página (GitHub Pages)
- `docs/data/news.json` — cache gerado automaticamente
- `docs/data/news_sources_web.json` — configuração das fontes (Google News RSS + RSS tradicional)
- `scripts/build_news.mjs` — gerador do `news.json`
- `.github/workflows/update-news.yml` — atualiza a cada 30 min

## Como publicar no GitHub Pages

1. Suba este repositório no GitHub
2. Vá em **Settings → Pages**
3. Em **Build and deployment**, selecione:
   - **Source**: Deploy from a branch
   - **Branch**: `main`
   - **Folder**: `/docs`
4. Aguarde o link do GitHub Pages aparecer

## Como atualizar as fontes

Edite `docs/data/news_sources_web.json`.

Campos úteis por fonte:
- `name` (obrigatório)
- `type`: `rss` ou `google_news`
- `rss`: URL RSS (quando `type: rss`)
- `query`: pesquisa do Google News (quando `type: google_news`)
- `scope`: `local` | `state` | `health`
- `city`: ex.: "Vitória"
- `enrich`: `true` tenta buscar `og:image` e data no site original quando faltar

Depois de alterar, rode o workflow **Update News** (ou aguarde o cron).

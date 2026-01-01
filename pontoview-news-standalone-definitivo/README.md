# PontoView • Página de Notícias (standalone)

## Como publicar
1. Crie um repositório novo no GitHub
2. Faça upload deste projeto **mantendo as pastas**
3. Vá em **Settings → Pages** e selecione:
   - Source: **Deploy from a branch**
   - Branch: **main**
   - Folder: **/docs**

A página ficará em: `https://SEU_USUARIO.github.io/SEU_REPO/news.html`

## Como atualizar as fontes
Edite: `docs/data/news_sources_web.json`

## Como forçar atualização agora
Acesse: **Actions → Update News (PontoView) → Run workflow**

> O GitHub Actions vai gerar `docs/data/news.json` e baixar as imagens para `docs/data/img/`
> (assim as imagens sempre carregam, sem depender do site original).

# Contas

PWA pessoal de contas a pagar (Supabase + HTML/JS puro, sem build).

- `config.js` – URL do projeto e publishable key (segura no front-end; o RLS protege os dados).
- Hospedagem: qualquer host estático com HTTPS (GitHub Pages, Cloudflare Pages, Netlify).
- iPhone: abrir no Safari → Compartilhar → "Adicionar à Tela de Início".
- Linux/Chrome: ícone de instalar na barra de endereço.

Ao publicar, cadastre a URL final em Supabase → Authentication → URL Configuration → Site URL.
Ao mudar arquivos, troque `CACHE` em `sw.js` (ex.: `contas-v2`) para forçar a atualização.

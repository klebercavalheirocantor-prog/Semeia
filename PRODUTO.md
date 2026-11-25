# Fechaê (o Semeia vendido para outras empresas): trabalho em andamento

Esta branch (`produto`) é a versão do Semeia que vira o **Fechaê**, CRM de assinatura para todo tipo de empresa.
Só Brasil por enquanto (decidido em 25/11/2026). Domínio: fechae.com.
Plano completo: doc "Semeia SaaS: plano para vender o CRM" (claude.ai, projeto CRM).

## Regras desta branch

- Desde 25/11/2026 a `main` (Railway, crm.agro-vox.com) já roda esta versão: a AgroVox é a empresa nº 1.
- Voltar para a versão antiga, se precisar: publicar o commit 3cd8424 (os dados nunca saíram do lugar).

## Como as empresas ficam separadas (feito em 25/11)

- **Um banco por empresa**: `data/contas/<nº>/crm.db`, com a pasta de arquivos, o WhatsApp e os backups dela.
  A lista de empresas fica em `data/plataforma.db`. Uma empresa não enxerga a outra porque os dados nem moram no
  mesmo arquivo (não depende de lembrar de filtrar cada consulta).
- O pedido entra na empresa do cookie (`sid=<empresa>.<token>`); webhook da Meta usa `/webhooks/meta/<empresa>`;
  link de "sair da lista" leva `c<empresa>-`; trabalho de fundo (campanhas, fluxos, e-mail, WhatsApp, backup) roda
  empresa por empresa (`eachAccount`). Eventos do WhatsApp ficam presos à empresa dona do número (`bound`).
- Sem empresa definida, o código só funciona se existir uma empresa só; com duas ou mais, dá erro (falha segura).
- "Marcas" continuam existindo DENTRO de uma empresa (ex.: AgroVox + AgroPool dividem contatos e equipe).
- **AgroVox**: o banco e os arquivos que já estavam na raiz de `data/` são a empresa nº 1, sem sair do lugar
  (empresas novas ficam em `data/contas/<nº>/`). Cookie, webhook e links antigos continuam valendo.
  No ar desde 25/11/2026 (decisão do Kleber: rodar o Fechaê já no servidor da AgroVox).
- Empresa nova (piloto): `node server/index.js nova-empresa "Empresa" "Nome do admin" email senha`.

## Perfil do ramo (feito em 25/11)

`server/perfil.js`: o que era da AgroVox no código (prompt da IA sobre antena/monitor, exemplos StarFire, respostas
prontas, prefixo "Agro Sinal", base de conhecimento, fluxos com tabelas de preço, textos de exemplo) virou o perfil
`agrovox`. Empresa nova nasce no perfil `padrao`, neutro. O banco que já existia ganha `agrovox` pela migração 012,
então nada muda para a AgroVox.

## Fase 1: piloto pago (5 a 10 empresas, contas criadas por nós)

### 1. Empresas separadas
- [x] Um banco por empresa, login pelo e-mail acha a empresa, mesmo e-mail não fica em duas empresas.
- [x] Arquivos, WhatsApp, avisos em tempo real, campanhas, fluxos e backups separados por empresa.
- [x] Testes automáticos (`test/empresas.test.js`): A não vê B, cookie trocado não entra, migração da AgroVox.
- [ ] Tela para criar marca extra (a rota `POST /api/brands` já existe).

### 2. Tirar o que é da AgroVox do código
- [x] Prompts da IA, tradução, respostas prontas, base de conhecimento, fluxos iniciais, prefixos de nome,
      assinatura de e-mail, relatório de resultado e exemplos nas telas.
- [ ] Logo e nome "Semeia" nas telas → Fechaê (junto com a identidade visual escolhida).

### 3. Servidor e dados
- [ ] Servidor próprio do Fechaê (Railway, projeto separado, com volume) — precisa do OK do Kleber (custo).
- [ ] Repositório próprio no GitHub.
- (Postgres/Supabase saiu do plano por enquanto: um SQLite por empresa num volume com backup diário aguenta
  dezenas de empresas e isola melhor. Rever se passar de ~100 empresas.)

### 4. Backup e alertas
- [x] Backup diário do banco de cada empresa (14 dias), na pasta dela.
- [ ] Cópia dos backups para fora do servidor + teste de restauração.
- [ ] Alerta de erro (e-mail) e página de saúde por empresa.

## Fase 2 (vender pelo site)
- [x] Nome e logo Fechaê nas telas, ícones do app, cores laranja e marinho (25/11).
- [x] Cadastro pelo site (`#/cadastro`): empresa nasce no teste grátis de 7 dias, a pessoa cria a própria senha e já entra.
      Só abre com `CADASTRO_ABERTO=1` no servidor.
- [x] Planos (Essencial R$ 197, Profissional R$ 397, Empresa R$ 797) com limite de usuários e números de WhatsApp.
- [x] Fim do teste sem assinatura: acesso pausado (só a tela do plano), dados guardados. AgroVox e empresas do comando
      `nova-empresa` são "interno": sem cobrança nem limite.
- [x] Assinatura mensal no Mercado Pago (`POST /api/billing/checkout` → link do MP; aviso em `/webhooks/mercadopago`,
      conferido na API do MP). Precisa de `MP_ACCESS_TOKEN` no servidor.
- [x] Termos revisados em 25/11 (`/termos.html`): termos de uso, política de privacidade e acordo de operador (LGPD),
      identificação da KC (Decreto 7.962/2013), atendimento em até 5 dias, desistência em 7 dias na 1ª assinatura,
      foro Ponta Porã/MS. Falta o advogado conferir.
- [x] Cancelar a assinatura pela tela (Ajustes › Plano): para a cobrança no MP e o acesso vai até o fim do mês pago.
- [x] Registro de acesso (data, hora, IP) por 6 meses+ — Marco Civil art. 15 (`access_log` em plataforma.db).
- [ ] Transferência internacional (Railway, Anthropic, Groq, Resend nos EUA): adotar as cláusulas-padrão da ANPD
      (Res. CD/ANPD 19/2024, obrigatórias desde 23/08/2025) com o advogado.
- [ ] Excluir automaticamente os dados 90 dias depois do cancelamento (hoje é manual).
- Quem vende: KC Financial Solutions Ltda (CNPJ 62.564.150/0001-85) por enquanto; CNPJ próprio só quando houver vendas (decisão do Kleber, 25/11).
- Contato nos termos: contato@agro-vox.com (provisório). IA: cada empresa conecta a própria chave da Anthropic/Groq (decisão do Kleber, 25/11).
- [ ] Antes de abrir o cadastro: token do Mercado Pago, revisão dos termos, domínio fechae.com,
      e-mail de boas-vindas.
- [ ] Painel do dono da plataforma (ver todas as empresas, plano, quem está devendo).

## Assistente (Claude dentro do CRM) — feito em 25/11
- Botão "Assistente" no menu: a pessoa conversa e ele busca/lê leads e conversas, resume, cria tarefa, move etapa,
  anota e mostra os números do painel (`server/assistente.js`).
- Segurança: só as ações da lista `TOOLS`; cada uma chama as rotas normais com o login de quem pediu (mesma empresa
  e permissões). Sem enviar mensagem, ligar campanha, apagar ou mexer em ajustes. Usa a chave de IA da empresa.
- Conector para o app do Claude (MCP, `server/mcp.js`): cada pessoa gera um link secreto em Ajustes › Minha conta e cola
  em Conectores no Claude. O link é uma sessão de login dela (1 ano, desligável); mesmas ações seguras do assistente.
- Resposta ao cliente pelo assistente: só rascunho na tela (editável); sai quando a pessoa clica em Enviar (feito em 25/11).
  O conector do Claude não tem essa ação.
- [ ] Próximo: trocar o link secreto por login OAuth no conector.

## Fase 3
WhatsApp oficial (Meta) · arquivos fora do servidor · WhatsApp em serviço separado · parcerias com agências.

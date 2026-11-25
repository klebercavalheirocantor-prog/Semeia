# Produto (CRM para vender a outras empresas): trabalho em andamento

Esta branch (`produto`) é a versão do Semeia que vai virar produto de assinatura, para todo tipo de empresa.
Plano completo: doc "Semeia SaaS: plano para vender o CRM" (claude.ai, projeto CRM).

## Regras desta branch

- **Nunca juntar com a `main`.** A `main` é o Semeia da AgroVox, em produção no Railway (crm.agro-vox.com).
  O Railway só publica a `main`; esta branch não vai ao ar sozinha.
- O AgroVox e o AgroPool não são alterados por nada daqui.
- Quando o produto tiver nome, servidor e repositório próprios, esta branch muda para lá.
- Nome do produto: em escolha (recomendado: Fechia). Até lá, "o produto".

## Fase 1: piloto pago (5 a 10 empresas, contas criadas por nós)

### 1. Empresas separadas (hoje: "marcas" com `brand_id`)
- [ ] Renomear o conceito "marca" para "empresa" na tela (no banco pode continuar `brand_id` por enquanto).
- [ ] Usuário pertence a UMA empresa; o seletor de marca some para quem não é dono da plataforma.
- [ ] Revisar TODAS as rotas de `server/app.js` (49 usam `req.brand`): toda consulta de lead, contato, conversa,
      mensagem, arquivo, campanha, fluxo, tarefa e canal filtra pela empresa do usuário.
- [ ] Arquivos (`/api/files/:id`) só abrem para a empresa dona.
- [ ] Teste automático: empresa A não vê nada da empresa B (uma rota por vez).

### 2. Tirar o que é da AgroVox do código (vira configuração de cada empresa)
- [ ] `server/ai.js`: prompt do atendente fala em antena/monitor e StarFire → genérico ("o produto ou modelo que o
      cliente procura"); exemplos vêm da base de conhecimento da empresa.
- [ ] `server/flows.js`: catálogo padrão (tabelas StarFire/Trimble), pergunta "modelo da sua antena" e
      `DEFAULT_KNOWLEDGE` da AgroVox → empresa nova começa com um exemplo neutro.
- [ ] `server/app.js`: resposta pronta "Conheça a AgroVox" → usa o site da empresa.
- [ ] `server/outbound.js`: assinatura de e-mail com o Satelito → imagem de assinatura da empresa (opcional).
- [ ] `server/results.js`: nome "AgroVox" como cliente padrão → nome da empresa.
- [ ] `public/pages/settings.js` e `flows.js`: exemplos nos campos (agro-vox.com, StarFire) → exemplos neutros.

### 3. Banco Postgres (Supabase)
- [ ] Camada de banco (`server/db.js`: `one`, `all`, `run`) funcionando com Postgres, mantendo SQLite nos testes.
- [ ] Migrações compatíveis com os dois.
- [ ] Rotina para copiar os dados de uma empresa piloto.

### 4. Backup e alertas
- [ ] Backup diário do Postgres + teste de restauração.
- [ ] Alerta de erro (e-mail) e página de saúde (`/api/health`).

## Depois (Fase 2 e 3)
Cadastro e teste grátis · cobrança automática (Mercado Pago) · planos e limites · WhatsApp oficial (Meta) ·
painel do dono · arquivos fora do servidor · WhatsApp em serviço separado · site · telas em espanhol.

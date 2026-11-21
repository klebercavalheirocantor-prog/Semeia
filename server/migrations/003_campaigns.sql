-- Campanhas de disparo (WhatsApp por modelo aprovado e e-mail) e pedido de saída do contato.

-- Quem pediu para não receber mais campanhas (respondeu SAIR ou clicou no link do e-mail).
-- O atendimento continua normal: só as campanhas param.
alter table contacts add column opt_out_at integer;

create table campaigns (
  id integer primary key,
  name text not null,
  channel text not null check (channel in ('whatsapp','email')),
  status text not null default 'draft' check (status in ('draft','running','paused','done')),
  tags text not null default '[]',            -- público: contatos com QUALQUER uma destas etiquetas ([] = todos)
  template_id integer references wa_templates(id) on delete set null,
  params text not null default '[]',          -- valor de cada variável do modelo; aceita {{primeiro_nome}} e {{nome}}
  subject text not null default '',           -- e-mail
  body text not null default '',              -- e-mail (texto; vira HTML simples)
  interval_seconds integer not null default 20,
  window_start integer not null default 8,    -- hora local em que pode começar a enviar
  window_end integer not null default 20,     -- hora local em que para
  daily_cap integer not null default 200,
  skip_recent_days integer not null default 7, -- não manda para quem recebeu campanha nos últimos N dias
  pause_reason text,
  next_at integer not null default 0,
  created_by integer references users(id) on delete set null,
  created_at integer not null,
  updated_at integer not null,
  started_at integer,
  finished_at integer
);

create table campaign_recipients (
  id integer primary key,
  campaign_id integer not null references campaigns(id) on delete cascade,
  contact_id integer not null references contacts(id) on delete cascade,
  address text not null,                      -- telefone normalizado ou e-mail
  status text not null default 'queued' check (status in ('queued','sent','failed','skipped','replied','optout')),
  message_id integer references messages(id) on delete set null,
  error text,
  sent_at integer,
  replied_at integer,
  unique (campaign_id, contact_id)
);
create index campaign_recipients_queue on campaign_recipients(campaign_id, status, id);
create index campaign_recipients_contact on campaign_recipients(contact_id, sent_at);

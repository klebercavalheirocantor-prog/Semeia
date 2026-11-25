-- fk-off
-- Mais de uma marca no mesmo CRM (ex.: AgroVox e AgroPool): contatos, etiquetas e equipe em comum;
-- funis/leads, canais, campanhas, fluxos e a lista de quem pediu para sair, separados por marca.
-- (Banco que já tinha rodado esta migração ganhou também a marca 'AgroPool'; empresa nova começa só com a marca 1.)
create table brands (
  id integer primary key,
  name text not null,
  created_at integer not null
);
insert into brands(id, name, created_at) values
  (1, coalesce((select json_extract(value, '$.company') from settings where key = 'general' and json_extract(value, '$.company') != ''), 'Minha empresa'), unixepoch() * 1000);

alter table pipelines add column brand_id integer not null default 1 references brands(id);
alter table campaigns add column brand_id integer not null default 1 references brands(id);
alter table flows add column brand_id integer not null default 1 references brands(id);

-- canais: refeito para aceitar e-mail (caixa de entrada lida pelo CRM) e ganhar a empresa
create table channels_new (
  id integer primary key,
  kind text not null check (kind in ('whatsapp','messenger','instagram','email')),
  name text not null,
  external_id text not null,
  config text not null default '{}',
  status text not null default 'active' check (status in ('active','error','disabled')),
  created_at integer not null,
  brand_id integer not null default 1 references brands(id),
  unique (kind, external_id)
);
insert into channels_new(id, kind, name, external_id, config, status, created_at) select id, kind, name, external_id, config, status, created_at from channels;
drop table channels;
alter table channels_new rename to channels;

-- quem pediu para sair, por empresa (quem sai da AgroVox ainda pode receber da AgroPool)
create table contact_optouts (
  contact_id integer not null references contacts(id) on delete cascade,
  brand_id integer not null references brands(id) on delete cascade,
  at integer not null,
  primary key (contact_id, brand_id)
);
insert into contact_optouts(contact_id, brand_id, at) select id, 1, opt_out_at from contacts where opt_out_at is not null;

-- conversa por e-mail: assunto e último Message-ID, para a resposta cair no mesmo fio
create table email_threads (
  conversation_id integer primary key references conversations(id) on delete cascade,
  subject text not null default '',
  last_message_id text
);

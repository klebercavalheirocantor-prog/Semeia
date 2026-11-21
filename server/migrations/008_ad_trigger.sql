-- fk-off
-- Novo gatilho de fluxo: "quando chegar pelo anúncio" (clique para WhatsApp no Facebook/Instagram).
-- O SQLite não muda o CHECK de uma coluna: a tabela é refeita com os mesmos dados.
create table flows_new (
  id integer primary key,
  name text not null,
  trigger text not null check (trigger in ('campaign_reply','new_conversation','stage_changed','ad_click')),
  trigger_config text not null default '{}',
  active integer not null default 0,
  graph text not null default '{"nodes":[],"edges":[]}',
  created_at integer not null,
  updated_at integer not null,
  brand_id integer not null default 1 references brands(id)
);
insert into flows_new(id, name, trigger, trigger_config, active, graph, created_at, updated_at, brand_id)
  select id, name, trigger, trigger_config, active, graph, created_at, updated_at, brand_id from flows;
drop table flows;
alter table flows_new rename to flows;

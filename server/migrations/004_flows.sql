-- Fluxos automáticos (follow-ups e respostas automáticas), desenhados no editor de arrastar.
create table flows (
  id integer primary key,
  name text not null,
  trigger text not null check (trigger in ('campaign_reply','new_conversation','stage_changed')),
  trigger_config text not null default '{}',  -- { campaign_id?, stage_id? }
  active integer not null default 0,
  graph text not null default '{"nodes":[],"edges":[]}',
  created_at integer not null,
  updated_at integer not null
);

-- Uma execução por conversa: onde o fluxo está e quando acorda.
create table flow_runs (
  id integer primary key,
  flow_id integer not null references flows(id) on delete cascade,
  conversation_id integer not null references conversations(id) on delete cascade,
  node_id text not null,
  state text not null check (state in ('running','waiting_reply','waiting_time','done','handoff','failed','stopped')),
  wake_at integer,
  vars text not null default '{}',
  error text,
  created_at integer not null,
  updated_at integer not null
);
create unique index flow_runs_one_active on flow_runs(conversation_id) where state in ('running','waiting_reply','waiting_time');
create index flow_runs_wake on flow_runs(state, wake_at);

-- Mensagens enviadas pelo robô (o inbox mostra "Robô" em vez do nome do atendente).
alter table messages add column bot integer not null default 0;

-- Campanha com imagem no cabeçalho do modelo (ex.: a arte do disparo).
alter table campaigns add column header_file_id integer references files(id) on delete set null;
alter table campaigns add column header_media text; -- {"channel_id":1,"id":"<media id da Meta>","at":<ms>}

-- Mensagens modelo (templates) do WhatsApp, espelho do que está aprovado na Meta.
create table wa_templates (
  id integer primary key,
  channel_id integer not null references channels(id) on delete cascade,
  meta_id text,
  name text not null,
  language text not null,
  category text,
  status text not null default 'PENDING',
  components text not null default '[]',
  updated_at integer not null,
  unique (channel_id, name, language)
);
create index wa_templates_meta on wa_templates(meta_id);

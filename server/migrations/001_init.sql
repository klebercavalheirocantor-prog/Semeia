-- Migração 1: fase 1 (CRM + inbox). Horários em ms UTC. Dinheiro em centavos.
-- Entidades polimórficas: entity in ('lead','contact','company'); limpeza feita na camada de dados.

create table roles (
  id integer primary key,
  name text not null unique,
  rights text not null default '{}'   -- {"leads":{"view":"all|own","edit":"all|own|none","delete":true},...}
);

create table users (
  id integer primary key,
  name text not null,
  email text not null unique collate nocase,
  pass_hash text not null,
  role_id integer references roles(id) on delete set null,
  is_admin integer not null default 0 check (is_admin in (0,1)),
  is_active integer not null default 1 check (is_active in (0,1)),
  created_at integer not null
);

create table sessions (
  token text primary key,
  user_id integer not null references users(id) on delete cascade,
  expires_at integer not null
);
create index sessions_user on sessions(user_id);

create table settings (key text primary key, value text not null);

create table pipelines (
  id integer primary key,
  name text not null,
  sort integer not null default 0
);

create table stages (
  id integer primary key,
  pipeline_id integer not null references pipelines(id) on delete cascade,
  name text not null,
  color text not null default '#99ccff',
  sort integer not null default 0,
  kind text not null default 'normal' check (kind in ('incoming','normal','won','lost'))
);
create index stages_pipeline on stages(pipeline_id, sort);

create table loss_reasons (id integer primary key, name text not null unique, sort integer not null default 0);

create table companies (
  id integer primary key,
  name text not null,
  responsible_id integer references users(id) on delete set null,
  created_by integer references users(id) on delete set null,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer
);
create index companies_name on companies(name);
create index companies_resp on companies(responsible_id);

create table contacts (
  id integer primary key,
  name text not null,
  company_id integer references companies(id) on delete set null,
  responsible_id integer references users(id) on delete set null,
  created_by integer references users(id) on delete set null,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer
);
create index contacts_name on contacts(name);
create index contacts_company on contacts(company_id);
create index contacts_resp on contacts(responsible_id);

-- telefones e emails; value_norm = só dígitos (telefone) ou minúsculo (email). Impede contato duplicado.
create table contact_points (
  id integer primary key,
  contact_id integer not null references contacts(id) on delete cascade,
  kind text not null check (kind in ('phone','email')),
  value text not null,
  value_norm text not null,
  unique (kind, value_norm)
);
create index contact_points_contact on contact_points(contact_id);

create table leads (
  id integer primary key,
  name text not null,
  price_cents integer not null default 0,
  pipeline_id integer not null references pipelines(id) on delete restrict,
  stage_id integer not null references stages(id) on delete restrict,
  company_id integer references companies(id) on delete set null,
  responsible_id integer references users(id) on delete set null,
  loss_reason_id integer references loss_reasons(id) on delete set null,
  closed_at integer,
  created_by integer references users(id) on delete set null,
  created_at integer not null,
  updated_at integer not null,
  deleted_at integer
);
create index leads_stage on leads(stage_id) where deleted_at is null;
create index leads_pipeline on leads(pipeline_id, updated_at) where deleted_at is null;
create index leads_resp on leads(responsible_id);
create index leads_company on leads(company_id);
create index leads_name on leads(name);

create table lead_contacts (
  lead_id integer not null references leads(id) on delete cascade,
  contact_id integer not null references contacts(id) on delete cascade,
  is_main integer not null default 0,
  primary key (lead_id, contact_id)
);
create index lead_contacts_contact on lead_contacts(contact_id);

create table custom_fields (
  id integer primary key,
  entity text not null check (entity in ('lead','contact','company')),
  name text not null,
  type text not null check (type in ('text','textarea','number','money','date','select','multiselect','checkbox','url')),
  options text not null default '[]',
  sort integer not null default 0
);

create table field_values (
  entity text not null,
  entity_id integer not null,
  field_id integer not null references custom_fields(id) on delete cascade,
  value text not null,
  primary key (entity, entity_id, field_id)
);

create table tags (id integer primary key, name text not null unique collate nocase, color text not null default '#ddd');
create table entity_tags (
  entity text not null,
  entity_id integer not null,
  tag_id integer not null references tags(id) on delete cascade,
  primary key (entity, entity_id, tag_id)
);
create index entity_tags_tag on entity_tags(tag_id);

create table notes (
  id integer primary key,
  entity text not null,
  entity_id integer not null,
  body text not null,
  is_pinned integer not null default 0,
  created_by integer references users(id) on delete set null,
  created_at integer not null
);
create index notes_entity on notes(entity, entity_id);

create table task_types (id integer primary key, name text not null unique, color text not null default '#6b8afd');

create table tasks (
  id integer primary key,
  entity text,
  entity_id integer,
  type_id integer references task_types(id) on delete set null,
  text text not null,
  due_at integer not null,
  responsible_id integer references users(id) on delete set null,
  done_at integer,
  result text,
  created_by integer references users(id) on delete set null,
  created_at integer not null
);
create index tasks_entity on tasks(entity, entity_id);
create index tasks_open on tasks(responsible_id, due_at) where done_at is null;

-- log de atividade (equivale aos "eventos" do original)
create table events (
  id integer primary key,
  entity text not null,
  entity_id integer not null,
  type text not null,
  data text not null default '{}',
  user_id integer references users(id) on delete set null,
  created_at integer not null
);
create index events_entity on events(entity, entity_id, created_at);

create table channels (
  id integer primary key,
  kind text not null check (kind in ('whatsapp','messenger','instagram')),
  name text not null,
  external_id text not null,          -- phone_number_id (WhatsApp) / page_id / ig_user_id
  config text not null default '{}',  -- token, app_secret, verify_token, waba_id, pipeline_id. Nunca vai para o navegador.
  status text not null default 'active' check (status in ('active','error','disabled')),
  created_at integer not null,
  unique (kind, external_id)
);

create table conversations (
  id integer primary key,
  channel_id integer not null references channels(id) on delete cascade,
  contact_id integer not null references contacts(id) on delete cascade,
  lead_id integer references leads(id) on delete set null,
  external_id text not null,          -- wa_id / PSID / IGSID do cliente
  status text not null default 'open' check (status in ('open','closed')),
  unread integer not null default 0,
  last_message_at integer not null,
  last_inbound_at integer,            -- janela de 24 h
  assigned_id integer references users(id) on delete set null,
  created_at integer not null
);
create unique index conversations_one_open on conversations(channel_id, external_id) where status = 'open';
create index conversations_last on conversations(last_message_at);
create index conversations_lead on conversations(lead_id);
create index conversations_contact on conversations(contact_id);

create table files (
  id integer primary key,
  name text not null,
  mime text not null,
  size integer not null,
  path text not null,
  created_at integer not null
);

create table messages (
  id integer primary key,
  conversation_id integer not null references conversations(id) on delete cascade,
  direction text not null check (direction in ('in','out')),
  user_id integer references users(id) on delete set null,
  kind text not null default 'text' check (kind in ('text','image','audio','video','document','sticker','location','template','other')),
  body text not null default '',
  file_id integer references files(id) on delete set null,
  external_id text unique,
  status text not null default 'sent' check (status in ('pending','sent','delivered','read','failed')),
  error text,
  created_at integer not null
);
create index messages_conv on messages(conversation_id, created_at);

create table jobs (
  id integer primary key,
  kind text not null,
  payload text not null default '{}',
  run_at integer not null,
  attempts integer not null default 0,
  done_at integer,
  error text
);
create index jobs_due on jobs(run_at) where done_at is null;

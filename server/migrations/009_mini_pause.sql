-- Pausa curta no meio do lote (ex.: a cada 50 mensagens, 20 a 23 minutos), além da pausa longa do lote.
alter table campaigns add column mini_every integer not null default 0;
alter table campaigns add column mini_pause_min integer not null default 0;
alter table campaigns add column mini_pause_max integer not null default 0;
alter table campaigns add column mini_sent integer not null default 0;

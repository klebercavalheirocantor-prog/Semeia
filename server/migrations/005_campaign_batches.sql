-- Ritmo em lotes (como no WA Web Plus): intervalo sorteado entre mínimo e máximo, lotes de tamanho sorteado e pausa entre lotes.
alter table campaigns add column interval_max_seconds integer;          -- nulo = intervalo fixo com ±20%
alter table campaigns add column batch_min integer not null default 0;  -- 0 = sem lotes
alter table campaigns add column batch_max integer not null default 0;
alter table campaigns add column batch_pause_minutes integer not null default 0;
alter table campaigns add column batch_target integer;                  -- tamanho sorteado do lote atual
alter table campaigns add column batch_sent integer not null default 0; -- quantas já saíram no lote atual

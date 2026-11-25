-- Perfil do ramo da empresa (ver server/perfil.js). Banco que já estava em uso (o da AgroVox) fica com o perfil "agrovox",
-- para nada mudar para ela; empresa nova (banco vazio) fica no perfil neutro.
insert into settings(key, value) select 'perfil', '"agrovox"' where exists (select 1 from users)
  on conflict(key) do nothing;

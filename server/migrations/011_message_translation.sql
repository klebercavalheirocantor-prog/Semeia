-- Tradução para português de mensagem recebida (ex.: cliente do Paraguai escreveu em espanhol), feita quando o atendente clica em "Traduzir".
alter table messages add column translated_body text;

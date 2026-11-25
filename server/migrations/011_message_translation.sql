-- Mensagem recebida em outra língua (ex.: cliente do Paraguai): tradução para português quando o atendente clica em "Traduzir"
-- (ou automática, para áudio transcrito). Áudio recebido: o texto falado, transcrito pela Groq (Whisper).
alter table messages add column translated_body text;
alter table messages add column transcript text;

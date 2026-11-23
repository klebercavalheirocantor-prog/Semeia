-- Tradução automática do que o atendente escreve (ex.: número do Paraguai/Argentina): guarda o texto original em português.
alter table messages add column original_body text;

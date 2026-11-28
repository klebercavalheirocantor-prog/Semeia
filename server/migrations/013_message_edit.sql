-- Mensagem enviada que foi apagada para todos ou editada depois (WhatsApp).
alter table messages add column deleted_at integer;
alter table messages add column edited_at integer;

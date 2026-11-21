-- Campanha de WhatsApp escolhe por qual número sai (WhatsApp Web ou API oficial).
alter table campaigns add column wa_channel_id integer references channels(id) on delete set null;

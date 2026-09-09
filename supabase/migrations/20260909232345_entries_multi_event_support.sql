alter table public.entries add column events text[] not null default '{}';
update public.entries set events = array[event] where event is not null and event <> '';
alter table public.entries drop column event;

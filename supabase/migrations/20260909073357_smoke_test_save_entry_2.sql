insert into public.entries (race_id, name, event, level)
values ('e30c079d-d601-4698-ac2e-0d063b208883', 'Smoketest Bot', 'Sprint', 'locked')
on conflict (race_id, name) do update set event = excluded.event, level = excluded.level;

-- id is pinned so the follow-up smoke-test migrations below can reference it deterministically on replay
insert into public.races (id, name, date, location, url, events, club_focus)
values ('e30c079d-d601-4698-ac2e-0d063b208883', 'SMOKETEST Race', '2099-01-15', 'Location TBC', 'https://example.com/race', array['Sprint','Olympic'], true)
returning id, name, date, events, club_focus;

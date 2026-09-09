-- Challenge Canberra: "100 distance" -> "100 Distance"
update public.entries set event = '100 Distance' where race_id = '43e3b885-b933-4240-98e6-ac4243ed7c2b' and event = '100 distance';
update public.races set events = array['100 Distance','Olympic','Standard','Duathlon'] where id = '43e3b885-b933-4240-98e6-ac4243ed7c2b';

-- Cronulla Tri Club Race: "tbc"/"Tbc" -> "TBC" (Event TBC stays distinct)
update public.entries set event = 'TBC' where race_id = '4762e262-8968-48db-b944-e98376707421' and event in ('tbc','Tbc');
update public.races set events = array['TBC','Warrior','Open (Sprint)','Event TBC','Junior B (Sprint)'] where id = '4762e262-8968-48db-b944-e98376707421';

-- Hawks Nest: "standard" -> "Standard"
update public.entries set event = 'Standard' where race_id = '6ee9aa3b-e648-458c-bb2a-e2ae015d6f99' and event = 'standard';
update public.races set events = array['Standard','Sprint'] where id = '6ee9aa3b-e648-458c-bb2a-e2ae015d6f99';

-- Ironman NZ: "ironman" -> "Ironman"
update public.entries set event = 'Ironman' where race_id = '988564c5-d181-4c58-a1c9-54aa2a217814' and event = 'ironman';
update public.races set events = array['Ironman','70.3'] where id = '988564c5-d181-4c58-a1c9-54aa2a217814';

-- Port Stephens Tri (Balance Champs): "Super sprint" -> "Super Sprint"
update public.entries set event = 'Super Sprint' where race_id = '4179c544-edd5-4fda-b618-edd10a27ee84' and event = 'Super sprint';
update public.races set events = array['Standard','Super Sprint','Aquabike','Sprint','Team with Ben','Event TBC','Standard Team'] where id = '4179c544-edd5-4fda-b618-edd10a27ee84';

-- Stockton Island Triathlon: "olympic" -> "Olympic"
update public.entries set event = 'Olympic' where race_id = '0c4ce111-255f-497e-9442-5819f477c26d' and event = 'olympic';
update public.races set events = array['Olympic Distance','Olympic','Sprint','Olympic - team'] where id = '0c4ce111-255f-497e-9442-5819f477c26d';

-- Callala Triathlon (12 Dec 2026): "Standard Triathlon" -> "Standard", "Sprint Triathlon" -> "Sprint"
update public.entries set event = 'Standard' where race_id = '36250fe7-a996-42c3-920e-4329d2e8cd3d' and event = 'Standard Triathlon';
update public.entries set event = 'Sprint' where race_id = '36250fe7-a996-42c3-920e-4329d2e8cd3d' and event = 'Sprint Triathlon';
update public.races set events = array['Standard','Sprint + kidztri','Sprint'] where id = '36250fe7-a996-42c3-920e-4329d2e8cd3d';

-- Berlin Marathon: "42.2 k" -> "42.2k"
update public.entries set event = '42.2k' where race_id = '7575995d-477a-4ab6-92ac-3e9be59024a3' and event = '42.2 k';
update public.races set events = array['42.2k'] where id = '7575995d-477a-4ab6-92ac-3e9be59024a3';

-- ---------------------------------------------------------------------------
-- Size and value limits on races and entries.
--
-- Every text column was unbounded. loadRaces() fetches every live race with
-- its roster on every page load, so one member (or one compromised member
-- account) could add a race with a 5 MB location and make the calendar
-- unusable for every visitor. These limits sit well above anything real:
-- when this was written the longest race name was 41 characters, the longest
-- location 25, the longest entry name 30, and the most events on a race 13.
--
-- level and event_type are pinned to the values in use. Both lists include a
-- legacy value the app no longer offers but existing rows still hold: 'not'
-- (level) and 'SwimRun' (event_type). Adding a new level or event type to
-- app.js now needs a migration too.
-- ---------------------------------------------------------------------------
alter table public.entries
  add constraint entries_name_length
    check (char_length(name) between 1 and 100),
  add constraint entries_level_known
    check (level in ('considering', 'planning', 'locked', 'not')),
  add constraint entries_events_size
    check (cardinality(events) <= 20 and char_length(array_to_string(events, '')) <= 500);

alter table public.races
  add constraint races_name_length
    check (char_length(name) between 1 and 150),
  add constraint races_location_length
    check (char_length(location) <= 150),
  -- Scheme check mirrors safeUrl() in app.js, so a javascript: URL can't be
  -- stored even by a client that skips the app.
  add constraint races_url_valid
    check (url is null or (char_length(url) <= 500 and url ~* '^https?://')),
  add constraint races_events_size
    check (cardinality(events) <= 30 and char_length(array_to_string(events, '')) <= 1000),
  add constraint races_event_type_known
    check (event_type is null or event_type in (
      'Balance Bolt', 'Bike', 'Multi-sport', 'Run', 'Swim', 'SwimRun', 'Triathlon'
    ));

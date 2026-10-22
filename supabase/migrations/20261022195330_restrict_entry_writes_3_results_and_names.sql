-- Owner-only commitments, part 3.
-- Results: created_by only. Same body as 20261013042941 minus the name branch.
create or replace function private.can_write_result(p_entry_id uuid)
returns boolean
language sql
security definer
stable
set search_path = ''
as $$
  select private.is_allow_listed()
     and exists (
           select 1
             from public.entries e
             join public.races r on r.id = e.race_id
            where e.id = p_entry_id
              and r.deleted_at is null
              and not r.balance_bolt
              and r.date <= (now() at time zone 'Australia/Sydney')::date
              and (
                    private.is_admin()
                    or e.created_by = auth.uid()
                  )
         );
$$;

-- Display names: refuse two or more of Latin, Greek and Cyrillic.
-- The ranges are fixed code points, mirrored in app.js cleanDisplayName().
-- Marks, spaces, punctuation, CJK, Arabic and the rest belong to no group.
-- Not caught: a whole name in one look-alike script ("Сам" for "Cam").
-- Same body as 20261012042109 plus the new check.
create or replace function private.clean_display_name(p_name text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v text := normalize(trim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g')), NFC);
begin
  v := trim(regexp_replace(v, '͏', '', 'g'));
  if char_length(v) < 2 or char_length(v) > 40 then
    raise exception 'Your name needs to be 2 to 40 characters.';
  end if;
  if v !~ '^([[:alpha:]̀-ͯ]|[ ''.’-])+$' then
    raise exception 'Use letters, spaces, apostrophes, hyphens and full stops in your name.';
  end if;
  -- Letters that draw nothing (Hangul fillers, braille blank, Khmer inherent
  -- vowels): "Alex Smith" plus U+3164 would look like "Alex Smith" yet be a
  -- different name to the uniqueness check. Same message as any other
  -- character that is not allowed.
  if v ~ '[\u115f\u1160\u3164\uffa0\u2800\u17b4\u17b5]' then
    raise exception 'Use letters, spaces, apostrophes, hyphens and full stops in your name.';
  end if;
  if v !~ '[[:alpha:]]' then
    raise exception 'Your name needs at least one letter.';
  end if;
  if (case when v ~ '[A-Za-zªºÀ-ÖØ-öø-ʯḀ-ỿⱠ-Ɀ꜠-ꟿꬰ-꭯Ａ-Ｚａ-ｚ]' then 1 else 0 end)
   + (case when v ~ '[Ͱ-Ͽἀ-῿]' then 1 else 0 end)
   + (case when v ~ '[Ѐ-ԯᲀ-᲏ⷠ-ⷿꙀ-ꚟ]' then 1 else 0 end) >= 2 then
    raise exception 'Your name mixes letters from different alphabets, such as Latin and Cyrillic. Use one alphabet.';
  end if;
  return v;
end;
$$;

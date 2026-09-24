-- jthoyer@gmail.com is the seeded admin (private.admins), but that is a
-- separate list from the club member allow-list (private.allowed_emails)
-- that checkMembership() in app.js checks — so the owner's own account was
-- signed out of the main calendar as a non-member. Add it using the same
-- private.email_hash() helper admin_allow_list_add() uses, so this is
-- exactly what clicking "add" in the admin console's Allow-list panel would
-- have done.
insert into private.allowed_emails (email_hash)
values (private.email_hash('jthoyer@gmail.com'))
on conflict do nothing;

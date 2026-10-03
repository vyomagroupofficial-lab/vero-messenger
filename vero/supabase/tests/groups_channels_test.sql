-- Tests for 007_groups_channels: group admin tools, invite links, join
-- requests, channels, communities. Run with scripts/test-db.sh.
\set ON_ERROR_STOP on
\set QUIET on
\pset tuples_only on
\pset format unaligned

create function pg_temp.as_user(p_id uuid) returns void language sql as $$
  select set_config('request.jwt.claim.sub', coalesce(p_id::text, ''), false);
$$;

create function pg_temp.expect_fail(p_sql text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED FAILURE but statement succeeded: %', p_sql;
exception when others then
  if sqlerrm like 'EXPECTED FAILURE%' then raise; end if;
end;
$$;

create function pg_temp.check(p_ok boolean, p_name text) returns void language plpgsql as $$
begin
  if p_ok is not true then raise exception 'FAILED: %', p_name; end if;
  raise notice 'ok - %', p_name;
end;
$$;

set client_min_messages = notice;

\set owner   '''0a000000-0000-4000-8000-000000000001'''
\set admin   '''0b000000-0000-4000-8000-000000000002'''
\set member  '''0c000000-0000-4000-8000-000000000003'''
\set outside '''0d000000-0000-4000-8000-000000000004'''
\set joiner  '''0e000000-0000-4000-8000-000000000005'''
\set second  '''0f000000-0000-4000-8000-000000000006'''

insert into auth.users (id, raw_user_meta_data) values
  (:owner,   '{"username":"g_owner","display_name":"Olive Owner"}'),
  (:admin,   '{"username":"g_admin","display_name":"Adam Admin"}'),
  (:member,  '{"username":"g_member","display_name":"Mia Member"}'),
  (:outside, '{"username":"g_outside","display_name":"Oscar Outsider"}'),
  (:joiner,  '{"username":"g_joiner","display_name":"Jo Joiner"}'),
  (:second,  '{"username":"g_second","display_name":"Sam Second"}');

create temp table ids (name text primary key, id uuid);
grant all on ids to authenticated;
create function pg_temp.id(p text) returns uuid language sql as $$ select id from ids where name = p $$;

-- Inserts a ciphertext as the current user from their device (name: <who>_dev).
create function pg_temp.send(p_conv uuid, p_dev text) returns void language sql as $$
  insert into messages (conversation_id, sender_device_id, sender_user_id, ciphertext)
  values (p_conv, pg_temp.id(p_dev), auth.uid(), '{"v":2}');
$$;

set role authenticated;

select pg_temp.as_user(:owner);
with d as (insert into devices (identity_public_key) values (repeat('O', 43)) returning id) insert into ids select 'owner_dev', id from d;
select pg_temp.as_user(:admin);
with d as (insert into devices (identity_public_key) values (repeat('A', 43)) returning id) insert into ids select 'admin_dev', id from d;
select pg_temp.as_user(:member);
with d as (insert into devices (identity_public_key) values (repeat('M', 43)) returning id) insert into ids select 'member_dev', id from d;
select pg_temp.as_user(:outside);
with d as (insert into devices (identity_public_key) values (repeat('X', 43)) returning id) insert into ids select 'outside_dev', id from d;
select pg_temp.as_user(:joiner);
with d as (insert into devices (identity_public_key) values (repeat('J', 43)) returning id) insert into ids select 'joiner_dev', id from d;

-- ════════════════════════════════════════════════════════════════════════════
-- GROUP SETTINGS, ROLES, PERMISSIONS
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_user(:owner);
insert into ids values ('grp', create_group_conversation('Hikers', array[:admin, :member]::uuid[]));
select set_group_member_role(pg_temp.id('grp'), :admin, 'admin');

select pg_temp.check((select only_admins_send = false and only_admins_edit_info = true
                      from group_settings where conversation_id = pg_temp.id('grp')),
  'a settings row with safe defaults exists for every new group');

select pg_temp.as_user(:outside);
select pg_temp.check((select count(*) from group_settings where conversation_id = pg_temp.id('grp')) = 0,
  'outsiders cannot read group settings');
select pg_temp.check((select count(*) from group_events where conversation_id = pg_temp.id('grp')) = 0,
  'outsiders cannot read group events');
select pg_temp.check(not can_use_channel_topic('group:' || pg_temp.id('grp'), false), 'outsiders cannot receive the group topic');

select pg_temp.as_user(:member);
select pg_temp.check(can_use_channel_topic('group:' || pg_temp.id('grp'), false), 'members receive the group topic');
select pg_temp.check(not can_use_channel_topic('group:' || pg_temp.id('grp'), true), 'nobody but the server sends on the group topic');
select pg_temp.expect_fail(format($$update group_settings set only_admins_send = false where conversation_id = %L$$, pg_temp.id('grp')));
select pg_temp.expect_fail(format($$insert into group_events (conversation_id, event_type) values (%L, 'renamed')$$, pg_temp.id('grp')));
select pg_temp.check(true, 'group settings/events cannot be written directly');

select pg_temp.expect_fail(format($$select update_group_info(%L, 'Hacked')$$, pg_temp.id('grp')));
select pg_temp.check(true, 'members cannot edit group info while only admins may');
select pg_temp.expect_fail(format($$select set_group_permissions(%L, false, false)$$, pg_temp.id('grp')));
select pg_temp.check(true, 'members cannot change group permissions');
select pg_temp.expect_fail(format($$select set_group_member_role(%L, %L, 'admin')$$, pg_temp.id('grp'), '0c000000-0000-4000-8000-000000000003'));
select pg_temp.check(true, 'a member cannot promote themselves');
select pg_temp.expect_fail(format($$select delete_group(%L)$$, pg_temp.id('grp')));
select pg_temp.check(true, 'a member cannot delete the group');

select pg_temp.as_user(:admin);
select update_group_info(pg_temp.id('grp'), 'Hiking club', 'Weekend trips', 'data:image/png;base64,iVBORw0KGgo=');
select pg_temp.check((select group_name from conversations where id = pg_temp.id('grp')) = 'Hiking club'
                     and (select description from group_settings where conversation_id = pg_temp.id('grp')) = 'Weekend trips',
  'admins edit name and description');
select pg_temp.expect_fail(format($$select update_group_info(%L, null, null, 'javascript:alert(1)')$$, pg_temp.id('grp')));
select pg_temp.expect_fail(format($$select update_group_info(%L, null, null, 'data:image/svg+xml;base64,AAAA')$$, pg_temp.id('grp')));
select pg_temp.check(true, 'avatars must be small raster data URIs');

select set_group_permissions(pg_temp.id('grp'), p_only_admins_edit_info => false);
select pg_temp.as_user(:member);
select update_group_info(pg_temp.id('grp'), p_description => 'Members can edit now');
select pg_temp.check((select description from group_settings where conversation_id = pg_temp.id('grp')) = 'Members can edit now',
  'members edit info once admins allow it');

-- Only admins can send
select pg_temp.send(pg_temp.id('grp'), 'member_dev');
select pg_temp.as_user(:admin);
select set_group_permissions(pg_temp.id('grp'), p_only_admins_send => true);
select pg_temp.as_user(:member);
select pg_temp.expect_fail(format($$select pg_temp.send(%L, 'member_dev')$$, pg_temp.id('grp')));
select pg_temp.check(true, 'non-admins cannot send in an admins-only group (server-enforced)');
select pg_temp.as_user(:admin);
select pg_temp.send(pg_temp.id('grp'), 'admin_dev');
select pg_temp.as_user(:owner);
select pg_temp.send(pg_temp.id('grp'), 'owner_dev');
select pg_temp.check(true, 'admins and the owner can still send');

-- Role rules
select pg_temp.as_user(:admin);
select set_group_member_role(pg_temp.id('grp'), :member, 'admin');
select pg_temp.check(group_member_role(pg_temp.id('grp'), :member) = 'admin', 'admins promote members');
select pg_temp.as_user(:member);
select pg_temp.send(pg_temp.id('grp'), 'member_dev');
select pg_temp.check(true, 'a promoted member can send in an admins-only group');
select pg_temp.expect_fail(format($$select set_group_member_role(%L, %L, 'member')$$, pg_temp.id('grp'), '0b000000-0000-4000-8000-000000000002'));
select pg_temp.check(true, 'an admin cannot dismiss another admin');
select pg_temp.expect_fail(format($$select set_group_member_role(%L, %L, 'member')$$, pg_temp.id('grp'), '0a000000-0000-4000-8000-000000000001'));
select pg_temp.check(true, 'nobody can demote the owner via set_group_member_role');
select set_group_member_role(pg_temp.id('grp'), :member, 'member');
select pg_temp.check(group_member_role(pg_temp.id('grp'), :member) = 'member', 'admins may step down');
select pg_temp.as_user(:admin);
select set_group_member_role(pg_temp.id('grp'), :member, 'admin');
select pg_temp.as_user(:owner);
select set_group_member_role(pg_temp.id('grp'), :member, 'member');
select pg_temp.check(group_member_role(pg_temp.id('grp'), :member) = 'member', 'the owner dismisses admins');
select pg_temp.expect_fail(format($$select set_group_member_role(%L, %L, 'owner')$$, pg_temp.id('grp'), '0c000000-0000-4000-8000-000000000003'));
select pg_temp.check(true, 'ownership cannot be granted via set_group_member_role');

-- Ownership transfer
select pg_temp.as_user(:admin);
select pg_temp.expect_fail(format($$select transfer_group_ownership(%L, %L)$$, pg_temp.id('grp'), '0b000000-0000-4000-8000-000000000002'));
select pg_temp.check(true, 'only the owner can transfer ownership');
select pg_temp.as_user(:owner);
select pg_temp.expect_fail(format($$select transfer_group_ownership(%L, %L)$$, pg_temp.id('grp'), '0d000000-0000-4000-8000-000000000004'));
select pg_temp.check(true, 'ownership cannot go to a non-member');
select transfer_group_ownership(pg_temp.id('grp'), :admin);
select pg_temp.check(group_member_role(pg_temp.id('grp'), :admin) = 'owner'
                     and group_member_role(pg_temp.id('grp'), :owner) = 'admin',
  'ownership transfer swaps owner and admin');
select pg_temp.as_user(:admin);
select transfer_group_ownership(pg_temp.id('grp'), :owner);

-- Events
select pg_temp.as_user(:member);
select pg_temp.check((select array_agg(distinct event_type order by event_type) from group_events where conversation_id = pg_temp.id('grp'))
                     @> array['created', 'added', 'promoted', 'demoted', 'owner_changed', 'renamed',
                              'description_changed', 'avatar_changed', 'settings_changed'],
  'membership, role and info changes are logged as group events');
reset role;
select pg_temp.check(exists (select 1 from realtime.messages where event = 'group.event'
                             and topic = 'group:' || pg_temp.id('grp')),
  'group events are broadcast on the group:<id> topic');
set role authenticated;

-- 001's remove_group_member still produces an event (logged by trigger)
select pg_temp.as_user(:owner);
select add_group_members(pg_temp.id('grp'), array[:second]::uuid[]);
select remove_group_member(pg_temp.id('grp'), :second);
select pg_temp.check((select count(*) from group_events where conversation_id = pg_temp.id('grp')
                      and event_type = 'removed' and target_id = :second) = 1,
  'removals via the 001 RPC are logged too');

-- ════════════════════════════════════════════════════════════════════════════
-- INVITE LINKS
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_user(:member);
select pg_temp.expect_fail(format($$select create_group_invite(%L)$$, pg_temp.id('grp')));
select pg_temp.check(true, 'members cannot create invite links');

select pg_temp.as_user(:admin);
insert into ids select 'inv', (create_group_invite(pg_temp.id('grp'))).id;
select pg_temp.check((select token ~ '^[A-Za-z0-9_-]{43}$' from group_invites where id = pg_temp.id('inv')),
  'invite tokens are 43 random base64url characters');
select pg_temp.check((select count(*) from list_group_invites(pg_temp.id('grp'))) = 1, 'admins list invite links');
reset role;
create temp table toks (name text primary key, token text);
grant all on toks to authenticated;
insert into toks select 'main', token from group_invites where id = pg_temp.id('inv');
set role authenticated;
create function pg_temp.tok(p text) returns text language sql as $$ select token from toks where name = p $$;

select pg_temp.as_user(:member);
select pg_temp.check((select count(*) from group_invites) = 0, 'members cannot see invite links');
select pg_temp.check((select count(*) from list_group_invites(pg_temp.id('grp'))) = 0, 'members cannot list invite links');

select pg_temp.as_user(:joiner);
select pg_temp.check((select status = 'valid' and group_name = 'Hiking club' and member_count = 3 and not is_member
                      from preview_group_invite(pg_temp.tok('main'))),
  'any signed-in user previews a valid invite (name, member count)');
select pg_temp.check((select status = 'invalid' and group_name is null
                      from preview_group_invite('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')),
  'unknown tokens reveal nothing');
select pg_temp.check((select status from join_group_via_invite(pg_temp.tok('main'))) = 'joined', 'join via invite');
select pg_temp.check(is_conversation_member(pg_temp.id('grp')), 'joiner is now a member');
select pg_temp.check((select count(*) from get_conversation_devices(pg_temp.id('grp'))) = 4,
  'joiner devices now receive message keys');
select pg_temp.check((select status from join_group_via_invite(pg_temp.tok('main'))) = 'already_member',
  'joining twice is idempotent');
select pg_temp.check((select details ->> 'via' from group_events where conversation_id = pg_temp.id('grp')
                      and event_type = 'joined' and target_id = :joiner) = 'invite',
  'invite joins are logged with their source');
select pg_temp.check(not exists (select 1 from group_events where conversation_id = pg_temp.id('grp')
                                 and event_type = 'created'),
  'new members only see events from when they joined');
select pg_temp.check((select uses from list_group_invites(pg_temp.id('grp')) limit 1) is null,
  'joiners (non-admins) cannot read invite usage');
select leave_group(pg_temp.id('grp'));

-- Revoked
select pg_temp.as_user(:admin);
select revoke_group_invite(pg_temp.id('inv'));
select pg_temp.as_user(:joiner);
select pg_temp.check((select status from preview_group_invite(pg_temp.tok('main'))) = 'revoked', 'revoked invite previews as revoked');
select pg_temp.check((select status from join_group_via_invite(pg_temp.tok('main'))) = 'revoked', 'revoked invite cannot be used');
select pg_temp.check(not is_conversation_member(pg_temp.id('grp')), 'no membership through a revoked link');

-- Expired
select pg_temp.as_user(:admin);
insert into ids select 'inv_exp', (create_group_invite(pg_temp.id('grp'), now() + interval '1 day')).id;
select pg_temp.expect_fail(format($$select create_group_invite(%L, now() - interval '1 day')$$, pg_temp.id('grp')));
select pg_temp.check(true, 'invites cannot be created already expired');
reset role;
insert into toks select 'exp', token from group_invites where id = pg_temp.id('inv_exp');
update group_invites set expires_at = now() - interval '1 minute' where id = pg_temp.id('inv_exp');
set role authenticated;
select pg_temp.as_user(:joiner);
select pg_temp.check((select status from join_group_via_invite(pg_temp.tok('exp'))) = 'expired', 'expired invite cannot be used');
select pg_temp.check(not is_conversation_member(pg_temp.id('grp')), 'no membership through an expired link');

-- Max uses
select pg_temp.as_user(:admin);
insert into ids select 'inv_once', (create_group_invite(pg_temp.id('grp'), null, 1)).id;
reset role;
insert into toks select 'once', token from group_invites where id = pg_temp.id('inv_once');
set role authenticated;
select pg_temp.as_user(:joiner);
select pg_temp.check((select status from join_group_via_invite(pg_temp.tok('once'))) = 'joined', 'single-use invite works once');
select leave_group(pg_temp.id('grp'));
select pg_temp.as_user(:outside);
select pg_temp.check((select status from join_group_via_invite(pg_temp.tok('once'))) = 'full', 'maxed-out invite cannot be used');
select pg_temp.check(not is_conversation_member(pg_temp.id('grp')), 'no membership through a maxed-out link');

-- Approval required
select pg_temp.as_user(:admin);
insert into ids select 'inv_appr', (create_group_invite(pg_temp.id('grp'), null, null, true)).id;
reset role;
insert into toks select 'appr', token from group_invites where id = pg_temp.id('inv_appr');
set role authenticated;
select pg_temp.as_user(:outside);
select pg_temp.check((select requires_approval from preview_group_invite(pg_temp.tok('appr'))), 'preview says approval is required');
insert into ids select 'req1', request_id from join_group_via_invite(pg_temp.tok('appr'));
select pg_temp.check(pg_temp.id('req1') is not null and not is_conversation_member(pg_temp.id('grp')),
  'approval-required invite creates a request, not a membership');
select pg_temp.check((select status from join_group_via_invite(pg_temp.tok('appr'))) = 'already_requested',
  'duplicate requests are not created');
select pg_temp.check((select count(*) from group_join_requests where user_id = :outside) = 1, 'requesters see their own request');
select pg_temp.as_user(:member);
select pg_temp.check((select count(*) from group_join_requests) = 0, 'non-admin members cannot see join requests');
select pg_temp.expect_fail(format($$select approve_group_join_request(%L)$$, pg_temp.id('req1')));
select pg_temp.check(true, 'non-admins cannot approve join requests');
select pg_temp.as_user(:outside);
select pg_temp.expect_fail(format($$select approve_group_join_request(%L)$$, pg_temp.id('req1')));
select pg_temp.check(true, 'requesters cannot approve themselves');
select pg_temp.as_user(:admin);
select pg_temp.check((select count(*) from group_join_requests where status = 'pending') = 1, 'admins see pending requests');
select approve_group_join_request(pg_temp.id('req1'));
select pg_temp.check(group_member_role(pg_temp.id('grp'), :outside) = 'member', 'approved requester becomes a member');
select pg_temp.expect_fail(format($$select deny_group_join_request(%L)$$, pg_temp.id('req1')));
select pg_temp.check(true, 'a decided request cannot be decided again');
select pg_temp.as_user(:outside);
select leave_group(pg_temp.id('grp'));
select pg_temp.as_user(:joiner);
insert into ids select 'req2', request_id from join_group_via_invite(pg_temp.tok('appr'));
select pg_temp.as_user(:admin);
select deny_group_join_request(pg_temp.id('req2'));
select pg_temp.as_user(:joiner);
select pg_temp.check(not is_conversation_member(pg_temp.id('grp'))
                     and (select status from group_join_requests where id = pg_temp.id('req2')) = 'denied',
  'denied requester stays out');

-- Group-level approval setting applies to plain links too
select pg_temp.as_user(:admin);
insert into ids select 'inv_open', (create_group_invite(pg_temp.id('grp'))).id;
select set_group_permissions(pg_temp.id('grp'), p_join_approval_required => true);
reset role;
insert into toks select 'open', token from group_invites where id = pg_temp.id('inv_open');
set role authenticated;
select pg_temp.as_user(:joiner);
select pg_temp.check((select status from join_group_via_invite(pg_temp.tok('open'))) = 'requested',
  '"approve new members" turns every link into a request');
select pg_temp.as_user(:admin);
select set_group_permissions(pg_temp.id('grp'), p_join_approval_required => false);

-- Blocks
select pg_temp.as_user(:owner);
insert into blocks (blocked_user_id) values (:second);
select pg_temp.as_user(:second);
select pg_temp.check((select status from join_group_via_invite(pg_temp.tok('open'))) = 'invalid',
  'a link cannot bypass a block with the group owner');
select pg_temp.as_user(:owner);
delete from blocks;

-- Rate limit (failed guesses count)
select pg_temp.as_user(:second);
select pg_temp.check((select count(*) from (select join_group_via_invite('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB') from generate_series(1, 9)) s) = 9,
  'nine failed join attempts');
select pg_temp.check((select status from join_group_via_invite('BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB')) = 'rate_limited',
  'invite joins are rate limited per user (failed attempts count)');
select pg_temp.check((select status from join_group_via_invite(pg_temp.tok('open'))) = 'rate_limited',
  'rate-limited users cannot join even with a valid token');

-- ════════════════════════════════════════════════════════════════════════════
-- LEAVE / DELETE
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_user(:member);
insert into ids values ('grp2', create_group_conversation('Book club', array[:admin, :joiner]::uuid[]));
select set_group_member_role(pg_temp.id('grp2'), :joiner, 'admin');
select leave_group(pg_temp.id('grp2'));
select pg_temp.as_user(:joiner);
select pg_temp.check(group_member_role(pg_temp.id('grp2'), :joiner) = 'owner',
  'an owner leaving hands ownership to the longest-serving admin');

select pg_temp.as_user(:admin);
select pg_temp.expect_fail(format($$select delete_group(%L)$$, pg_temp.id('grp2')));
select pg_temp.check(true, 'admins (non-owners) cannot delete a group');
select pg_temp.as_user(:joiner);
select pg_temp.send(pg_temp.id('grp2'), 'joiner_dev');
select delete_group(pg_temp.id('grp2'));
select pg_temp.check(not is_conversation_member(pg_temp.id('grp2')), 'deleting removes everyone');
reset role;
select pg_temp.check((select count(*) from messages where conversation_id = pg_temp.id('grp2')) = 0,
  'deleting wipes the group''s ciphertext');
select pg_temp.check(not is_active_group(pg_temp.id('grp2')), 'deleted group is tombstoned');
set role authenticated;
select pg_temp.expect_fail(format($$select add_group_members(%L, array[%L]::uuid[])$$, pg_temp.id('grp2'), '0b000000-0000-4000-8000-000000000002'));
select pg_temp.check(true, 'a deleted group cannot be revived by its former owner');

-- ════════════════════════════════════════════════════════════════════════════
-- CHANNELS
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_user(:owner);
insert into ids values ('ch', create_channel('Trail News', 'Trail_News', 'Updates', 'public'));
select pg_temp.check((select handle from channels where id = pg_temp.id('ch')) = 'trail_news', 'handles are lower-cased');
select pg_temp.expect_fail($$select create_channel('Dup', 'trail_news')$$);
select pg_temp.check(true, 'channel handles are unique');
select pg_temp.expect_fail($$select create_channel('Bad', 'a b')$$);
select pg_temp.check(true, 'invalid handles are rejected');
select pg_temp.check(not channel_handle_available('trail_news') and channel_handle_available('free_handle'),
  'handle availability check');

insert into channel_posts (channel_id, body) values (pg_temp.id('ch'), 'First post');
reset role;
insert into ids select 'post1', id from channel_posts where channel_id = pg_temp.id('ch');
select pg_temp.check((select author_id from channel_posts where id = pg_temp.id('post1')) = :owner,
  'post author is set server-side');
select pg_temp.check(exists (select 1 from realtime.messages where event = 'post.new' and topic = 'channel:' || pg_temp.id('ch')),
  'new posts are broadcast on channel:<id>');
set role authenticated;
select pg_temp.expect_fail(format($$insert into channel_posts (channel_id, body, media_path, media_mime) values (%L, 'x', %L, 'image/png')$$,
  pg_temp.id('ch'), '00000000-0000-4000-8000-000000000000/evil.png'));
select pg_temp.check(true, 'post media must live in the channel''s own folder');
insert into channel_posts (channel_id, media_path, media_mime) values (pg_temp.id('ch'), pg_temp.id('ch') || '/photo.jpg', 'image/jpeg');

select pg_temp.as_user(:outside);
select pg_temp.check((select count(*) from channels where id = pg_temp.id('ch')) = 1, 'public channel is visible to non-followers');
select pg_temp.check((select count(*) from channel_posts where channel_id = pg_temp.id('ch')) = 2, 'public channel posts are readable by non-followers');
select pg_temp.expect_fail(format($$insert into channel_posts (channel_id, body) values (%L, 'spam')$$, pg_temp.id('ch')));
select pg_temp.check(true, 'non-admins cannot post');
update channel_posts set body = 'defaced' where channel_id = pg_temp.id('ch');
select pg_temp.check((select count(*) from channel_posts where body = 'defaced') = 0, 'non-admins cannot edit posts');
delete from channel_posts where channel_id = pg_temp.id('ch');
select pg_temp.check((select count(*) from channel_posts where channel_id = pg_temp.id('ch')) = 2, 'non-admins cannot delete posts');
select pg_temp.expect_fail($$select author_id from channel_posts$$);
select pg_temp.check(true, 'post authors are not exposed to readers');
select pg_temp.expect_fail($$select invite_token from channels$$);
select pg_temp.check(true, 'invite tokens are not readable via the table');
select pg_temp.check(can_use_channel_topic('channel:' || pg_temp.id('ch'), false), 'anyone can receive a public channel''s realtime topic');
select pg_temp.check(not can_use_channel_topic('channel:' || pg_temp.id('ch'), true), 'non-admins cannot broadcast on a channel topic');

select follow_channel(pg_temp.id('ch'));
select follow_channel(pg_temp.id('ch'));
select pg_temp.check((select follower_count from channels where id = pg_temp.id('ch')) = 1, 'following is idempotent and counted');
select set_channel_muted(pg_temp.id('ch'), true);
select pg_temp.check((select muted from channel_followers where channel_id = pg_temp.id('ch')), 'followers can mute');
select pg_temp.check((select is_following and muted from get_channel_details(pg_temp.id('ch'))), 'details reflect follow + mute');
select pg_temp.check((select count(*) from my_channels()) = 1, 'my_channels lists followed channels');

select react_to_channel_post(pg_temp.id('post1'), '👍');
select pg_temp.as_user(:member);
select react_to_channel_post(pg_temp.id('post1'), '👍');
select pg_temp.check((select (reaction_counts ->> '👍')::int from channel_posts where id = pg_temp.id('post1')) = 2, 'reactions are counted');
select react_to_channel_post(pg_temp.id('post1'), '🔥');
select pg_temp.check((select reaction_counts from channel_posts where id = pg_temp.id('post1')) = '{"👍": 1, "🔥": 1}'::jsonb,
  'changing a reaction moves the count');
select react_to_channel_post(pg_temp.id('post1'), null);
select pg_temp.check((select reaction_counts from channel_posts where id = pg_temp.id('post1')) = '{"👍": 1}'::jsonb,
  'removing a reaction drops the count');
select pg_temp.check((select count(*) from channel_post_reactions) = 0, 'users only see their own reactions');

select pg_temp.as_user(:owner);
select pg_temp.check((select count(*) from channel_followers) = 0, 'admins cannot see who follows (only the count)');
select pg_temp.check((select follower_count from get_channel_details(pg_temp.id('ch'))) = 1, 'admins see the follower count');

-- Channel admins
select pg_temp.as_user(:outside);
select pg_temp.check((select count(*) from channel_admins) = 0, 'followers cannot see channel admins');
select pg_temp.expect_fail(format($$select add_channel_admin(%L, %L)$$, pg_temp.id('ch'), '0d000000-0000-4000-8000-000000000004'));
select pg_temp.check(true, 'followers cannot make themselves admin');
select pg_temp.as_user(:owner);
select add_channel_admin(pg_temp.id('ch'), :admin);
select pg_temp.as_user(:admin);
insert into channel_posts (channel_id, body) values (pg_temp.id('ch'), 'Admin post');
select pg_temp.check(true, 'added admins can post');
select pg_temp.check(can_use_channel_topic('channel:' || pg_temp.id('ch'), true), 'admins can broadcast on the channel topic');
select pg_temp.expect_fail(format($$select add_channel_admin(%L, %L)$$, pg_temp.id('ch'), '0c000000-0000-4000-8000-000000000003'));
select pg_temp.check(true, 'only the owner adds admins');
select pg_temp.expect_fail(format($$select delete_channel(%L)$$, pg_temp.id('ch')));
select pg_temp.check(true, 'admins cannot delete the channel');
select pg_temp.as_user(:owner);
select remove_channel_admin(pg_temp.id('ch'), :admin);
select pg_temp.as_user(:admin);
select pg_temp.expect_fail(format($$insert into channel_posts (channel_id, body) values (%L, 'late')$$, pg_temp.id('ch')));
select pg_temp.check(true, 'removed admins can no longer post');

-- Private channel
select pg_temp.as_user(:owner);
insert into ids values ('pch', create_channel('Secret Trails', 'secret_trails', null, 'private'));
insert into channel_posts (channel_id, body) values (pg_temp.id('pch'), 'Members only');
reset role;
insert into ids select 'ppost', id from channel_posts where channel_id = pg_temp.id('pch');
insert into toks select 'pch', invite_token from channels where id = pg_temp.id('pch');
set role authenticated;
select pg_temp.check(get_channel_invite_token(pg_temp.id('pch')) = pg_temp.tok('pch'), 'admins read the private invite token');

select pg_temp.as_user(:member);
select pg_temp.check((select count(*) from channels where id = pg_temp.id('pch')) = 0, 'private channel is invisible to non-followers');
select pg_temp.check((select count(*) from channel_posts where channel_id = pg_temp.id('pch')) = 0, 'non-followers cannot read private channel posts');
select pg_temp.check((select count(*) from get_channel_details(pg_temp.id('pch'))) = 0, 'no private channel details for non-followers');
select pg_temp.check((select count(*) from search_channels('secret')) = 0, 'private channels are not searchable');
select pg_temp.check(not can_use_channel_topic('channel:' || pg_temp.id('pch'), false), 'non-followers cannot receive a private channel topic');
select pg_temp.expect_fail(format($$select get_channel_invite_token(%L)$$, pg_temp.id('pch')));
select pg_temp.check(true, 'non-admins cannot read the private invite token');
select pg_temp.expect_fail(format($$select follow_channel(%L)$$, pg_temp.id('pch')));
select pg_temp.check(true, 'private channels cannot be followed without the link');
select pg_temp.expect_fail(format($$select react_to_channel_post(%L, '👍')$$, pg_temp.id('ppost')));
select pg_temp.check(true, 'non-followers cannot react to private posts');

-- realtime.messages RLS really applies to channel topics
\o /dev/null
select set_config('realtime.topic', 'channel:' || pg_temp.id('pch'), false);
\o
select pg_temp.check((select count(*) from realtime.messages) = 0, 'non-followers receive no private channel broadcasts');
select pg_temp.expect_fail(format($$insert into realtime.messages (topic, extension, event, payload) values ('channel:%s', 'broadcast', 'post.new', '{}')$$, pg_temp.id('pch')));
select pg_temp.check(true, 'non-admins cannot inject channel broadcasts');

select pg_temp.check((select status = 'valid' and name = 'Secret Trails' from preview_channel_invite(pg_temp.tok('pch'))), 'private invite preview');
select pg_temp.check((select status from follow_channel_via_invite(pg_temp.tok('pch'))) = 'following', 'follow private channel via link');
select pg_temp.check((select count(*) from channel_posts where channel_id = pg_temp.id('pch')) = 1, 'followers read private posts');
select pg_temp.check((select count(*) from realtime.messages) > 0, 'followers receive private channel broadcasts');
select set_config('realtime.topic', '', false);

select pg_temp.as_user(:owner);
\o /dev/null
select rotate_channel_invite(pg_temp.id('pch'));
\o
select pg_temp.as_user(:joiner);
select pg_temp.check((select status from follow_channel_via_invite(pg_temp.tok('pch'))) = 'invalid', 'rotated private links stop working');

select pg_temp.as_user(:outside);
select pg_temp.check((select count(*) from search_channels('trail')) = 1, 'public channels are searchable');
select pg_temp.check((select count(*) from search_channels('%')) = 0, 'LIKE wildcards in channel search are escaped');
select pg_temp.check((select count(*) from search_channels('')) >= 1, 'empty query lists popular public channels');
select unfollow_channel(pg_temp.id('ch'));
select pg_temp.check((select follower_count from channels where id = pg_temp.id('ch')) = 0, 'unfollow decrements the count');

select pg_temp.as_user(:owner);
select delete_channel(pg_temp.id('ch'));
select pg_temp.check((select count(*) from channels where id = pg_temp.id('ch')) = 0, 'the owner deletes a channel');
reset role;
select pg_temp.check((select count(*) from realtime.messages where topic = 'channel:' || pg_temp.id('ch') and event = 'post.deleted') = 0
                     and exists (select 1 from realtime.messages where topic = 'channel:' || pg_temp.id('ch') and event = 'channel.deleted'),
  'deleting a channel sends one channel.deleted, not one event per post');
set role authenticated;
select pg_temp.as_user(:owner);

-- ════════════════════════════════════════════════════════════════════════════
-- COMMUNITIES
-- ════════════════════════════════════════════════════════════════════════════
select pg_temp.as_user(:owner);
insert into ids values ('com', create_community('Mountaineers', 'All the clubs'));
insert into ids select 'ann', announcements_conversation_id from communities where id = pg_temp.id('com');
select pg_temp.check(community_role(pg_temp.id('com')) = 'owner', 'creator owns the community');
select pg_temp.check(group_member_role(pg_temp.id('ann')) = 'owner'
                     and (select only_admins_send from group_settings where conversation_id = pg_temp.id('ann')),
  'announcements group is admin-only and owned by the creator');

-- Linking: requires admin of both
select pg_temp.as_user(:owner);
insert into ids values ('cgrp', create_group_conversation('Climbers', array[:member, :joiner]::uuid[]));
select pg_temp.as_user(:member);
select pg_temp.expect_fail(format($$select link_group_to_community(%L, %L)$$, pg_temp.id('com'), pg_temp.id('cgrp')));
select pg_temp.check(true, 'non-admins cannot link groups');
select pg_temp.as_user(:owner);
select pg_temp.expect_fail(format($$select link_group_to_community(%L, %L)$$, pg_temp.id('com'), pg_temp.id('grp2')));
select pg_temp.check(true, 'cannot link a group you do not admin');
select link_group_to_community(pg_temp.id('com'), pg_temp.id('cgrp'));
select pg_temp.expect_fail(format($$select link_group_to_community(%L, %L)$$, pg_temp.id('com'), pg_temp.id('cgrp')));
select pg_temp.check(true, 'a group belongs to at most one community');

select pg_temp.as_user(:member);
select pg_temp.check(is_community_member(pg_temp.id('com')), 'members of a linked group join the community');
select pg_temp.check(group_member_role(pg_temp.id('ann')) = 'member', '...and its announcements group');
select pg_temp.check((select count(*) from communities) = 1, 'community members see the community');
select pg_temp.check((select count(*) from community_members) = 1, 'members only see their own membership row');
select pg_temp.check((select count(*) from get_community_groups(pg_temp.id('com'))) = 2, 'members see the community''s groups');
select pg_temp.expect_fail(format($$select pg_temp.send(%L, 'member_dev')$$, pg_temp.id('ann')));
select pg_temp.check(true, 'members cannot post in announcements');
select pg_temp.expect_fail(format($$select create_community_group(%L, 'Mine')$$, pg_temp.id('com')));
select pg_temp.check(true, 'members cannot create community groups');

select pg_temp.as_user(:outside);
select pg_temp.check((select count(*) from communities where id = pg_temp.id('com')) = 0, 'outsiders cannot see the community');
select pg_temp.check((select count(*) from get_community_groups(pg_temp.id('com'))) = 0, 'outsiders cannot list community groups');
select pg_temp.check((select count(*) from community_groups) = 0, 'outsiders cannot read community_groups');
select pg_temp.expect_fail(format($$select join_community_group(%L, %L)$$, pg_temp.id('com'), pg_temp.id('cgrp')));
select pg_temp.check(true, 'outsiders cannot join community groups');

select pg_temp.as_user(:owner);
select pg_temp.send(pg_temp.id('ann'), 'owner_dev');
select pg_temp.check(true, 'the owner posts announcements');
select pg_temp.check((select count(*) from community_members) = 3, 'community admins see all members');
insert into ids values ('open_grp', create_community_group(pg_temp.id('com'), 'Open meetups'));
insert into ids values ('closed_grp', create_community_group(pg_temp.id('com'), 'Leaders'));
select set_group_permissions(pg_temp.id('closed_grp'), p_join_approval_required => true);

select pg_temp.as_user(:member);
select pg_temp.check((select status from join_community_group(pg_temp.id('com'), pg_temp.id('open_grp'))) = 'joined',
  'community members join open community groups directly');
select pg_temp.check(is_conversation_member(pg_temp.id('open_grp')), 'joined group membership is real');
select pg_temp.check((select status from join_community_group(pg_temp.id('com'), pg_temp.id('closed_grp'))) = 'requested',
  'groups requiring approval get a join request');
select pg_temp.check(not is_conversation_member(pg_temp.id('closed_grp')), 'no membership before approval');
select pg_temp.check((select has_pending_request from get_community_groups(pg_temp.id('com'))
                      where conversation_id = pg_temp.id('closed_grp')), 'pending request shown in the group list');

-- Roles mirror into announcements
select pg_temp.as_user(:owner);
select set_community_member_role(pg_temp.id('com'), :member, 'admin');
select pg_temp.as_user(:member);
select pg_temp.check(group_member_role(pg_temp.id('ann')) = 'admin', 'community admins become announcements admins');
select pg_temp.send(pg_temp.id('ann'), 'member_dev');
select pg_temp.check(true, 'community admins can post announcements');
select pg_temp.expect_fail(format($$select set_community_member_role(%L, %L, 'member')$$, pg_temp.id('com'), '0a000000-0000-4000-8000-000000000001'));
select pg_temp.check(true, 'the owner''s community role cannot be changed');
select pg_temp.as_user(:owner);
select set_community_member_role(pg_temp.id('com'), :member, 'member');

-- Joining announcements by invite link joins the community
select pg_temp.as_user(:owner);
insert into ids select 'ann_inv', (create_group_invite(pg_temp.id('ann'))).id;
reset role;
insert into toks select 'ann', token from group_invites where id = pg_temp.id('ann_inv');
set role authenticated;
select pg_temp.as_user(:outside);
select pg_temp.check((select status from join_group_via_invite(pg_temp.tok('ann'))) = 'joined', 'join announcements via link');
select pg_temp.check(is_community_member(pg_temp.id('com')), 'joining the announcements group joins the community');

-- Leaving
select leave_community(pg_temp.id('com'));
select pg_temp.check(not is_community_member(pg_temp.id('com')) and not is_conversation_member(pg_temp.id('ann')),
  'leaving the community leaves announcements');
select pg_temp.as_user(:owner);
select pg_temp.expect_fail(format($$select leave_community(%L)$$, pg_temp.id('com')));
select pg_temp.expect_fail(format($$select leave_group(%L)$$, pg_temp.id('ann')));
select pg_temp.check(true, 'the community owner cannot leave');
select pg_temp.expect_fail(format($$select delete_group(%L)$$, pg_temp.id('ann')));
select pg_temp.check(true, 'announcements are deleted with the community, not alone');

select pg_temp.as_user(:member);
select pg_temp.expect_fail(format($$select unlink_group_from_community(%L, %L)$$, pg_temp.id('com'), pg_temp.id('cgrp')));
select pg_temp.check(true, 'members cannot unlink groups');
select pg_temp.as_user(:owner);
select unlink_group_from_community(pg_temp.id('com'), pg_temp.id('cgrp'));
select pg_temp.check((select count(*) from get_community_groups(pg_temp.id('com'))) = 3, 'unlinked group leaves the list');

select pg_temp.as_user(:member);
select pg_temp.expect_fail(format($$select delete_community(%L)$$, pg_temp.id('com')));
select pg_temp.check(true, 'members cannot delete the community');
select pg_temp.as_user(:owner);
select delete_community(pg_temp.id('com'));
select pg_temp.check((select count(*) from communities) = 0, 'the owner deletes the community');
select pg_temp.check(not is_active_group(pg_temp.id('ann')), 'deleting a community deletes its announcements group');
select pg_temp.check(is_active_group(pg_temp.id('open_grp')) and is_conversation_member(pg_temp.id('open_grp')),
  'linked groups survive the community');

-- ════════════════════════════════════════════════════════════════════════════
-- ANONYMOUS ACCESS
-- ════════════════════════════════════════════════════════════════════════════
reset role;
set role anon;
select pg_temp.as_user(null);
select pg_temp.expect_fail($$select * from preview_group_invite('AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')$$);
select pg_temp.expect_fail($$select * from search_channels('trail')$$);
select pg_temp.expect_fail($$select * from channels$$);
select pg_temp.expect_fail($$select * from channel_posts$$);
select pg_temp.expect_fail($$select * from group_invites$$);
select pg_temp.expect_fail($$select create_channel('x', 'anon_channel')$$);
select pg_temp.check(true, 'anonymous users cannot use any group/channel/community API');
reset role;

\echo 'ALL GROUPS/CHANNELS/COMMUNITIES TESTS PASSED'

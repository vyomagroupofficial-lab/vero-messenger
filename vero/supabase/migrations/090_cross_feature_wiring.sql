-- ============================================================================
-- Cross-feature wiring that has to run after every feature migration.
-- Each feature migration applies on top of 001 alone, so anything that links
-- two features (e.g. 005's push sender with 007's channel posts) lives here.
-- ============================================================================

-- Push notifications for new channel posts (function defined in 005, table in 007).
drop trigger if exists channel_posts_push_after_insert on public.channel_posts;
create trigger channel_posts_push_after_insert
  after insert on public.channel_posts
  for each row execute function public.channel_posts_push_after_insert();

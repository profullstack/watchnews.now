-- What a story is, as opposed to a fixture.
--
-- The news provider has always collected a summary, a lead image and the
-- publisher's own link for every story -- see collect() in packages/sports/src/
-- nichedb.js, which sets summary, imageUrl and url on every event it emits. The
-- catalogue writer then dropped all three on the floor, because there was nowhere
-- to put them, and nobody noticed: a fixture needs none of them, and the sports
-- brands are the ones that were being looked at.
--
-- The cost showed up on the story page. With no summary, no image and no link
-- out, /events/:id could only render the scoreboard it inherited -- two crests, a
-- score and a Final badge -- for an article. A reader got "Away — vs — BBC News"
-- over a headline, and no way to go and read the thing.
--
-- Nullable and unconstrained on purpose. Every existing row predates this and
-- stays valid; the columns fill in on the next sync pass rather than needing a
-- backfill, because the provider re-sends all three on every crawl.
alter table events add column if not exists summary   text;
alter table events add column if not exists image_url text;
-- The publisher's canonical link, not ours. Named url rather than link because
-- the provider calls it url and one rename per hop is one too many.
alter table events add column if not exists url       text;

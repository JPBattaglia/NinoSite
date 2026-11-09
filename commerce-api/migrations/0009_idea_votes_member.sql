-- Ideas board on the website (Nov 9, 2026): every visit to ninobattaglia.com/ideas.html looks up that visitor's own
-- votes. app_idea_votes is keyed by (idea_id, member_hash), so that lookup scanned every vote ever cast; this index
-- makes it read only the visitor's own rows (D1 bills every row a query scans).
CREATE INDEX IF NOT EXISTS app_idea_votes_member ON app_idea_votes(member_hash, created_at);

-- 0010: claim photos are kept in the database, encrypted, not on disk: the
-- hosting disk is wiped on every deploy. One file is at most 4 MB, at most 5 per claim.
alter table claim_evidence add column content text;   -- sealed base64 of the file (see pii.ts)

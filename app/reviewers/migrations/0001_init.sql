-- Descant's whole state: the people outside who may read, what each may read, the links that
-- invite them, what the private server last pushed, and the comments readers write here until
-- the private server has taken them into the repository.

-- The founders, as the private server last named them (design/app/people.json). A founder never
-- has a password here: a one-time link minted by the private server is the only way in.
CREATE TABLE founders (
  key TEXT PRIMARY KEY,                 -- a writer key, as in people.json
  name TEXT NOT NULL,                   -- the name before the address in people.json
  emailSha256 TEXT                      -- SHA-256 of the address in people.json, lowercased; a reader may not use it
);

-- Every article the repository holds, as the private server last pushed it. The text is kept
-- only while the article is shared (a grant or a live link names it); otherwise it is NULL.
CREATE TABLE articles (
  path TEXT PRIMARY KEY,                -- articles/<folder>/article.md
  title TEXT NOT NULL,
  owner TEXT NOT NULL,                  -- a writer key | both | unassigned | '' (missing)
  status TEXT NOT NULL,
  phase TEXT NOT NULL,
  ord INTEGER NOT NULL,
  markdown TEXT,
  versionSha TEXT,
  versionWhen TEXT
);

-- A reader: an account made from an invitation link.
CREATE TABLE people (
  id TEXT PRIMARY KEY,                  -- p<hex>
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,           -- lowercase
  secret TEXT NOT NULL,                 -- pbkdf2-sha256$<iterations>$<salt>$<hash>, never the password
  createdAt TEXT NOT NULL,
  lastSeenAt TEXT,
  sessionsFrom INTEGER NOT NULL DEFAULT 0   -- unix seconds; a session signed in before this is refused
);

-- What each reader may read.
CREATE TABLE grants (
  personId TEXT NOT NULL,
  path TEXT NOT NULL,
  grantedBy TEXT NOT NULL,              -- the founder whose link or action gave it
  createdAt TEXT NOT NULL,
  PRIMARY KEY (personId, path)
);

-- An invitation link. Only the SHA-256 of its token is kept; the link is shown once.
CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  tokenHash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  createdBy TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  usesLeft INTEGER NOT NULL CHECK (usesLeft >= 0),   -- a use past zero fails the whole batch
  revokedAt TEXT
);
CREATE TABLE invite_articles (
  inviteId TEXT NOT NULL,
  path TEXT NOT NULL,
  PRIMARY KEY (inviteId, path)
);

-- One-time links: a founder's way in (kind 'founder', 5 minutes) and a reader's password reset
-- (kind 'reset', 24 hours). Only the SHA-256 of the token is kept.
CREATE TABLE onetime (
  tokenHash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,                -- the founder's key, or the reader's person id
  createdBy TEXT,
  createdAt TEXT NOT NULL,
  expiresAt TEXT NOT NULL,
  usedAt TEXT
);

-- A thread a reader started. Its id is the number the reader's page knows it by and the one the
-- private server records in the thread file (source: descant:<id>).
CREATE TABLE threads (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  personId TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
CREATE INDEX threads_by_person ON threads(personId, path);

-- Every message a reader wrote here, the opening one of a thread and each reply. `seq` orders
-- them for the private server's pull; `id` is what it records, so a retry never duplicates.
CREATE TABLE comments (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,              -- c<hex>
  threadId INTEGER NOT NULL,
  kind TEXT NOT NULL,                   -- thread | reply
  personId TEXT NOT NULL,
  name TEXT NOT NULL,                   -- the reader's name and address as they were when written
  email TEXT NOT NULL,
  text TEXT NOT NULL,
  anchor TEXT,                          -- JSON, the opening message only
  refersTo TEXT,
  created TEXT NOT NULL,                -- as the thread file will carry it
  createdAt TEXT NOT NULL,              -- ISO time, for the posting limit
  syncedGen INTEGER,                    -- the push generation current when the private server took it
  refused INTEGER NOT NULL DEFAULT 0    -- 1: the private server could not store it
);
CREATE INDEX comments_by_thread ON comments(threadId);
CREATE INDEX comments_by_person ON comments(personId, createdAt);
CREATE INDEX comments_unsynced ON comments(syncedGen);

-- The private server's copy of each reader thread (with the founders' replies), from the last push.
CREATE TABLE snapshots (
  threadId INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  thread TEXT NOT NULL,                 -- JSON, the thread as the review file reads
  gen INTEGER NOT NULL
);

-- `gen` counts pushes, so a comment the private server took after a snapshot was made still shows.
CREATE TABLE sync_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
INSERT INTO sync_meta (key, value) VALUES ('gen', 0);

-- Sign-in attempts, to slow repeated guesses: per address typed and per network address. A try is
-- counted, in one statement, before its password is checked (passwords.ts reserveTry).
CREATE TABLE signin_failures (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  lastAt TEXT NOT NULL,
  lastMs INTEGER NOT NULL               -- the same moment in milliseconds, for the wait arithmetic
);

-- Browser message identities survive a lost POST response. An identity belongs
-- to one account and article; the original payload binds every replay to its words.
CREATE TABLE client_receipts (
  personId TEXT NOT NULL,
  path TEXT NOT NULL,
  clientId TEXT NOT NULL,
  kind TEXT NOT NULL,
  threadId INTEGER NOT NULL,
  commentId TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (personId, path, clientId)
);

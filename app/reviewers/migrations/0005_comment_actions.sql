-- Mutable projections never rewrite original messages or durable create receipts.
CREATE TABLE grant_generations (personId TEXT NOT NULL, path TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY(personId,path));
INSERT INTO grant_generations SELECT personId,path,1 FROM grants;
CREATE TRIGGER grant_generation_added AFTER INSERT ON grants BEGIN
 INSERT INTO grant_generations VALUES(NEW.personId,NEW.path,1)
 ON CONFLICT(personId,path) DO UPDATE SET epoch=epoch+1;
END;
CREATE TRIGGER grant_generation_removed AFTER DELETE ON grants BEGIN
 UPDATE grant_generations SET epoch=epoch+1 WHERE personId=OLD.personId AND path=OLD.path;
END;
CREATE TABLE comment_action_slots (threadId INTEGER NOT NULL, slot TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, PRIMARY KEY(threadId,slot));
CREATE TABLE comment_actions (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, actorKey TEXT NOT NULL, opId TEXT NOT NULL,
 requestHash TEXT NOT NULL, request TEXT NOT NULL, actor TEXT NOT NULL, target TEXT NOT NULL, threadId INTEGER NOT NULL, path TEXT NOT NULL,
 slot TEXT NOT NULL, resultRev INTEGER NOT NULL, state TEXT NOT NULL, created TEXT NOT NULL,
 gitDurable INTEGER NOT NULL DEFAULT 0, UNIQUE(actorKey,opId)
);
CREATE INDEX comment_actions_pending ON comment_actions(gitDurable,seq);

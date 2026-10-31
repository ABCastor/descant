-- A reader's chosen display colour. Messages retain the choice at their creation.
-- Existing accounts and messages stay neutral until a reader chooses a colour.
ALTER TABLE people ADD COLUMN color TEXT;
ALTER TABLE comments ADD COLUMN color TEXT;

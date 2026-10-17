-- Engine audit (E9): a level override set by expiry also stores the tier
-- index, so a client keeps the demoted level even if the owner renames the
-- tier id in a later rules version (core: LevelOverride.levelIndex).
ALTER TABLE clients ADD COLUMN level_override_index INTEGER;

-- Track who triggered each knowledge extraction job
ALTER TABLE knowledge_jobs ADD COLUMN triggered_by TEXT REFERENCES actors(id);

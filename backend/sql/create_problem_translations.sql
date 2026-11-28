-- Permanent cache table for on-demand translated problem starter code
CREATE TABLE IF NOT EXISTS public.problem_translations (
    mode TEXT NOT NULL,
    problem_id INTEGER NOT NULL,
    language TEXT NOT NULL,
    buggy_code TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (mode, problem_id, language)
);

CREATE INDEX IF NOT EXISTS idx_problem_translations_lookup
    ON public.problem_translations (mode, problem_id, language);

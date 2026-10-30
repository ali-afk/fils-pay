-- Additional suspense accounts for future reconciliation lanes.
-- Shape corrected (2026-10-30 implementation lane): 0007's chart_of_accounts is
-- (id, name, kind) with CHECK (kind IN ('asset','liability','revenue')); the
-- original column list and 'suspense' kind broke fresh applies. 'asset' follows
-- 0007:19's own suspense-account precedent.

INSERT INTO chart_of_accounts (id, name, kind) VALUES
    ('fx_rounding_difference', 'FX Rounding Difference', 'asset'),
    ('chargeback_suspense', 'Chargeback Suspense', 'asset')
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- Reimbursable is now fully derived: only company-card spend is NOT
-- reimbursable; everything else is. Backfill existing receipts to match.
-- ============================================================================
update receipts
set reimbursable = (payment_method <> 'company_card');

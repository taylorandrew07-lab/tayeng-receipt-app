-- ============================================================================
-- 0025_atomic_statement_reparse.sql
--
-- Replacing a statement's lines becomes ONE transaction.
--
-- THE DEFECT: app/api/statements/parse/route.ts replaced lines with separate
-- PostgREST calls -- DELETE every line, then INSERT the new ones. So:
--   * if the insert failed, the statement was left with NO lines at all;
--   * two re-parses of the same statement could interleave (both delete, both
--     insert) and leave every line duplicated -- and every charge with it;
--   * the confirmed-match guard was read in one request and acted on in
--     another, so the answer could be stale by the time it was used.
--
-- replace_statement_lines() does the guard, the header update, the delete and
-- the insert inside a single function call, which PostgREST runs as a single
-- transaction. Any failure rolls the WHOLE thing back and the existing lines
-- and every decision attached to them survive untouched.
--
-- SECURITY INVOKER: it runs with the caller's own rights, so RLS and the 0023
-- ownership triggers apply to every row it touches exactly as they would to a
-- direct write. It can do nothing the caller could not already do.
--
-- ADDITIVE: creates one function. No table or row is changed.
-- ============================================================================

create or replace function public.replace_statement_lines(
  p_statement_id     uuid,
  p_lines            jsonb,  -- [{txn_date, description, amount, currency, card_last4}, ...]
  p_header           jsonb,  -- only keys that were actually READ; missing = keep existing
  p_credits_excluded int
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_owner     uuid;
  v_confirmed int;
  v_count     int;
  v_total     numeric(14, 2);
begin
  -- The row lock. A second re-parse of the SAME statement blocks here until
  -- this one commits, so their deletes and inserts can never interleave.
  -- RLS hides other users' statements, so for them this finds nothing.
  select s.user_id into v_owner
  from statements s
  where s.id = p_statement_id
  for update;

  if v_owner is null then
    raise exception 'statement % not found', p_statement_id using errcode = 'P0002';
  end if;

  -- Header fields are written only when this parse actually read them. A
  -- weaker re-parse must never blank a period or unlink a card.
  update statements set
    period_start     = coalesce((p_header ->> 'period_start')::date,        period_start),
    period_end       = coalesce((p_header ->> 'period_end')::date,          period_end),
    card_id          = coalesce((p_header ->> 'card_id')::uuid,             card_id),
    previous_balance = coalesce((p_header ->> 'previous_balance')::numeric, previous_balance),
    total_purchases  = coalesce((p_header ->> 'total_purchases')::numeric,  total_purchases),
    total_payments   = coalesce((p_header ->> 'total_payments')::numeric,   total_payments),
    closing_balance  = coalesce((p_header ->> 'closing_balance')::numeric,  closing_balance)
  where id = p_statement_id;

  -- The guard, evaluated INSIDE the same transaction as the delete it guards.
  select count(*) into v_confirmed
  from receipt_statement_matches m
  join statement_transactions t on t.id = m.statement_transaction_id
  where t.statement_id = p_statement_id and m.confirmed;

  if v_confirmed > 0 then
    select count(*), coalesce(sum(amount), 0) into v_count, v_total
    from statement_transactions where statement_id = p_statement_id;
    update statements set parsed_line_total = v_total where id = p_statement_id;
    return jsonb_build_object(
      'replaced', false, 'count', v_count, 'line_total', v_total, 'confirmed', v_confirmed);
  end if;

  delete from statement_transactions where statement_id = p_statement_id;

  -- WITH ORDINALITY keeps the statement's own line order, so charge
  -- assignment (0015's trigger) runs in a deterministic order every time.
  insert into statement_transactions
    (statement_id, user_id, txn_date, description, amount, currency, card_last4)
  select
    p_statement_id,
    v_owner,
    nullif(x.e ->> 'txn_date', '')::date,
    x.e ->> 'description',
    (x.e ->> 'amount')::numeric,
    upper(coalesce(nullif(btrim(x.e ->> 'currency'), ''), 'TTD')),
    nullif(x.e ->> 'card_last4', '')
  from jsonb_array_elements(p_lines) with ordinality as x(e, n)
  order by x.n;

  select count(*), coalesce(sum(amount), 0) into v_count, v_total
  from statement_transactions where statement_id = p_statement_id;

  update statements
  set parsed_line_total = v_total,
      credits_excluded  = coalesce(p_credits_excluded, 0)
  where id = p_statement_id;

  return jsonb_build_object('replaced', true, 'count', v_count, 'line_total', v_total);
end $$;

revoke execute on function public.replace_statement_lines(uuid, jsonb, jsonb, int) from public, anon;
grant  execute on function public.replace_statement_lines(uuid, jsonb, jsonb, int) to authenticated, service_role;

comment on function public.replace_statement_lines(uuid, jsonb, jsonb, int) is
  'Atomically replaces a statement''s lines (guard + header + delete + insert in one transaction, row-locked against concurrent re-parse). Keeps existing lines if any have a confirmed receipt. SECURITY INVOKER: RLS applies.';

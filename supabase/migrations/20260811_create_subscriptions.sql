create table if not exists public.subscriptions (
  stripe_subscription_id text primary key,
  user_id uuid references auth.users(id) on delete set null,
  stripe_customer_id text not null,
  status text not null check (status in ('pending', 'active', 'trialing', 'past_due', 'unpaid', 'canceled')),
  price_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_subscriptions_user_id
  on public.subscriptions(user_id);
create index if not exists idx_subscriptions_customer_id
  on public.subscriptions(stripe_customer_id);

alter table public.subscriptions enable row level security;

drop policy if exists "Users can view own subscriptions" on public.subscriptions;
create policy "Users can view own subscriptions"
  on public.subscriptions for select
  using (auth.uid() = user_id);

create table if not exists public.stripe_webhook_events (
  event_id text primary key,
  event_type text not null,
  payload jsonb not null,
  claimed_at timestamptz not null default now()
);

alter table public.stripe_webhook_events enable row level security;

create table if not exists public.stripe_subscription_sync_leases (
  lease_key text primary key,
  lease_token uuid not null,
  expires_at timestamptz not null
);

alter table public.stripe_subscription_sync_leases enable row level security;

create or replace function public.apply_stripe_subscription_event(
  p_event_id text,
  p_event_type text,
  p_payload jsonb,
  p_stripe_subscription_id text,
  p_user_id uuid,
  p_stripe_customer_id text,
  p_status text,
  p_price_id text,
  p_current_period_start timestamptz,
  p_current_period_end timestamptz,
  p_cancel_at_period_end boolean,
  p_metadata jsonb,
  p_lease_key text,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.stripe_subscription_sync_leases
    where lease_key = p_lease_key
      and lease_token = p_lease_token
      and expires_at > now()
  ) then
    raise exception 'subscription sync lease is not held';
  end if;

  insert into public.stripe_webhook_events(event_id, event_type, payload)
  values (p_event_id, p_event_type, p_payload)
  on conflict (event_id) do nothing;

  if not found then
    return false;
  end if;

  insert into public.subscriptions(
    stripe_subscription_id,
    user_id,
    stripe_customer_id,
    status,
    price_id,
    current_period_start,
    current_period_end,
    cancel_at_period_end,
    metadata
  ) values (
    p_stripe_subscription_id,
    p_user_id,
    p_stripe_customer_id,
    p_status,
    p_price_id,
    p_current_period_start,
    p_current_period_end,
    p_cancel_at_period_end,
    coalesce(p_metadata, '{}'::jsonb)
  )
  on conflict (stripe_subscription_id) do update set
    user_id = coalesce(excluded.user_id, public.subscriptions.user_id),
    stripe_customer_id = excluded.stripe_customer_id,
    -- Checkout completion identifies the subscription but is not an
    -- authoritative lifecycle snapshot. Stripe may deliver it after a
    -- customer.subscription.* event, so it must not downgrade an active row
    -- to pending or erase its period/price fields.
    status = case
      when p_event_type = 'checkout.session.completed'
        then public.subscriptions.status
      else excluded.status
    end,
    price_id = case
      when p_event_type = 'checkout.session.completed'
        then public.subscriptions.price_id
      else excluded.price_id
    end,
    current_period_start = case
      when p_event_type = 'checkout.session.completed'
        then public.subscriptions.current_period_start
      else excluded.current_period_start
    end,
    current_period_end = case
      when p_event_type = 'checkout.session.completed'
        then public.subscriptions.current_period_end
      else excluded.current_period_end
    end,
    cancel_at_period_end = case
      when p_event_type = 'checkout.session.completed'
        then public.subscriptions.cancel_at_period_end
      else excluded.cancel_at_period_end
    end,
    metadata = case
      when p_event_type = 'checkout.session.completed'
        then public.subscriptions.metadata
      else excluded.metadata
    end,
    updated_at = now();

  return true;
end;
$$;

create or replace function public.claim_stripe_event(
  p_event_id text,
  p_event_type text,
  p_payload jsonb
)
returns boolean
language sql
security definer
set search_path = public
as $$
  insert into public.stripe_webhook_events(event_id, event_type, payload)
  values (p_event_id, p_event_type, p_payload)
  on conflict (event_id) do nothing
  returning true;
$$;

create or replace function public.acquire_stripe_sync_lease(
  p_lease_key text,
  p_lease_token uuid,
  p_ttl_seconds integer
)
returns boolean
language sql
security definer
set search_path = public
as $$
  insert into public.stripe_subscription_sync_leases(lease_key, lease_token, expires_at)
  values (p_lease_key, p_lease_token, now() + make_interval(secs => p_ttl_seconds))
  on conflict (lease_key) do update set
    lease_token = excluded.lease_token,
    expires_at = excluded.expires_at
  where public.stripe_subscription_sync_leases.expires_at <= now()
  returning true;
$$;

create or replace function public.release_stripe_sync_lease(
  p_lease_key text,
  p_lease_token uuid
)
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.stripe_subscription_sync_leases
  where lease_key = p_lease_key and lease_token = p_lease_token;
$$;

revoke all on function public.apply_stripe_subscription_event(
  text, text, jsonb, text, uuid, text, text, text, timestamptz,
  timestamptz, boolean, jsonb, text, uuid
) from public, anon, authenticated;
grant execute on function public.apply_stripe_subscription_event(
  text, text, jsonb, text, uuid, text, text, text, timestamptz,
  timestamptz, boolean, jsonb, text, uuid
) to service_role;

revoke all on function public.claim_stripe_event(text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.claim_stripe_event(text, text, jsonb)
  to service_role;

revoke all on function public.acquire_stripe_sync_lease(text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.acquire_stripe_sync_lease(text, uuid, integer)
  to service_role;

revoke all on function public.release_stripe_sync_lease(text, uuid)
  from public, anon, authenticated;
grant execute on function public.release_stripe_sync_lease(text, uuid)
  to service_role;

# Email Alerts Setup — Supabase + Resend + GitHub Actions

This guide walks you through enabling **automatic email alerts** for tech control expiry. Once finished, customers get 30 / 7 / 1-day reminders, and garage owners get a weekly summary.

> ⏱ **Total setup time:** ~30 min. **Cost:** $0/month at student/small-shop scale.

---

## What you'll be doing

1. **Supabase** — host the database in the cloud (replaces localStorage).
2. **Resend** — actually sends the emails.
3. **GitHub Actions** — the daily cron that triggers the email check.

```
┌──────────┐  cron daily  ┌──────────────┐  query    ┌──────────┐
│ GitHub   │ ────────────►│ Supabase     │◄──────────│ AutoTrack│
│ Actions  │              │ Edge Function│           │ frontend │
└──────────┘              └──────────────┘           └──────────┘
                                  │
                                  │ POST emails
                                  ▼
                          ┌──────────────┐
                          │   Resend     │ → customer/garage inboxes
                          └──────────────┘
```

---

## Step 1 — Create a Supabase project (5 min)

1. Go to **https://supabase.com** → click **Start your project** → sign in with GitHub.
2. Click **New project**:
   - **Name:** `autotrack`
   - **Database password:** generate one and save it safely
   - **Region:** pick the closest to Rwanda (Frankfurt or Mumbai)
3. Wait ~2 min for it to provision.
4. Once ready, go to **Project Settings → API** and copy:
   - `Project URL` (something like `https://abcd1234.supabase.co`)
   - `anon public` key

Save these — you'll paste them into the app later.

---

## Step 2 — Create database tables

In your Supabase dashboard, go to **SQL Editor** → **New query** → paste this whole block:

```sql
-- Stores (garages)
create table public.stores (
  id uuid primary key default gen_random_uuid(),
  store_name text not null,
  owner_name text not null,
  email text unique not null,
  phone text,
  password_hash text not null,
  created_at timestamptz default now()
);

-- Customers (car owners)
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  email text unique not null,
  phone text,
  password_hash text not null,
  notify_by_email boolean default true,
  created_at timestamptz default now()
);

-- Cars
create table public.cars (
  id uuid primary key default gen_random_uuid(),
  garage_id uuid references public.stores(id) on delete cascade,
  brand text not null,
  model text not null,
  year int,
  color text,
  plate text not null,
  vin text,
  owner_email text,
  owner_name text,
  owner_phone text,
  last_mileage int default 0,
  inspection_expiry_date date,
  created_at timestamptz default now()
);
create index idx_cars_owner_email on public.cars(lower(owner_email));
create index idx_cars_inspection on public.cars(inspection_expiry_date);

-- Repairs
create table public.repairs (
  id uuid primary key default gen_random_uuid(),
  car_id uuid references public.cars(id) on delete cascade,
  garage_id uuid references public.stores(id),
  date date not null,
  mileage int,
  status text default 'In Progress',
  title text not null,
  technician text,
  total_cost numeric(10,2) default 0,
  notes text,
  created_at timestamptz default now()
);

-- Repair line items
create table public.repair_items (
  id uuid primary key default gen_random_uuid(),
  repair_id uuid references public.repairs(id) on delete cascade,
  type text check (type in ('Part', 'Labor')),
  description text,
  qty numeric(10,2) default 1,
  unit_cost numeric(10,2) default 0
);

-- Track which alerts have already been sent (so we don't double-send)
create table public.sent_alerts (
  id uuid primary key default gen_random_uuid(),
  car_id uuid references public.cars(id) on delete cascade,
  alert_type text,            -- '30d', '7d', '1d', 'expired'
  sent_at timestamptz default now(),
  unique (car_id, alert_type)
);
```

Click **Run**. You should see "Success" — your tables are ready.

---

## Step 3 — Create a Resend account (3 min)

1. Go to **https://resend.com** → sign up (no card).
2. Verify your email.
3. Go to **API Keys** → **Create API Key** → copy it (looks like `re_AbcD1234...`).
4. **For testing:** use sender `onboarding@resend.dev` — works immediately, no domain needed.
5. **For production:** add a domain you own (`autotrack.rw`?), Resend will guide DNS setup.

Save the API key.

---

## Step 4 — Create the Edge Function

In Supabase dashboard → **Edge Functions** → **Deploy a new function**.

Name it: `send-inspection-alerts`

Paste this code:

```typescript
// supabase/functions/send-inspection-alerts/index.ts
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const FROM_EMAIL     = Deno.env.get("FROM_EMAIL") ?? "onboarding@resend.dev";

const ALERT_WINDOWS = [
  { days: 30, type: "30d", subject: (car) => `Your ${car.brand} ${car.model} inspection is due in 30 days` },
  { days: 7,  type: "7d",  subject: (car) => `⚠️ Your ${car.brand} ${car.model} inspection is due in 7 days` },
  { days: 1,  type: "1d",  subject: (car) => `🚨 Tomorrow: ${car.brand} ${car.model} inspection due` },
];

serve(async () => {
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const today = new Date(); today.setHours(0,0,0,0);
  let totalSent = 0;

  for (const win of ALERT_WINDOWS) {
    const target = new Date(today.getTime() + win.days * 86400000);
    const dateStr = target.toISOString().slice(0, 10);

    const { data: cars } = await supa
      .from("cars")
      .select("*")
      .eq("inspection_expiry_date", dateStr);

    for (const car of cars ?? []) {
      // Skip if already sent for this window
      const { data: already } = await supa
        .from("sent_alerts")
        .select("id")
        .eq("car_id", car.id)
        .eq("alert_type", win.type)
        .maybeSingle();
      if (already) continue;

      // Send email
      const html = `
        <div style="font-family:sans-serif;max-width:560px;">
          <h2>Your ${car.brand} ${car.model} (${car.plate}) — Inspection due in ${win.days} day${win.days>1?'s':''}</h2>
          <p>Hi ${car.owner_name || 'there'},</p>
          <p>A friendly reminder from <strong>AutoTrack</strong>:</p>
          <ul>
            <li>🚓 Vehicle: ${car.brand} ${car.model} (${car.plate})</li>
            <li>📅 Inspection due: ${dateStr}</li>
            <li>📍 Where: Rwanda National Police inspection centre</li>
          </ul>
          <p>Driving without a valid sticker is illegal in Rwanda — please book your test before the date.</p>
          <hr/>
          <p style="color:#888;font-size:12px;">
            You're receiving this because you signed up at AutoTrack.
          </p>
        </div>`;

      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${RESEND_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: car.owner_email,
          subject: win.subject(car),
          html
        })
      });
      if (resp.ok) {
        await supa.from("sent_alerts").insert({ car_id: car.id, alert_type: win.type });
        totalSent++;
      }
    }
  }

  return new Response(JSON.stringify({ sent: totalSent }), {
    headers: { "Content-Type": "application/json" }
  });
});
```

Then in **Settings → Edge Functions → Secrets**, add:
- `RESEND_API_KEY` = (your Resend key)
- `FROM_EMAIL` = `onboarding@resend.dev` (or your verified domain)

Deploy. Note the function URL — looks like `https://abcd1234.supabase.co/functions/v1/send-inspection-alerts`.

---

## Step 5 — Test it manually

Set one demo car's `inspection_expiry_date` to tomorrow's date, then in your terminal:

```bash
curl -X POST "https://YOUR_PROJECT.supabase.co/functions/v1/send-inspection-alerts" \
  -H "Authorization: Bearer YOUR_ANON_KEY"
```

Check your inbox — you should get the alert email within a minute.

---

## Step 6 — GitHub Actions cron (5 min)

In your GitHub repo, create the file `.github/workflows/inspection-alerts.yml`:

```yaml
name: Send inspection alerts

on:
  schedule:
    - cron: "0 6 * * *"   # 6 AM UTC = 8 AM Kigali
  workflow_dispatch:       # also lets you trigger manually

jobs:
  send:
    runs-on: ubuntu-latest
    steps:
      - name: Trigger edge function
        run: |
          curl -X POST "${{ secrets.EDGE_FUNCTION_URL }}" \
            -H "Authorization: Bearer ${{ secrets.SUPABASE_ANON_KEY }}" \
            --fail
```

In your repo → **Settings → Secrets → Actions**, add:
- `EDGE_FUNCTION_URL` = your function URL
- `SUPABASE_ANON_KEY` = your anon key

That's it — every day at 8 AM Kigali time, GitHub fires the function, which sends emails to anyone whose inspection is 30/7/1 days away.

---

## Step 7 — Garage weekly summaries (optional)

Add a second Edge Function `weekly-garage-summary` (similar pattern, runs Mondays):

```sql
-- This query lives inside the function
select s.email, s.store_name, count(*) as due_count
from cars c
join stores s on s.id = c.garage_id
where c.inspection_expiry_date between now() and now() + interval '7 days'
group by s.id, s.email, s.store_name;
```

Then send each garage owner one email listing the count + plate numbers.

Add a second cron in the same workflow:
```yaml
- cron: "0 6 * * 1"   # Mondays 8 AM Kigali
```

---

## Step 8 — Wire the frontend to Supabase

This is the bigger code change — replace the localStorage layer in `js/auth.js` with `@supabase/supabase-js` calls. I'll do this once you've confirmed Steps 1–7 work. Send me your Supabase URL + anon key (the anon key is **public** — fine to share) and I'll do the swap.

---

## What you need to give me when ready

- ✅ Confirmation the SQL ran successfully
- ✅ Supabase project URL
- ✅ Supabase anon key
- ✅ Confirmation the test email arrived
- ✅ GitHub repo URL (so I can add the Action)

Then I'll migrate the frontend code from localStorage → Supabase, and the email alerts go live.

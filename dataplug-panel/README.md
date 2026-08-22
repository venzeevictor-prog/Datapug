# DataPlug

Cheap MTN, Glo, Airtel, and 9mobile data plans — wallet-based, VTPass-backed, with a built-in referral program.

## Before you deploy

You need four things ready:

1. **A Postgres database** (Render, Supabase, Neon, or similar all work — this app uses plain `pg`, nothing provider-specific).
2. **A Paystack account** — live secret key + public key, and "Confirm transfers before sending" is only relevant if you later add transfer-based features; not needed for this app as shipped.
3. **A VTPass account** with all three credentials: `api-key`, `secret-key`, `public-key`. Get these from your VTPass dashboard.
4. **A domain** (or your Render/Railway/etc. subdomain) to put in `APP_URL` and `PAYSTACK_CALLBACK_URL`.

**Test on VTPass's sandbox first if at all possible.** Base URL `https://sandbox.vtpass.com/api` instead of `https://vtpass.com/api` — same code, fake money, real test of the actual purchase flow. Given you can't debug locally, this is the cheapest way to catch a config mistake before it touches a real customer's wallet.

## Deploying (Render, or similar — no local machine needed)

1. Push this repo to GitHub.
2. Create a new **Web Service** on Render (or your host of choice), connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add a **Postgres** instance (Render has a one-click add-on), copy its connection string into `DATABASE_URL`.
5. Set every environment variable from `.env.example` in the host's dashboard — **do not commit a real `.env` file**, `.gitignore` already excludes it.
6. **Before the app can serve any real traffic**, run the migration once. Render's dashboard has a "Shell" tab for the web service — run:
   ```
   npm run migrate
   ```
   This creates all tables and, if `VTPASS_API_KEY`/`VTPASS_SECRET_KEY`/`VTPASS_PUBLIC_KEY` are already set in your env vars, seeds the VTPass provider row automatically. If you'd rather add VTPass through the admin UI instead, leave those three blank and do it in step 8.
7. Promote your own account to admin, also from the Shell tab, after you've signed up once on the live site:
   ```
   npm run promote your_username
   ```
   Log out and back in on the site afterward — your login token has the old role baked into it.
8. Log into `/admin.html` → **Data Plans** tab → pick your provider (or add it under **Providers** first if you skipped the env-var seed) → **Sync from VTPass**. This pulls the real catalog across all four networks.
9. **Only weekly plans are visible to customers by default** — monthly and 2-3 month plans sync in but stay hidden (`is_active = false`) until you flip them on from the Data Plans tab. This was intentional per the original scope; check there when you're ready to expand.

## The 5-minute smoke test (do this before telling anyone the site is live)

Since there's no way to debug this after the fact without a laptop, run through this once, for real, with a small amount of real money:

1. Sign up a fresh test account.
2. Fund it with the minimum, ₦1,000.
3. Confirm the wallet balance actually updates (check `/dashboard.html` → Overview, and `/admin.html` → Users → your test user, to see it from both sides).
4. Buy one real weekly plan on a phone number you control. Confirm the data actually lands.
5. Check **Order history** shows it as `completed` (or briefly `pending` before flipping to `completed` — that's the requery flow working correctly, not a bug).
6. Sign up a *second* test account using the first account's referral link (`/admin.html` → Referrals will show it, or check the first account's Referrals page for the link).
7. Fund the second account with ₦1,000+. Confirm the *first* account's wallet goes up by ₦3,500 within a few seconds.

If all seven steps pass, the money-handling core is verified working end to end. If any step doesn't behave as described, stop and get help before opening it to real customers — better to catch it on ₦1,000 of your own test money than a stranger's.

## Support

Everything from here is the same architecture as documented inline throughout the code — every non-obvious decision has a comment explaining *why*, not just what. Start with `server.js` to see how everything's wired together, then `routes/dataPlans.js` and `services/provider.js` for the core purchase flow.

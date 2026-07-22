# First editor bootstrap

After `supabase db push`, `public.editors` is empty. RLS is working correctly at
that point, which means **every signed-in user sees zero rows**. Someone has to
be added out of band. This is that procedure.

Run it after `docs/cloud-migration-runbook.md`.

## Why there is no self-service path

There is deliberately no policy allowing a user to insert themselves into
`editors`, and there never should be. Anyone can sign up with the publishable
key that ships in the browser bundle; a self-insert policy would turn "signed
up" into "authorised" and make the allowlist decorative.

`editors` has a SELECT policy and no INSERT, UPDATE or DELETE policy, and
`authenticated` holds no write grant on it. The only ways in are the SQL editor
(which runs as `postgres`) or an Edge Function using the service role key.

**The service role key must never reach the frontend** — not in `frontend/`, not
in a `VITE_` variable, not in Netlify build env. It bypasses RLS entirely. The
browser only ever gets the project URL and the publishable key.

---

## 1. Create the first Auth user

Dashboard → **Authentication** → **Users** → **Add user**.

Either *Create new user* (email + password, fine for the first admin) or *Send
invitation* (magic link, matching how editors will sign in later). Use a real
address you control.

This creates a row in `auth.users` only. It grants nothing — `is_editor()` is
still false for them.

## 2. Get the user's UUID

Copy it from the user row in that same screen, or read it back:

```sql
select id, email, created_at, last_sign_in_at
from auth.users
order by created_at desc;
```

## 3. Add them to the allowlist

Dashboard → SQL Editor. Substitute the real UUID and email:

```sql
insert into public.editors (user_id, email, full_name, role)
values (
  '00000000-0000-0000-0000-000000000000',  -- the UUID from step 2
  'you@example.com',
  'Your Name',
  'admin'
);
```

Keyed to `auth.users(id)` with `on delete cascade`, so deleting the Auth user
removes the allowlist entry too. A wrong UUID fails the foreign key rather than
silently creating a dead row.

Confirm:

```sql
select e.user_id, e.email, e.role, u.email as auth_email
from public.editors e join auth.users u on u.id = e.user_id;
```

`email` and `auth_email` should match. The `editors.email` column is a
convenience copy for display — `user_id` is what authorises.

## 4. Verify the admin sees data

Do this as the **user**, not in the SQL editor. The SQL editor connects as
`postgres` and bypasses RLS, so it proves nothing about authorisation.

Get an access token (PowerShell, from your own terminal):

```powershell
$URL  = "https://bxaovkzemfyxrxbcqask.supabase.co"
$KEY  = "sb_publishable_llipKsKWVIAK3pzFIgsCDA_5N2z7--g"   # publishable, safe

$body = @{ email = "you@example.com"; password = "<the password>" } | ConvertTo-Json
$tok  = (Invoke-RestMethod "$URL/auth/v1/token?grant_type=password" `
          -Method Post -Headers @{ apikey = $KEY; "Content-Type" = "application/json" } `
          -Body $body).access_token

# Should return rows
Invoke-RestMethod "$URL/rest/v1/raw_posts?select=id&limit=5" `
  -Headers @{ apikey = $KEY; Authorization = "Bearer $tok" }
```

Expected: five rows. Also check `editorial_assets`, `configurations` and
`sources` return data.

If you used a magic-link invite instead of a password, sign in through the app
once it exists (Phase 6) and read the token from the browser session rather than
the password grant above.

## 5. Verify a non-allowlisted user sees nothing

This is the check that actually proves RLS. Create a second Auth user in the
dashboard and **do not** add them to `editors`. Then repeat step 4 with their
credentials:

```powershell
$body2 = @{ email = "outsider@example.com"; password = "<their password>" } | ConvertTo-Json
$tok2  = (Invoke-RestMethod "$URL/auth/v1/token?grant_type=password" `
           -Method Post -Headers @{ apikey = $KEY; "Content-Type" = "application/json" } `
           -Body $body2).access_token

Invoke-RestMethod "$URL/rest/v1/raw_posts?select=id&limit=5" `
  -Headers @{ apikey = $KEY; Authorization = "Bearer $tok2" }
```

Expected: `[]` — an empty array, HTTP 200. Not an error. RLS filters rows; it
does not reject the request. An empty array here is the system working.

Also confirm they cannot write:

```powershell
Invoke-RestMethod "$URL/rest/v1/sources" -Method Post `
  -Headers @{ apikey = $KEY; Authorization = "Bearer $tok2"; "Content-Type" = "application/json" } `
  -Body '{"name":"nope","source_type":"linkedin","url":"https://x"}'
```

Expected: HTTP 401/403, `new row violates row-level security policy`.

Delete the outsider test user afterwards — Dashboard → Authentication → Users.

## 6. Verify anon sees nothing

The strongest check, using no token at all — the publishable key alone, exactly
what a stranger with your bundle has:

```powershell
Invoke-RestMethod "$URL/rest/v1/raw_posts?select=id&limit=5" -Headers @{ apikey = $KEY }
```

Expected: HTTP 401 `permission denied for table raw_posts`. `anon` has no
grants at all, so this fails before RLS is even consulted.

---

## Adding further editors later

Same as step 1–3: create the Auth user, then insert into `public.editors`. Until
the Phase 6 admin screen exists, this stays a deliberate SQL-editor action by an
administrator.

`role` is `'editor'` or `'admin'`. Nothing enforces a difference between them
yet — the RLS policies check only membership. Wire the distinction up when an
admin-only capability actually exists, rather than implying one now.

## Removing an editor

```sql
delete from public.editors where email = 'former@example.com';
```

Access stops immediately on their next request; `is_editor()` is evaluated per
statement. Their `auth.users` row survives, so they can still sign in — they
just see nothing. To revoke sign-in entirely, delete the user in the dashboard,
which cascades to `editors`.

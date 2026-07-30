# Phase 4 — DNS: Railway custom domain + Cloudflare CNAME

**This entire phase is browser work.** Nothing here is for Claude Code.

**Outcome:** `https://flooringpartners.portfolioapps.ai` resolves to the Railway `web` service with
a valid TLS certificate.

**Order matters: Railway first, then Cloudflare.** Railway has to know the hostname before it can
tell you the CNAME target, and before it can request a certificate.

---

## Step 1 — Add the custom domain in Railway

1. Railway → project **`flooring-partners`** → service **`web`**
2. **Settings** → **Networking** → **Custom Domain** → **+ Custom Domain**
3. Enter exactly: `flooringpartners.portfolioapps.ai`
4. Click **Add**

Railway responds with a CNAME target that looks like `abc123xyz.up.railway.app`.

> **Copy that value exactly, character for character.** Do **not** assume it's the same as the
> generated domain from Phase 3 Step 8 — the custom-domain target is often a different hostname.
> This is the single most common mistake in this phase.

The domain's status will read **Pending DNS** (or show a warning triangle) until the CNAME resolves.
That's expected.

---

## Step 2 — Add the CNAME in Cloudflare

1. Cloudflare dashboard → select the **`portfolioapps.ai`** zone
2. Left sidebar → **DNS** → **Records** → **+ Add record**
3. Fill in:

| Field | Value |
|---|---|
| **Type** | `CNAME` |
| **Name** | `flooringpartners` |
| **Target** | the value Railway gave you in Step 1 |
| **Proxy status** | **DNS only** — click the toggle so the cloud icon is **GRAY**, not orange |
| **TTL** | `Auto` |

4. **Save**

The **Name** field takes just the subdomain label. Cloudflare will display the full record as
`flooringpartners.portfolioapps.ai`. Don't type the full hostname — some UIs will double it into
`flooringpartners.portfolioapps.ai.portfolioapps.ai`.

### Why proxy must be OFF (gray cloud)

Railway issues and terminates its own TLS certificate at the Railway edge. With Cloudflare's proxy
on (orange cloud), Cloudflare terminates TLS instead and Railway's ACME challenge can't complete —
so the certificate never issues and you get a persistent `525` or `526` error.

Making the orange cloud work requires setting Cloudflare SSL/TLS mode to **Full (strict)** and
accepting some websocket quirks. Gray cloud is the setup that works, and it's what
`kleen-tech.portfolioapps.ai` runs on. Match it.

> Sanity check against the existing deployment: look at the `kleen-tech` record in the same zone.
> It should be a gray-cloud CNAME. If yours looks different, you've made a different choice — go
> back and match.

---

## Step 3 — Verify propagation

From a terminal:

```bash
dig flooringpartners.portfolioapps.ai CNAME +short
# Expected: the Railway target you entered, e.g. abc123xyz.up.railway.app.
```

If that returns nothing, wait 60 seconds and retry. Cloudflare is usually near-instant, but give
it up to 5 minutes.

Once the CNAME resolves, return to Railway → `web` → **Settings** → **Networking**. The custom
domain status should flip from **Pending DNS** to **Active**. Certificate issuance is typically
under a minute after that.

```bash
curl -sI https://flooringpartners.portfolioapps.ai | head -5
# Expected: HTTP/2 200, or a 301/302 to / — either is fine.
```

If `curl` reports a certificate error, Railway hasn't finished issuing yet. Wait and retry — don't
start changing settings.

---

## Step 4 — Confirm Django accepts the hostname

Nothing to change if Phase 3 Step 6 was done correctly, but verify:

- `DJANGO_ALLOWED_HOSTS` contains `flooringpartners.portfolioapps.ai`
- `DJANGO_CSRF_TRUSTED_ORIGINS` contains `https://flooringpartners.portfolioapps.ai`

If either is missing, add it in Railway → `web` → **Variables** and redeploy.

**Symptoms of getting this wrong:**
- Missing from `ALLOWED_HOSTS` → `DisallowedHost` error / HTTP 400 on every request
- Missing from `CSRF_TRUSTED_ORIGINS` → the page loads, but submitting the login form returns
  **403 Forbidden (CSRF verification failed)**

---

## Step 5 — Load the real URL

1. Open `https://flooringpartners.portfolioapps.ai`
2. Padlock icon → certificate should be valid, issued for that hostname
3. Log in with the superuser credentials from Phase 3
4. You should reach `/apps/` with the **Org View — Coming Soon** card

---

## Step 6 — Confirm the existing deployments are untouched

The whole point of the isolation architecture. Verify it:

- [ ] `https://portfolioapps.ai` still loads and you can still log in with your existing credentials
- [ ] `https://kleen-tech.portfolioapps.ai` still loads and you can still log in

If either broke, the most likely cause is an accidental edit to a shared Cloudflare record (a
changed root `A`/`CNAME`, or a wildcard record). Check the zone's DNS record list against what you
remember, and use Cloudflare's **Change history** if needed.

---

## Step 7 — Retire the temporary domain (optional)

Once the custom domain works, the Phase 3 generated `*.up.railway.app` domain is redundant. You
can remove it (`web` → Settings → Networking → the generated domain → remove), or keep it as a
back door for when you're debugging a DNS problem. Keeping it costs nothing.

---

## Done check

- [ ] `dig flooringpartners.portfolioapps.ai CNAME +short` returns the Railway target
- [ ] Cloudflare record is a **CNAME**, proxy status **DNS only** (gray cloud)
- [ ] Railway custom domain status is **Active**
- [ ] `https://flooringpartners.portfolioapps.ai` serves the login page with a valid cert
- [ ] Login succeeds and reaches the hub — no `DisallowedHost`, no CSRF 403
- [ ] `portfolioapps.ai` and `kleen-tech.portfolioapps.ai` both still work

Next: `05-auth-bootstrap-and-smoke-test.md`.

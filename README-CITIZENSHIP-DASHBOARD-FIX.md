# Citizenship dashboard payment finalisation fix

This patch fixes the paid citizenship exam not appearing on `account-dashboard.html` after Stripe redirects back with `paid=1&session_id=...`.

## What changed

- `POST /create-checkout-session` remains supported for legacy paid citizenship pages.
- `POST /api/citizenship/create-checkout-session` remains supported for the production route.
- Citizenship checkout now returns to:
  `/account-dashboard.html?paid=1&service=citizenship&session_id={CHECKOUT_SESSION_ID}`
- Added no-auth finalisation endpoints that verify the Stripe session, attach the paid citizenship access, and restore the `bm_session` cookie:
  - `GET /api/citizenship/verify-payment?session_id=...`
  - `POST /api/citizenship/verify-payment`
  - `GET /api/citizenship/finalise?session_id=...`
  - `POST /api/citizenship/finalise`
  - `GET /api/assessment/verify-payment?session_id=...` also supports citizenship sessions now.
- Added dashboard-friendly citizenship access endpoints:
  - `GET /api/citizenship/access`
  - `GET /api/citizenship/status`
- `/api/account/dashboard` already returns:
  - `counts.citizenship`
  - `citizenshipAccess`
  - `citizenship`

## Important frontend requirement

When `account-dashboard.html` sees a URL with `session_id`, it should call one of these before rendering the citizenship card:

```js
await fetch(`${BACKEND_URL}/api/citizenship/finalise?session_id=${encodeURIComponent(sessionId)}`, {
  credentials: 'include'
});
```

Then reload dashboard data from:

```js
GET /api/account/dashboard
```

If the dashboard does not call a finalise endpoint, the backend cannot know the browser returned from Stripe.

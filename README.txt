Updated server.js for Bircan Migration backend.

Key fix:
- Stripe success_url no longer includes session_id
- This avoids ModSecurity blocking success page redirects on your website

Included:
- server.js

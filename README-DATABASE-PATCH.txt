Bircan Migration PostgreSQL production patch

Files included:
- server.js
- package.json

What changed:
1. Added pg dependency.
2. Added PostgreSQL connection using DATABASE_URL.
3. Added database schema creation for users, services and payments.
4. Dashboard now reads database services first, with JSON fallback.
5. Stripe finalisation writes paid visa assessments and citizenship purchases into PostgreSQL.
6. Citizenship attempts update database attempt counters.
7. Future appeal assessments are supported by the shared services table.

Render setup:
1. Backend service > Environment:
   DATABASE_URL = your Render Internal Database URL
2. Keep STRIPE_MODE and Stripe price variables as already configured.
3. Deploy.
4. Check: /api/database/health

If /api/database/health returns ok:true, the database is connected.

Security note:
The database URL was shared in chat. After deployment works, rotate the Render database credential and update DATABASE_URL.

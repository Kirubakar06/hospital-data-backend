# CarePoint backend

This folder contains the Express API and MySQL setup for the React/Vite app in the sibling `hospital management sample` folder. It replaces the frontend's former browser-storage demo adapter with authenticated API requests.

## Requirements and setup

- Node.js 20+ (Node.js 20 LTS or 22 LTS recommended)
- MySQL 8+

1. Copy `.env.example` to `.env`. Set different random secrets for `JWT_SECRET` and `JWT_REFRESH_SECRET` (at least 32 characters each), and enter your local MySQL administrator password in `DB_SETUP_PASSWORD`.
2. Run `npm install` in this folder and in the frontend's `hospital management sample` folder to install their dependencies.
3. From the project root run `npm run db:setup`. It installs the schema and creates `DB_USER` with the limited runtime grants.
4. Run `npm run seed:admin` and `npm run seed:demo` to create the initial admin and synthetic records.
5. From the frontend's `hospital management sample` folder, run `npm run dev` to start the API and frontend together. The API listens on `http://localhost:5000`, checks MySQL before listening, and Vite runs on `http://localhost:5173`, proxying `/api` requests to the API. Override the proxy target with `VITE_BACKEND_URL` if needed.
6. For a single-origin production run, build from the frontend folder with `npm run build`, then run `npm start` from that folder; Express serves the frontend build and API together on port 5000. Set `FRONTEND_DIST_DIR` if the frontend build is in a different location.

Run only one API instance per port. If the CarePoint API is already running on port 5000, starting the backend again reports that it is already running and exits cleanly. Stop the existing app process before restarting it.

The browser stores only the short-lived access token in memory. Refresh tokens are rotated and stored in an HttpOnly, SameSite cookie. Sign out and account changes revoke refresh sessions.

## Implemented API

All API routes are under `/api/v1`.

- `POST /auth/setup`, `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`, `GET /auth/me`, `POST /auth/change-password`
- `GET|POST /patients`, `GET|PUT|DELETE /patients/:id`, `GET /patients/search?q=...`
- The same list/create/read/update/archive pattern for doctors, departments, appointments, rooms, admissions, medical records, prescriptions, laboratory, billing, payments, staff, reports, and settings
- `GET /users`, `POST /users`, `GET|PUT|DELETE /users/:id`, `PATCH /users/:id/status`; role and permission reads
- Dashboard overview/statistics/recent-activity and patient, appointment, revenue, and payment reports
- `GET /auditLogs`; authenticated PDF/JPEG/PNG upload and retrieval routes

List routes return `{ success, message, data: { records, total, limit, offset } }`. Writes return the affected record. Errors use a consistent JSON envelope and do not expose SQL or stack traces.

RBAC is enforced in API middleware using the role matrix in `shared/permissions.js`. The frontend maintains its own shared role matrix; keep both matrices aligned when introducing new roles or permissions. The API remains authoritative.

Self-registration accepts any valid email, but creates an inactive Receptionist account. A Super Admin/Admin must activate it from Users before it can sign in; the login does not ignore or bypass email/account identity. Email ownership is not verified because no mail provider is configured.

## Persistence and limitations

Authentication, roles, refresh sessions, search history, system settings metadata, and audit entries have relational tables and foreign keys. To keep the existing demo's flexible form fields working without rebuilding its UI, its operational module rows currently live in `module_records.data` as JSON. Database-enforced unique keys prevent duplicate room numbers, payment references, and active doctor/date/time slots; payment and room/admission updates use transactions.

This compatibility model is a development foundation, **not** the normalized clinical/billing schema or independent privacy/security review required before production or real patient data. It does not yet enforce foreign-key relationships between every clinical module, room capacity greater than one, assigned-patient scoping for clinicians, full role-permission editing, prescription/lab result history, or email-based password reset. There is no email/SMS provider configured, so forgot/reset-password is deliberately not exposed as a fake-success endpoint. Do not enter real patient information until those controls, backup/restore, operational monitoring, and a healthcare privacy review are completed.

`database/schema.sql` is the canonical initial schema and is idempotent for local setup. After schema changes, back up the database and apply the reviewed SQL migration before deployment.

## Checks

```powershell
npm test
npm start
```

`npm test` covers HTTP health and error response basics and does not require MySQL. Full API/business-rule tests require a disposable MySQL 8 test database and are not represented as passing until run against one.

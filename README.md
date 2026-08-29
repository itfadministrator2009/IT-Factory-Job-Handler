# IT Factory Work Desk — internal job log app

A single-login tool for logging and tracking work jobs: contact/account details, status, priority, ownership, due dates, file attachments, equipment lists, signatures, and printable/emailable job sheets — plus a shared knowledge base, reporting, and job templates.

**This version is built for Render** — a Node/Express backend (Web Service) with a persistent disk for its SQLite database and file attachments, and a React frontend (Static Site). Both deploy from Render, no other platform needed.

## What's included

**Backend** (`/server`) — Node.js + Express + SQLite
- Single login type — every team member who signs up has full access, no roles to manage
- Password reset via email (forgot-password link, 1-hour expiry)
- Jobs: Contact Name, Account Name, Email, Phone, Subject, Description, Status, Ticket Owner, Product Name, Due Date, Time, Language, Priority, Channel, Classifications, Site Address, Site Access Notes, Customer Reference
- File attachments per job (upload/download/delete), stored on disk, 20MB/file cap, image thumbnails in the UI
- Equipment/item lines per job (description, qty, reference/serial) — shown on the job sheet PDF
- Customer signature capture (on-screen signature pad, mobile-friendly full-screen on small devices)
- **Job Sheet PDF** — printable job sheet on the IT Factory letterhead, viewable in-app or **emailed directly** to the job's contact as a PDF attachment
- **Overdue detection**, **audit trail**, **auto status transition** (Open → In Progress on first note), **bulk status/owner actions**, **job templates**, **reporting** (jobs/week, avg resolution time, per-technician)
- Notes log, knowledge base articles, email notifications, inbound email-to-job webhook
- CORS lockdown via `FRONTEND_URL`; warns on startup if `JWT_SECRET` isn't set

**Frontend** (`/client`) — React + Vite + React Router
- Login / register, forgot/reset password flow
- Dashboard with job stats (including overdue count) and a search box
- Job list with search/status/priority/overdue filters, checkboxes + bulk status/owner toolbar
- Job form with a template-apply dropdown, equipment/items editor, and file attachments
- Job detail: notes log, drag-and-drop attachments with thumbnails, equipment list, signature capture, Job Sheet PDF (view or email), audit history, inline status/priority/owner editing
- Reports page, Job Templates management page, Knowledge base

## Run it locally

**Backend**
```bash
cd server
npm install
cp .env.example .env    # edit JWT_SECRET etc. if you like
npm run dev
```
Runs on `http://localhost:4000`. Uses a local SQLite file (`server/helpdesk.db`) and a `server/uploads/` folder — both created automatically on first run.

**Frontend**
```bash
cd client
npm install
cp .env.example .env    # points VITE_API_URL at localhost:4000
npm run dev
```
Runs on `http://localhost:5173`.

Register an account, and you're straight into the dashboard.

## Deploying to Render

Render hosts both halves of this app. You'll create two services from the same repo.

### 1. Backend — Web Service

1. Push this repo to GitHub.
2. In Render: **New → Web Service**, connect the repo.
3. Set:
   - **Root Directory**: `server`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. **Add a persistent disk** — Render's dashboard → your service → **Disks** → add one, mount path `/opt/render/project/src` (or wherever your working directory resolves to; Render shows you the correct path). **This step matters**: without it, both the SQLite database and every uploaded attachment are wiped on each redeploy, since Render's default filesystem is ephemeral.
5. Set environment variables:
   - `JWT_SECRET` — a long random string
   - `FRONTEND_URL` — you'll fill this in after step 2, once you know your frontend's Render URL (used for CORS and password-reset links)
   - Optionally `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `FROM_EMAIL` for real outbound email (without these, emails just log to the service's logs)
   - Optionally `INBOUND_WEBHOOK_TOKEN` for the email-to-job webhook
   - Optionally `COMPANY_NAME` / `COMPANY_ADDRESS` / `COMPANY_PHONE` / `COMPANY_ABN` to customize the PDF letterhead (defaults match the IT Factory template)
6. Deploy. Note the service's URL (e.g. `https://it-factory-work-desk-api.onrender.com`).

### 2. Frontend — Static Site

1. In Render: **New → Static Site**, same repo.
2. Set:
   - **Root Directory**: `client`
   - **Build Command**: `npm install && npm run build`
   - **Publish Directory**: `dist`
3. Set a build-time environment variable: `VITE_API_URL` = your backend's URL from step 1, plus `/api` (e.g. `https://it-factory-work-desk-api.onrender.com/api`). This must be set *before* the build runs — Vite bakes it in at build time, not runtime, so changing it later means redeploying.
4. Deploy. `client/public/_redirects` is already included and handles client-side routing (React Router) correctly on Render's static hosting — no extra config needed.

### 3. Connect the two

Go back to the backend service's environment variables and set `FRONTEND_URL` to the Static Site's URL from step 2, then redeploy the backend (or just save the env var — Render redeploys automatically). This makes CORS and password-reset emails point at the right place.

**Free tier note**: Render's free Web Service tier sleeps after inactivity — the first request after idle takes 30-60 seconds to wake up. Fine for testing; upgrade to a paid instance ($7/mo+) to remove this for real use.

## Job Sheet PDF

Every job has **Job Sheet PDF** and **Email Job Sheet** buttons on its detail page. The PDF is a one-page document on your letterhead with the job reference, business/site/contact details, equipment list, job description, notes, and the customer's signature (if captured). "Email Job Sheet" sends it as an attachment to the job's contact email.

Company details (name, address, ABN, phone) come from environment variables (see deploy steps above) — defaults match the IT Factory template if unset. The logo is `server/assets/logo.jpg` — replace that file to change the letterhead logo.

## Password reset

"Forgot password?" on the login page emails a reset link (or logs it to the console/service logs without SMTP configured). The link expires after 1 hour. `FRONTEND_URL` determines what domain the emailed link points at.

## Overdue jobs & auto status

A job is "overdue" once its Due Date has passed and it's still Open/In Progress/On Hold — computed on the fly. Shows as a red badge on the job list, job detail, and dashboard stat, with an "Overdue only" list filter.

If a job is still "Open" and someone logs the first note on it, its status automatically moves to "In Progress".

## Bulk actions, reports, templates

- **Bulk actions**: select jobs on the Jobs list with the checkboxes — a toolbar lets you set a status and/or owner for all selected jobs at once.
- **Reports**: jobs completed per week (last 8 weeks), average time to resolution, per-technician breakdown.
- **Templates**: create a template (default subject/priority/classifications + starter equipment list) from the Templates page; apply it from a dropdown when logging a new job.

## Email-to-job (inbound)

`POST /api/inbound/email?token=YOUR_TOKEN` accepts `{ from, subject, text }` and creates a job directly. Set `INBOUND_WEBHOOK_TOKEN`, then point your email provider's inbound-parse webhook (SendGrid Inbound Parse, Postmark Inbound, Mailgun Routes) at `https://your-backend.onrender.com/api/inbound/email?token=YOUR_TOKEN`.

## Suggested next features

1. **Reply-by-email threading** — match inbound emails to an existing job by job number in the subject line, adding a note instead of always creating a new job.
2. **SLA policies** — auto-escalate priority or notify when a job has been open past a configurable time.
3. **Multi-channel intake** — live chat or SMS, alongside the existing email/web/phone channels.
4. **Postgres** — if the team grows past a size where SQLite's single-writer model is comfortable, Render also offers managed Postgres; the schema in `server/db.js` translates directly.

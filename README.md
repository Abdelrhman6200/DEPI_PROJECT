# Diabetes Continuous-Care Platform (n8n backend)

An Arabic-first platform for adults with type 2 diabetes. It has a Patient Companion, a Provider OS, Care Access, and a Care Network, built from the v1.0 blueprint.

The backend runs entirely in **n8n**:

- **API:** n8n webhooks serve every API call.
- **Data:** a Google spreadsheet is the record of truth, with one tab per table. n8n reaches it through a service account and the free Sheets API. Without a Google account, a local stand-in serves the same API on your PC.
- **Clinical logic:** deterministic functions own all clinical decisions. They form the engine (`workflows/src/engine`), plain JavaScript that runs in n8n Code nodes over the spreadsheet data. It checks every write against the schema's rules: required fields, allowed values, unique keys and links between records.
- **AI agents:** Gemini, on the Google AI Studio free tier, interprets data and talks to patients.
- **Clinical model:** MedGemma 4B runs locally through Ollama.
- **RAG:**
  - Knowledge documents come from a Google Drive folder, read every 30 minutes. Putting a file in the folder approves it.
  - They are split into chunks and embedded locally with `nomic-embed-text`. The chunks and their vectors are kept in the `rag_chunks` tab.
  - Search is hybrid and relevance-gated: exact vector similarity plus stemmed term hits.
  - The knowledge base is kept current from accredited guideline sources (ADA, ADA/EASD, International Consensus on Time in Range, WHO, KDIGO, IDF-DAR, IWGDF). Openly licensed editions are imported for Safety Officer approval; restricted ones are watched for new editions.
  - Answers cite the publisher, the edition and a link.
- **AI gates:** every model call sits between a deterministic input gate and an output gate.
  - The input gate checks AI-processing consent and the cloud-egress switch, screens for prompt injection in Arabic and English, redacts identifiers, and wraps every untrusted input in nonce markers.
  - The output gate catches canary and instruction leaks, removes ungrounded links and contact details, and checks numbers against the facts. Risk-tiered release by an independent verifier follows.

Every component is free to run: n8n with its built-in SQLite, Google Sheets and Drive, the Gemini free tier, and Ollama.

> **Prototype with synthetic data only.** The clinical rules, drug reference, thresholds, fixed safety text, and knowledge-base documents are demonstration content. A Clinical Safety Officer must review all of them before any real-patient use. On the free tier, Google may use prompts to improve its products, so never send real patient data to the free Gemini API.

## What's in it

- **Patients and caregivers:**
  - Sign-up with consent, and a Today screen led by safety alerts.
  - Glucose logging with instant guidance, CGM charts, and a typical-day (AGP) view.
  - Medicines and safety checks, labs and kidney function.
  - Meals with Egyptian foods, activity, sleep and mood, with calories: per food and meal, eaten per day, burned by activity (MET minutes or steps), and an estimate of daily needs (Mifflin-St Jeor with an activity factor; informational, none in pregnancy).
  - The clinician's care plan with tasks, appointments, referrals and Find Care.
  - Need Care, a rule-based check of how urgently to seek care.
  - The AI Companion, with voice input and citations.
  - Document upload with AI reading, a two-way conversation with the care team, connecting with a clinic, and an offline Emergency screen.
  - Family members: the patient invites them with a one-time code and can remove them at any time.
  - Correcting the record: change a medicine, mark a condition resolved, remove an allergy, delete a mistyped reading.
  - Downloading all of one's data, and closing the account.
  - Optional email (any SMTP account, for example Gmail): "Forgot password?" links and family invitation codes by email.
- **Clinicians and staff:**
  - An inbox that keeps patient urgency and work priority separate.
  - The patient panel, plus a workspace with glucose, AGP, medicines and safety, labs, the care-plan builder, episodes, referrals, documents, and an AI pre-visit brief.
  - Replies to patient messages, appointments with confirm and check-in, referrals, hospital transfers, facility capacity, clinic join requests, and audited emergency access to records ("break-glass").
- **Administration:** the knowledge base used for AI search (RAG) with accredited guideline sources and edition approval, AI run tracing with gate decisions and prompt versions, rules, the event queue, staff accounts with one-time password resets, the audit log, and incidents.
- **AI quality and knowledge:**
  - LLM-as-a-judge (WF-025): AI answers are scored after the fact (grounding, hallucination, safety, helpfulness, over-refusal) with Gemini lite (MedGemma as fallback); every flagged answer and a sample of the rest. Each score is a row of the `ai_trials` sheet; problems become incidents the admin closes with what was changed; a weekly improvement report (WF-026) and the admin **AI quality** tab show trends by model and prompt version.
  - Tracing: every AI run and job run goes to self-hosted Langfuse (WF-030), tagged W1–W5 with the judge's scores; metadata only, no message text.
  - Answers carry numbered source markers [n] matching numbered source chips that open the cited passage. The verifier withholds unsafe drafts; a draft rejected only for wording or grounding is rewritten once and verified again.
  - RAG over approved guidelines (now including 22 public-domain patient lab-test pages from MedlinePlus and NIDDK) and over the person's own record (`search_patient_history`: past meals and their glucose rise, lows, lab history, medicines, visits) and dashboard (`get_dashboard_summary`). Target verdicts (meets / above / below) and the estimated average glucose are computed by the engine, not the model.
- **Directory and new screens:**
  - Find care also searches a directory of 766 Cairo and Giza doctors, clinics, hospitals, labs and pharmacies from OpenStreetMap (© OpenStreetMap contributors, ODbL), marked unverified and never used for referrals.
  - Ramadan: the IDF-DAR 2021 risk check, fasting hours and the "break your fast" rule; Today shows low-glucose predictions, risky-night and break-the-fast warnings and the weekly digest; clinicians get a Panel page with patients ranked by risk and overdue screenings.
- **Medicines, logging and notifications:**
  - Count what is left of a medicine, and the app counts down every scheduled dose. It reminds before the medicine runs out and links to a nearby pharmacy.
  - "Did you take it?" two hours after an unmarked dose.
  - A missed dose can carry a reason (not in pharmacies, too expensive, side effects, …). The first three reach the care team's inbox.
  - Adherence and "runs out" feed the clinician's risk panel.
  - Log a reading by voice ("سكري 180 بعد الفطار") or from a photo of the meter's screen, read by MedGemma on the server (WF-028). The number fills the form and the person confirms before saving.
  - Web push (WF-027), free and with no provider account: run `node scripts/set-vapid-keys.mjs` once. Pushes say only the kind of update; names, values and medicine names stay in the app. There is a daily cap and quiet hours, except for urgent alerts.
- **Personal data (Egypt Law 151/2020):**
  - Patients can ask to correct, erase, object to or restrict the use of their data, and the platform admin answers within 30 days.
  - Patients can see who opened their record.
  - Admins record breaches against the 72-hour deadline (Administration → Privacy).
- **Background automation (n8n):**
  - Pattern detection and explanations, medication-safety and lab explanations, and "what changed" after a care-plan update.
  - Weekly reviews, pre-visit briefs 48 hours ahead, reminders, episode follow-ups, and referral aging.
  - Nightscout CGM sync and document reading.
- **Safety, privacy and operations:**
  - A deterministic pre-screen for emergencies and same-day problems that runs before any model, in Arabic (including Egyptian dialect and Arabic written in Latin letters) and English.
  - Critical lab escalation.
  - Family-member access levels, private Companion chats per person, and role-based views (reception sees no clinical data).
  - Hashed sessions with idle timeouts, one-time two-factor codes, limits on emergency access, and staff-only password resets with notice to the account holder.
  - Retention, encrypted backups, no stored n8n execution data, and Arabic error messages.
  - An operations health page, escalation of unacknowledged urgent items.

## Quick start

Prerequisites: Docker Desktop, Node 20+, pnpm 10, and Ollama with GPU recommended. The demo was built on an 8 GB RTX laptop GPU.

```bash
bash scripts/setup.sh                          # .env, models, data spreadsheet, n8n, imports & publishes the platform workflow
bash scripts/set-gemini-key.sh <YOUR_FREE_KEY>  # key from https://aistudio.google.com/apikey
pnpm dev                                       # web app on http://localhost:3000
```

| Service | URL | Login |
|---|---|---|
| Web app | http://localhost:3000 | demo accounts below, password `Demo@2026` |
| n8n editor | http://localhost:5678 | `owner@demo.health` / `N8N_OWNER_PASSWORD` from `.env` (random, made by setup) |
| Data | http://localhost:8090 (local stand-in), or your Google spreadsheet | none on this PC; the spreadsheet is shared with the service account |



To share the running stack without a server, run `bash scripts/publish.sh`. It builds the web app as a Docker container (also at http://localhost:3300) and opens a free Cloudflare quick tunnel to it, then prints a public `https://<random words>.trycloudflare.com` link. Only the web app and its API are published; the n8n editor, the data stand-in and Mailpit stay on this PC. The link works while this PC and Docker run and changes on every start. Anyone with the link can sign in with the demo accounts, so share it only with people you trust and keep the data synthetic. `bash scripts/publish.sh --link` prints the current link and `bash scripts/publish.sh --stop` ends it.

Emails sent by the app go to a local catcher, [Mailpit](http://localhost:8025), so nothing leaves this PC. To send real emails, put an SMTP account in `.env` (see `.env.example`) and run `bash scripts/setup.sh` again.

To start over with fresh demo data, run `bash scripts/setup.sh --reset`. It wipes n8n's volume and the local spreadsheet. After you change `workflows/src` or `ai/prompts`, run `bash scripts/setup.sh` again.

### Demo accounts (password `Demo@2026`)

| Account | Scenario |
|---|---|
| `p1@demo.health` | Stable T2D with CGM (live simulated sensor) |
| `p2@demo.health` | Poor adherence, HbA1c 9.4%, draft care plan waiting to be published |
| `p3@demo.health` | Recurrent and nocturnal hypoglycemia on insulin + sulfonylurea |
| `p4@demo.health` | T2D + CKD 3b + polypharmacy (metformin/eGFR and ACE-inhibitor/spironolactone findings) |
| `p5@demo.health` | Manual glucose only, **unlinked** (no personalized targets) |
| `p6@demo.health` / `caregiver@demo.health` | Older Arabic-only patient and her daughter as caregiver |
| `p7@demo.health` | Acute episode: infected foot wound routed to urgent care |
| `p8@demo.health`, `p9@demo.health` | Excluded populations: pregnancy, closed-loop pump |
| `dr.hassan@demo.health`, `dr.mona@demo.health` | Doctors at two different clinics (cross-organization isolation) |
| `nurse.salma@demo.health`, `reception@demo.health` | Nurse and receptionist |
| `admin@demo.health`, `safety@demo.health`, `capacity@demo.health` | Clinic admin, Clinical Safety Officer (approves guidelines and education), facility capacity operator |
| `transfers@demo.health`, `platform@demo.health` | Transfer coordinator; platform administrator (staff accounts, health page; no clinical access) |

The demo data also has 41 generated panel patients, so there are 50 in total. Each request reads the tabs it needs in full, so glucose readings are kept hourly: the last 30 days for the three main CGM personas and the last 14 days for the others, about 9,000 readings. The setup moves every record time forward, so the demo data is current on the day it is loaded.

## Data and encryption

All records and uploaded documents stay on this computer, encrypted on disk with AES-256-GCM. The key is `DATA_ENCRYPTION_KEY` in `.env`, which `scripts/setup.sh` creates. **Keep a copy of the key off this computer: without it the data cannot be read.** Passwords are hashed with scrypt, and only hashes of session tokens are stored. Gemini still receives redacted text.

## Architecture in one picture

```
Next.js PWA (patient + provider, RTL)  ── /n8n proxy ──▶  "Health Platform": the whole backend in ONE n8n workflow
                                                            │  14 webhooks /webhook/api/v1/<group>  {action, data}
                                                            │  Auth Gate (fn_gate: session, role, family scope)
                                                            │  13 schedules (dispatcher every minute + a kick after
                                                            │  each API write, jobs, reviews, CGM and Drive sync)
                                                            ▼  sections, linked by call-ins (the workflow calls itself)
                     ┌──────────────────────────────────────┼───────────────────────────────┐
                     ▼                                      ▼                               ▼
            API sections                            AI sections                      Event dispatcher
   (engine functions: metrics, patterns,     pre-screen, AI gates, Gemini agent     (claim tokens, leases,
    policy, safety, care-level rules,        + tools + RAG, MedGemma, guards,        safety events first)
    Action Validator)                        risk-tiered verifier                           ▼
                     │                                      │                     consumer sections
                     └───── Google Sheets: one tab per table (record of truth) ◀───────────┘
                            Google Drive: knowledge folder · n8n server disk: uploaded documents
```

An API request reads the tabs it needs in one Sheets call (a second one when it turns out to need another tab), runs the engine on them in memory, and saves all its changes in one write call. The engine runs the former SQL test suites and passes them, so it gives the same answers as the SQL it was ported from.

`workflows/n8n/health-platform.json` is the whole backend as one n8n workflow: import that one file (editor: Import from file, or `n8n import:workflow`) and publish it.

The permanent rule for this stack:

1. The frontend requests.
2. The n8n Auth Gate and the engine decide access.
3. Engine functions decide clinical facts.
4. Gemini and MedGemma interpret.
5. `fn_apply_ai_action` validates every AI write.
6. The spreadsheet is the record of truth.


## Repository

```
apps/web/                 Next.js 15 app: patient (/app) and provider (/provider) surfaces, Arabic/English, RTL
packages/api-client/      Typed API contract + fetch client shared by the frontend
workflows/src/            Workflow generator (routes, AI flows, core jobs) → workflows/n8n/health-platform.json
workflows/src/engine/     The engine: every access, clinical and API function, and the table rules (schema.js)
workflows/n8n/            The built n8n workflows that setup imports and publishes
ai/prompts, ai/schemas    Versioned prompts and structured-output schemas
ai/knowledge/             Education documents for the Drive knowledge folder (the local stand-in serves them as-is)
database/sheets/          Initial data (seed.json), safety rules and error messages (rules.json), API route table
infra/                    docker-compose: n8n (SQLite), the Sheets and Drive stand-in, Mailpit, the Gemini gateway,
                          optional Ollama; langfuse/ for tracing
scripts/                  setup, the Sheets stand-in and cache, the Gemini gateway, keys (Gemini, push, Langfuse),
                          and publish.sh for a public link
```

## Models

| Role | Model | Where |
|---|---|---|
| Companion agent, verifiers, pre-visit brief, document reading | `GEMINI_MODEL` (default `gemini-3.8-flash`) | Google AI Studio free tier |
| Intake extraction, event explanations (frequent, short) | `GEMINI_MODEL_LITE` (default `gemini-3.5-flash-lite`) | Google AI Studio free tier |
| Clinical interpretation (tool + batch) | `medgemma:4b` | Ollama on the host GPU |
| Embeddings | `nomic-embed-text` (768-d) | Ollama |
| Fallback when Gemini is unavailable | MedGemma answer under the deterministic guard, otherwise fixed text | local |

**The Gemini gateway.** n8n reaches Gemini through a small gateway, `scripts/gemini-gateway.mjs` (Docker service `gemini`). The free tier's newest models are often busy, so for each request the gateway works like this:
- **Fallback chain:** it tries the model's chain in order and moves on when a model answers "busy" or "over quota", or stays silent for 20 s:
  - main: `gemini-3.8-flash` → `3.7-flash` → `3.5-flash` → `3.5-flash-lite`;
  - lite: `3.5-flash-lite` → `3.1-flash-lite` → `3.5-flash`.
- **Resting:** a model that answered "busy" or "over quota" is skipped for 10 minutes; one that only timed out is skipped for 2 minutes. Spreading requests across models also spreads the free quota. A lite request falls back along the lite chain, the chain that starts with its model.
- **Backup requests:** when a main-tier model has not answered after 8 s, the next model of the chain starts too and the first answer wins. A model beaten that way twice within 10 minutes rests for 2 minutes. Lite models are fast, so they get no backup request (`GEMINI_NO_HEDGE`).
- **Statistics:** `/stats` shows per model the answers, failures, average time and tokens used.
- **Thinking:** it asks the larger Gemini 3 models to think briefly, which keeps answers fast.
- **Logging:** it logs only model names, status codes and times, never prompt or answer text.

Change the chains with `GEMINI_CHAINS` in `.env`. Its health page lists resting models: `docker compose -f infra/docker-compose.yml exec gemini wget -qO- localhost:8092/health`.

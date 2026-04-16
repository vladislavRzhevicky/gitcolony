# GitColony

GitColony turns a GitHub repository into a living 3D city. Each commit becomes a building or an agent, each author becomes a resident, and the project's history unfolds as a colony you can walk through and observe. Point it at a repo, sign in, and watch the codebase come to life.

## Running locally

You need [Bun](https://bun.sh) ≥ 1.1, Docker, and a GitHub OAuth App.

### Registering a GitHub OAuth App

`GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are the credentials of your OAuth app on GitHub. The auth service uses them to run the "Sign in with GitHub" flow — the client id identifies your app to GitHub when the user is redirected over to grant consent, and the client secret is used server-side to exchange the returned code for an access token. Without them the auth server won't start.

Register one at https://github.com/settings/developers → **New OAuth App**:

- **Homepage URL:** `http://localhost:5173`
- **Authorization callback URL:** `http://localhost:3001/github/callback`

Copy the **Client ID** and generate a **Client secret** — paste both into `.env`.

```bash
# 1. Install dependencies
bun install

# 2. Configure
cp .env.example .env
#    At minimum set:
#    - ENCRYPTION_KEY=$(openssl rand -base64 32)
#    - GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET from your OAuth app

# 3. Bring up Postgres + Redis
bun run infra:up

# 4. Apply the DB schema
bun run db:push

# 5. Start the four processes, each in its own terminal
bun run auth:dev      # http://localhost:3001
bun run api:dev       # http://localhost:3000
bun run worker:dev
bun run web:dev       # http://localhost:5173
```

Open http://localhost:5173, sign in with GitHub, drop a Gemini key into `/settings`, and create a city from any repo you can access.

## Why connect an LLM

Without an LLM the city still generates — geometry, districts, and object placement are deterministic from the repo. But the parts that make the colony feel alive run through a model:

- **Names** for districts and landmarks, derived from paths and commit messages.
- **Personalities** for agents, based on each contributor's footprint in the repo.
- **A ticker** — short lines that narrate what the colony is doing right now.
- **Agent intents** — what each agent decides to do next in the simulation.
- **Meeting chatter** — lines agents exchange when they gather.
- **Mini code reviews** over real diff snapshots.

The only supported provider is **Google Gemini**. The preferred model is **`gemini-2.5-flash-lite`** — fast, cheap, and good enough for these short, structured generations. Other Gemini models are selectable in the UI, but this is the default and what we tune prompts against.

Keys live per-user. You add yours once in **Settings → AI Models**, it gets encrypted at rest, and the worker resolves it automatically for every job.

Grab a key at https://aistudio.google.com/app/apikey.

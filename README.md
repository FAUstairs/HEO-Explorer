# HEO Explorer

React/Vite ontology explorer for HEO classes.

## Getting started

```bash
npm install
npm run dev
```

The Explorer API handles authentication, SPARQL requests, notes and question
suggestions. Set up PostgreSQL and start the API as described below.

During development, the browser sends API requests under `/HEO-Explorer/api/`.
Vite strips `/HEO-Explorer` and proxies them to `http://localhost:3001` by default. If the API runs on a
different port, set the proxy target when starting Vite:

```bash
VITE_API_BASE_URL=http://127.0.0.1:3002 npm run dev
```

When running the Vite dev server behind an HTTPS reverse proxy, forward
`/HEO-Explorer/` to Vite with the path intact. Enable WebSocket upgrades on
that same path for hot reload.

For a separately hosted frontend and backend, use the public backend URL:

```bash
VITE_API_BASE_URL=https://api.example.org npm run build
```

## PostgreSQL setup on the server

### First installation

PostgreSQL must be running. Connect as a PostgreSQL administrator, for example
with `sudo -u postgres psql -X` on a server with a local `postgres` system user.
Create a login role for the Explorer and a database owned by that role:

```sql
CREATE ROLE heo_app LOGIN;
\password heo_app
CREATE DATABASE heo OWNER heo_app;
```

The `\password` command prompts for the database user's password. Use that
password in `DATABASE_URL`. If it contains URL-reserved characters, percent-encode
them in the connection string.

Create `heo-backend.env` in the project directory. Generate the JWT secret with
`openssl rand -hex 32` and replace the placeholders:

```dotenv
DATABASE_URL='postgresql://heo_app:YOUR_DB_PASSWORD@127.0.0.1:5432/heo'
JWT_SECRET='YOUR_GENERATED_SECRET'
INITIAL_ADMIN_USERNAME='admin'
INITIAL_ADMIN_PASSWORD='YOUR_INITIAL_ADMIN_PASSWORD'
```

Start the API with `npm run dev:server`. It creates the tables and indexes
automatically before accepting requests. The initial admin is created if both
admin variables are set and the username is new. Setting a different initial
password later leaves an existing account's password in place.

### Updating an existing installation

Keep the existing `DATABASE_URL` and `JWT_SECRET` and restart the API with the
updated code. The startup migration adds missing columns, tables and indexes.
No manual SQL migration is required. The role in `DATABASE_URL` needs
`CONNECT` on the database, `USAGE` and `CREATE` in the target schema, and
ownership of the existing Explorer tables so that it can alter them.

Users can request an account using **Create an account** on the sign-in page.
An administrator approves or rejects requests under **Admin → Pending registrations**.
Once approved, users sign in with their username or email address and password.
Administrators can delete active and rejected accounts. The signed-in
administrator and configured initial administrator are protected. Deleting an
account ends its API sessions and anonymises its question suggestions.

### Troubleshooting sign-in on the server

If the browser receives an HTTP 503 for `/HEO-Explorer/api/auth/login`,
check the API directly on the server. Use the configured API port if it
differs from 3001:

```bash
curl -i -H 'Content-Type: application/json' --data '{}' \
  http://127.0.0.1:3001/api/auth/login
```

The empty request should return HTTP 400 with a JSON message about missing
credentials. A connection failure means the API is unreachable on that port.
Check the API startup logs for missing environment variables, missing dependencies
or a PostgreSQL connection or migration error. For deployments that use
`heo-backend.env`, make sure the file exists on the server and contains
`DATABASE_URL` and `JWT_SECRET`.

If the API responds locally, send the same empty request to
`http://127.0.0.1:5173/HEO-Explorer/api/auth/login`. A failure there points to
the Vite server or its configured API target. If both local requests work,
check the reverse proxy for the public `/HEO-Explorer/` path.

## Ontology endpoint

The backend loads `heo-backend.env` from the project directory at startup when
the file exists. Environment variables already set for the process take
precedence. The backend queries `https://mathhub.info/api/backend/query` by
default. Set `HEO_QUERY_ENDPOINT` in `heo-backend.env` or override it when
starting the API to use a different triple store:

```bash
HEO_QUERY_ENDPOINT=http://127.0.0.1:8095/api/backend/query npm run dev:server
```

## Free-text questions

The **Ask a question** form uses the OpenAI API to generate a SPARQL query in
response to a German or English question. Add these settings to the backend
environment and restart the API:

```dotenv
OPENAI_API_KEY=your_api_key
OPENAI_MODEL=gpt-4.1-mini
```

`OPENAI_MODEL` is optional. Keep the key in the backend environment, for example
in the ignored `heo-backend.env` file loaded by the server on startup.
The public OpenAI API receives the question and the current HEO and ULO TBox
from the configured triple store. Query generation stops if the TBox is unavailable.
The HEO API executes the generated read-only query on the configured triple
store and returns the result and SPARQL query to the Explorer.

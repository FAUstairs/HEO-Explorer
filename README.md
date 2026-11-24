# HEO Explorer

React/Vite ontology explorer for HEO classes.

## Getting started

```bash
npm install
npm run dev
```

For authentication, SPARQL proxying and PostgreSQL-backed notes, start the API
separately:

```bash
export DATABASE_URL='postgresql://postgres:postgres@localhost:5432/heo'
export JWT_SECRET="$(openssl rand -base64 48)"
export INITIAL_ADMIN_USERNAME=admin
export INITIAL_ADMIN_PASSWORD='admin'
npm run dev:server
```

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

The initial user is created in the PostgreSQL `users` table only when both
`INITIAL_ADMIN_USERNAME` and `INITIAL_ADMIN_PASSWORD` are configured. The
password is stored as a bcrypt hash, never as plaintext. All ontology queries
are sent through the authenticated `/api/query` backend proxy.

The backend queries `https://mathhub.info/api/backend/query` by default. Set
`HEO_QUERY_ENDPOINT` on the API server to use a different triple store:

```bash
HEO_QUERY_ENDPOINT=http://127.0.0.1:8095/api/backend/query npm run dev:server
```

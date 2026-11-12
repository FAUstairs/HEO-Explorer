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
export JWT_SECRET='...'
export INITIAL_ADMIN_USERNAME=admin
export INITIAL_ADMIN_PASSWORD='admin'
npm run dev:server
```

The frontend uses the backend at `http://localhost:3001` by default. To use a
different backend, define `VITE_API_BASE_URL` before starting or building the
frontend:

```bash
VITE_API_BASE_URL=http://localhost:3001 npm run dev
```

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
HEO_QUERY_ENDPOINT=http://localhost:8095/api/backend/query npm run dev:server
```

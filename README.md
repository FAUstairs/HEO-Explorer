# HEO Availability

React/Vite ontology explorer for HEO classes.

## Starten

```bash
npm install
npm run dev
```

For the admin login and PostgreSQL-backed notes, start the API separately:

```bash
DATABASE_URL=postgres://user:password@localhost:5432/heo \
JWT_SECRET=replace-with-a-long-random-secret \
npm run dev:server
```

The fixed development credentials are `admin` / `admin`. The password is
stored as a bcrypt hash, never as plaintext. Notes are stored in the
`heo_instance_notes` PostgreSQL table through the authenticated API.

The application queries `https://mathhub.info/api/backend/query` by default.
The `/api` Vite proxy can be used during development. Set
`VITE_QUERY_ENDPOINT` to use a different URL:

```bash
VITE_QUERY_ENDPOINT=https://mathhub.info/api/backend/query npm run dev
```

The query finds types of HEO resources in the HEO namespace
`https://mathhub.info/heo#`. For example,
`heo:person-0022c4c584 a heo:Person` produces the class `heo:Person`.
The application displays unique HEO class types and searches both labels and
IRIs.

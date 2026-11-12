import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { Pool } from 'pg'

const app = express()
const port = Number(process.env.PORT ?? 3001)
const jwtSecret = process.env.JWT_SECRET
const databaseUrl = process.env.DATABASE_URL
const heoQueryEndpoint = process.env.HEO_QUERY_ENDPOINT ?? 'https://mathhub.info/api/backend/query'
const initialAdminUsername = process.env.INITIAL_ADMIN_USERNAME
const initialAdminPassword = process.env.INITIAL_ADMIN_PASSWORD

if (!jwtSecret || !databaseUrl || jwtSecret.length < 32) {
  throw new Error('DATABASE_URL and a JWT_SECRET with at least 32 characters must be configured.')
}

const pool = new Pool({ connectionString: databaseUrl })
app.use(express.json())
app.use(express.urlencoded({ extended: false }))

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL
    );
  `)
  await pool.query(`
    INSERT INTO users (username, password_hash, role)
    SELECT username, password_hash, 'admin' FROM admin_users
    ON CONFLICT (username) DO NOTHING;
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS heo_instance_notes (
      id BIGSERIAL PRIMARY KEY,
      instance_iri TEXT NOT NULL,
      note TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `)
  if (initialAdminUsername && initialAdminPassword) {
    const passwordHash = await bcrypt.hash(initialAdminPassword, 12)
    await pool.query(`
      INSERT INTO users (username, password_hash, role)
      VALUES ($1, $2, 'admin')
      ON CONFLICT (username) DO NOTHING;
    `, [initialAdminUsername, passwordHash])
  }
}

function authenticate(request: express.Request, response: express.Response, next: express.NextFunction) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return response.status(401).json({ error: 'Authentication required.' })
  try {
    jwt.verify(token, jwtSecret)
    next()
  } catch {
    response.status(401).json({ error: 'Invalid or expired session.' })
  }
}

app.post('/api/auth/login', async (request, response) => {
  const { username, password } = request.body as { username?: string; password?: string }
  if (!username?.trim() || !password) return response.status(400).json({ error: 'Username and password are required.' })
  const result = await pool.query('SELECT username, password_hash, role FROM users WHERE username = $1', [username.trim()])
  if (!result.rowCount || !(await bcrypt.compare(password, result.rows[0].password_hash))) return response.status(401).json({ error: 'Invalid credentials.' })
  const user = result.rows[0] as { username: string; role: string }
  response.json({ token: jwt.sign({ sub: user.username, role: user.role }, jwtSecret, { expiresIn: '8h' }) })
})

app.post('/api/query', authenticate, async (request, response) => {
  const query = typeof request.body.query === 'string' ? request.body.query.trim() : ''
  if (!query) return response.status(400).json({ error: 'A SPARQL query is required.' })
  if (query.length > 200_000) return response.status(413).json({ error: 'The SPARQL query is too large.' })
  try {
    const upstream = await fetch(heoQueryEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ query }),
    })
    const body = await upstream.text()
    response.status(upstream.status)
    response.type(upstream.headers.get('content-type')?.includes('json') ? 'json' : 'text')
    return response.send(body)
  } catch (error) {
    console.error('HEO query failed:', error)
    return response.status(502).json({ error: 'The ontology service could not be reached.' })
  }
})

app.get('/api/config', authenticate, (_request, response) => {
  response.json({ heoQueryEndpoint })
})

app.get('/api/notes', authenticate, async (request, response) => {
  const instanceIri = String(request.query.instanceIri ?? '')
  const result = await pool.query('SELECT id, instance_iri, note, created_at, updated_at FROM heo_instance_notes WHERE instance_iri = $1 ORDER BY updated_at DESC', [instanceIri])
  response.json(result.rows)
})

app.post('/api/notes', authenticate, async (request, response) => {
  const { instanceIri, note } = request.body as { instanceIri?: string; note?: string }
  if (!instanceIri?.trim() || !note?.trim()) return response.status(400).json({ error: 'instanceIri and note are required.' })
  const result = await pool.query('INSERT INTO heo_instance_notes (instance_iri, note) VALUES ($1, $2) RETURNING id, instance_iri, note, created_at, updated_at', [instanceIri, note.trim()])
  response.status(201).json(result.rows[0])
})

initializeDatabase()
  .then(() => {
    app.listen(port, () => console.log(`HEO API listening on http://localhost:${port}`))
  })
  .catch((error) => {
    console.error('Database initialization failed:', error)
    process.exitCode = 1
  })

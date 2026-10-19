import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { Pool } from 'pg'

const app = express()
const port = Number(process.env.PORT ?? 3001)
const jwtSecret = process.env.JWT_SECRET
const databaseUrl = process.env.DATABASE_URL

if (!jwtSecret || !databaseUrl) {
  throw new Error('JWT_SECRET and DATABASE_URL must be configured.')
}

const pool = new Pool({ connectionString: databaseUrl })
app.use(express.json())

async function initializeDatabase() {
  const passwordHash = await bcrypt.hash('admin', 12)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL
    );
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
  await pool.query(`
    INSERT INTO admin_users (username, password_hash)
    VALUES ('admin', $1)
    ON CONFLICT (username) DO NOTHING;
  `, [passwordHash])
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
  if (username !== 'admin' || password !== 'admin') return response.status(401).json({ error: 'Invalid credentials.' })
  const result = await pool.query('SELECT password_hash FROM admin_users WHERE username = $1', [username])
  if (!result.rowCount || !(await bcrypt.compare(password, result.rows[0].password_hash))) return response.status(401).json({ error: 'Invalid credentials.' })
  response.json({ token: jwt.sign({ sub: username, role: 'admin' }, jwtSecret, { expiresIn: '8h' }) })
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

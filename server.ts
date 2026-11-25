import express from 'express'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { answerQuestion, questionLimit, QuestionServiceError } from './questionService'

try {
  process.loadEnvFile(fileURLToPath(new URL('./heo-backend.env', import.meta.url)))
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}

const app = express()
const port = Number(process.env.PORT ?? 3001)
const jwtSecret = process.env.JWT_SECRET
const databaseUrl = process.env.DATABASE_URL
const heoQueryEndpoint = process.env.HEO_QUERY_ENDPOINT ?? 'https://mathhub.info/api/backend/query'
const initialAdminUsername = process.env.INITIAL_ADMIN_USERNAME
const initialAdminPassword = process.env.INITIAL_ADMIN_PASSWORD
const openaiApiKey = process.env.OPENAI_API_KEY?.trim()
const openaiModel = process.env.OPENAI_MODEL?.trim() || 'gpt-4.1-mini'

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
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS display_name TEXT,
      ADD COLUMN IF NOT EXISTS email TEXT,
      ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS approved BOOLEAN NOT NULL DEFAULT TRUE;
    CREATE UNIQUE INDEX IF NOT EXISTS users_registration_email
      ON users (email) WHERE email IS NOT NULL;
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS question_suggestions (
      id UUID PRIMARY KEY,
      username TEXT REFERENCES users (username) ON DELETE SET NULL,
      question TEXT NOT NULL CHECK (CHAR_LENGTH(question) BETWEEN 1 AND 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE question_suggestions ALTER COLUMN username DROP NOT NULL;
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'question_suggestions'::regclass
          AND conname = 'question_suggestions_username_fkey'
          AND confdeltype <> 'n'
      ) THEN
        ALTER TABLE question_suggestions DROP CONSTRAINT question_suggestions_username_fkey;
        ALTER TABLE question_suggestions ADD CONSTRAINT question_suggestions_username_fkey
          FOREIGN KEY (username) REFERENCES users (username) ON DELETE SET NULL;
      END IF;
    END $$;
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

async function authenticate(request: express.Request, response: express.Response, next: express.NextFunction) {
  const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
  if (!token) return response.status(401).json({ error: 'Authentication required.' })
  let claims
  try {
    claims = jwt.verify(token, jwtSecret)
  } catch {
    return response.status(401).json({ error: 'Invalid or expired session.' })
  }
  if (typeof claims === 'string' || typeof claims.sub !== 'string' || typeof claims.iat !== 'number') {
    return response.status(401).json({ error: 'Invalid or expired session.' })
  }
  const accountCreatedAt = typeof claims.accountCreatedAt === 'string' ? claims.accountCreatedAt : null
  const result = await pool.query(`
    SELECT username, role FROM users
    WHERE username = $1 AND approved AND rejected_at IS NULL
      AND (EXTRACT(EPOCH FROM created_at)::text = $2
        OR ($2::text IS NULL AND created_at <= TO_TIMESTAMP($3::double precision)))
  `, [claims.sub, accountCreatedAt, claims.iat])
  if (!result.rowCount) return response.status(401).json({ error: 'Invalid or expired session.' })
  response.locals.account = result.rows[0]
  return next()
}

function requireAdmin(_request: express.Request, response: express.Response, next: express.NextFunction) {
  if (response.locals.account.role === 'admin') return next()
  return response.status(403).json({ error: 'Administrator access is required.' })
}

function registrationEmail(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  const email = value.trim().toLowerCase()
  if (email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email
}

app.post('/api/auth/register', async (request, response) => {
  const name = typeof request.body?.name === 'string' ? request.body.name.trim() : ''
  const username = typeof request.body?.username === 'string' ? request.body.username.trim().toLowerCase() : ''
  const email = registrationEmail(request.body?.email)
  const password = request.body?.password
  if (!name || name.length > 120 || !email) {
    return response.status(400).json({ error: 'Enter a name of at most 120 characters and a valid email address.' })
  }
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) {
    return response.status(400).json({ error: 'Use 3 to 40 letters, numbers, dots, underscores or hyphens for the username.' })
  }
  if (typeof password !== 'string' || password.length < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return response.status(400).json({ error: 'Use a password of at least 8 characters and at most 72 UTF-8 bytes.' })
  }
  if (password !== request.body.passwordConfirmation) {
    return response.status(400).json({ error: 'The passwords do not match.' })
  }

  const passwordHash = await bcrypt.hash(password, 12)
  const result = await pool.query(`
    INSERT INTO users (username, display_name, email, password_hash, role, approved)
    SELECT $1, $2, $3, $4, 'user', FALSE
    WHERE NOT EXISTS (SELECT 1 FROM users WHERE LOWER(username) = $1)
    ON CONFLICT DO NOTHING
    RETURNING username
  `, [username, name, email, passwordHash])
  if (!result.rowCount) return response.status(409).json({ error: 'The username or email address is already in use.' })
  return response.status(201).json({ status: 'pending' })
})

app.post('/api/auth/login', async (request, response) => {
  const username = typeof request.body?.username === 'string' ? request.body.username.trim() : ''
  const password = request.body?.password
  if (!username || typeof password !== 'string' || !password) {
    return response.status(400).json({ error: 'Email or username and password are required.' })
  }
  const result = await pool.query(`
    SELECT username, password_hash, role, approved, rejected_at,
      EXTRACT(EPOCH FROM created_at)::text AS account_created_at FROM users
    WHERE username = $1 OR (email IS NOT NULL AND (username = $2 OR email = $2))
    ORDER BY (username = $1) DESC
    LIMIT 1
  `, [username, username.toLowerCase()])
  if (!result.rowCount || !(await bcrypt.compare(password, result.rows[0].password_hash))) return response.status(401).json({ error: 'Invalid credentials.' })
  const user = result.rows[0] as { username: string; role: string; approved: boolean; rejected_at: Date | null; account_created_at: string }
  if (user.rejected_at) return response.status(403).json({ error: 'Your account request was declined.' })
  if (!user.approved) return response.status(403).json({ error: 'Your account is awaiting administrator approval.' })
  response.json({ token: jwt.sign({
    sub: user.username, role: user.role, accountCreatedAt: user.account_created_at,
  }, jwtSecret, { expiresIn: '8h' }) })
})

app.get('/api/admin/registrations', authenticate, requireAdmin, async (request, response) => {
  const result = await pool.query(`
    SELECT username, COALESCE(display_name, username) AS name, email, role, created_at AS "createdAt",
      rejected_at AS "rejectedAt",
      ((approved OR rejected_at IS NOT NULL) AND username <> $2 AND username IS DISTINCT FROM $3::text) AS "canDelete",
      CASE WHEN rejected_at IS NOT NULL THEN 'rejected' WHEN approved THEN 'active' ELSE 'pending' END AS status
    FROM users
    WHERE $1::boolean OR (NOT approved AND rejected_at IS NULL AND role = 'user' AND email IS NOT NULL)
    ORDER BY created_at, email
  `, [request.query.view === 'all', response.locals.account.username, initialAdminUsername || null])
  return response.json(result.rows)
})

app.post('/api/admin/registrations/:decision', authenticate, requireAdmin, async (request, response) => {
  const decision = request.params.decision
  if (decision !== 'approve' && decision !== 'reject') return response.status(404).json({ error: 'Unknown registration action.' })
  const email = registrationEmail(request.body?.email)
  if (!email) return response.status(400).json({ error: 'A valid registration email is required.' })
  const result = await pool.query(`
    UPDATE users SET approved = $2, rejected_at = CASE WHEN $2 THEN NULL ELSE NOW() END
    WHERE email = $1 AND role = 'user' AND NOT approved AND rejected_at IS NULL
    RETURNING email
  `, [email, decision === 'approve'])
  if (!result.rowCount) return response.status(409).json({ error: 'This registration is no longer pending.' })
  return response.status(204).end()
})

app.delete('/api/admin/accounts', authenticate, requireAdmin, async (request, response) => {
  const username = request.body?.username
  if (typeof username !== 'string' || !username) return response.status(400).json({ error: 'A username is required.' })
  if (username === response.locals.account.username || username === initialAdminUsername) {
    return response.status(409).json({ error: 'This administrator account is protected.' })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('heo-explorer-delete-account'))")
    const admin = await client.query("SELECT 1 FROM users WHERE username = $1 AND approved AND rejected_at IS NULL AND role = 'admin'",
      [response.locals.account.username])
    if (!admin.rowCount) {
      await client.query('ROLLBACK')
      return response.status(403).json({ error: 'Administrator access is required.' })
    }
    const result = await client.query(`
      DELETE FROM users WHERE username = $1 AND (approved OR rejected_at IS NOT NULL) RETURNING username
    `, [username])
    if (result.rowCount) await client.query('DELETE FROM admin_users WHERE username = $1', [username])
    await client.query('COMMIT')
    if (!result.rowCount) return response.status(404).json({ error: 'Active or rejected account not found.' })
    return response.status(204).end()
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
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
  response.json({ heoQueryEndpoint, canManageUsers: response.locals.account.role === 'admin' })
})

app.post('/api/questions', authenticate, async (request, response) => {
  const question = typeof request.body?.question === 'string' ? request.body.question.trim() : ''
  if (!question || question.length > questionLimit) {
    return response.status(400).json({ error: `Enter a question of at most ${questionLimit} characters.` })
  }
  if (!openaiApiKey) return response.status(503).json({ error: 'OpenAI is not configured on the HEO API server.' })

  try {
    const answer = await answerQuestion(question, { apiKey: openaiApiKey, model: openaiModel, endpoint: heoQueryEndpoint })
    return response.json(answer)
  } catch (error) {
    if (error instanceof QuestionServiceError) return response.status(error.status).json({ error: error.message })
    if (error instanceof Error && error.name === 'TimeoutError') {
      return response.status(504).json({ error: 'The question timed out. Try a more specific question.' })
    }
    return response.status(502).json({ error: 'The question could not be answered. Please try again.' })
  }
})

app.get('/api/questions/suggestions', authenticate, async (_request, response) => {
  const result = await pool.query(`
    SELECT s.id, s.question, s.created_at AS "createdAt", COALESCE(s.username = $1, FALSE) AS "canEdit",
      CASE WHEN u.username IS NULL THEN 'Deleted account'
        ELSE COALESCE(u.display_name, CASE WHEN POSITION('@' IN u.username) = 0 THEN u.username ELSE 'User' END) END AS author
    FROM question_suggestions s LEFT JOIN users u ON u.username = s.username
    ORDER BY s.created_at DESC, s.id
  `, [response.locals.account.username])
  return response.json(result.rows)
})

function readSuggestedQuestion(value: unknown): string | undefined {
  if (typeof value !== 'string') return
  const question = value.trim()
  if (question.length > 0 && question.length <= 1000) return question
}

app.post('/api/questions/suggestions', authenticate, async (request, response) => {
  const question = readSuggestedQuestion(request.body?.question)
  if (!question) return response.status(400).json({ error: 'Enter a question of at most 1,000 characters.' })
  await pool.query(`
    INSERT INTO question_suggestions (id, username, question) VALUES ($1, $2, $3)
  `, [randomUUID(), response.locals.account.username, question])
  return response.status(201).end()
})

const suggestionId = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

app.delete('/api/questions/suggestions', authenticate, requireAdmin, async (request, response) => {
  const ids: unknown = request.body?.ids
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && suggestionId.test(id))) {
    return response.status(400).json({ error: 'Select valid suggestions to delete.' })
  }
  await pool.query('DELETE FROM question_suggestions WHERE id = ANY($1::uuid[])', [ids])
  return response.status(204).end()
})

app.patch('/api/questions/suggestions/:id', authenticate, async (request, response) => {
  const id = request.params.id
  if (!suggestionId.test(id)) return response.status(404).json({ error: 'Suggestion not found.' })
  const question = readSuggestedQuestion(request.body?.question)
  if (!question) return response.status(400).json({ error: 'Enter a question of at most 1,000 characters.' })
  const result = await pool.query(`
    UPDATE question_suggestions SET question = $3 WHERE id = $1 AND username = $2
  `, [id, response.locals.account.username, question])
  if (!result.rowCount) return response.status(404).json({ error: 'Suggestion not found.' })
  return response.status(204).end()
})

app.delete('/api/questions/suggestions/:id', authenticate, async (request, response) => {
  const id = request.params.id
  if (!suggestionId.test(id)) return response.status(404).json({ error: 'Suggestion not found.' })
  const result = await pool.query(`
    DELETE FROM question_suggestions WHERE id = $1 AND username = $2
  `, [id, response.locals.account.username])
  if (!result.rowCount) return response.status(404).json({ error: 'Suggestion not found.' })
  return response.status(204).end()
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
    app.listen(port, (error) => {
      if (error) {
        console.error(`HEO API could not listen on port ${port}:`, error)
        process.exitCode = 1
        void pool.end()
        return
      }
      console.log(`HEO API listening on http://localhost:${port}`)
    })
  })
  .catch((error) => {
    console.error('Database initialization failed:', error)
    process.exitCode = 1
  })

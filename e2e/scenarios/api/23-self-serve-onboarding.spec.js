/**
 * S-23 — Self-serve onboarding and public-project write protection.
 *
 * Exercises the complete cold-start API flow against the isolated GitHub user
 * mock configured by docker-compose.test.yml / docker-compose.e2e.yml.
 */

import { test, expect } from '@playwright/test'
import axios from 'axios'
import { token } from '../../helpers/jwt.js'
import { uid } from '../../helpers/seed.js'

const { describe } = test

/** Gateway base URL. */
const BASE = process.env.QUORUM_GATEWAY_URL ?? 'http://localhost:3001'
/** Unique public project namespace for this run. */
const PROJECT = uid('s23-self-serve')
/** GitHub identity returned by the isolated test endpoint. */
const NEW_USER = 'e2e-newbie'

/**
 * Axios client that preserves non-2xx responses for assertions.
 *
 * @param {string} [bearerToken]
 * @param {string} [project]
 * @returns {import('axios').AxiosInstance}
 */
function client(bearerToken, project) {
  return axios.create({
    baseURL: BASE,
    headers: {
      ...(bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {}),
      ...(project ? { 'X-Quorum-Project': project } : {}),
      'Content-Type': 'application/json',
    },
    validateStatus: () => true,
  })
}

/** Net-new project config whose uploader is the principal architect. */
const CONFIG = {
  group_id:  PROJECT,
  project:   'S-20 Self-Serve Project',
  owner:     NEW_USER,
  is_public: true,
  members: [
    {
      name:            'E2E New User',
      github_username: NEW_USER,
      role:            'principal_architect',
      team:            'platform',
    },
  ],
}

test.describe.configure({ mode: 'serial' })

describe('S-23.1 — Cold-start self-serve onboarding', () => {
  /** JWT issued by POST /auth/token without project context. */
  let projectlessJwt

  test('step 1 — a never-onboarded GitHub user receives a projectless JWT', async () => {
    const res = await client().post('/auth/token', {
      github_token: 'e2e-github-newbie',
    })

    expect(res.status).toBe(200)
    expect(res.data.sub).toBe(NEW_USER)
    expect(res.data.project).toBeNull()
    expect(res.data.member_found).toBe(false)
    projectlessJwt = res.data.token
  })

  test('step 2 — the projectless user bootstraps a net-new project', async () => {
    const res = await client(projectlessJwt).post('/config/upload', CONFIG)

    expect(res.status).toBe(201)
    expect(res.data.project_id).toBe(PROJECT)
  })

  test('step 3 — the new project config is readable after onboarding', async () => {
    const res = await client(projectlessJwt, PROJECT).get(`/config/${PROJECT}`)

    expect(res.status).toBe(200)
    expect(res.data.group_id).toBe(PROJECT)
    expect(res.data.members).toEqual(expect.arrayContaining([
      expect.objectContaining({ github_username: NEW_USER, role: 'principal_architect' }),
    ]))
  })

  test('step 4 — bootstrap upload cannot overwrite an existing namespace', async () => {
    const res = await client(projectlessJwt).post('/config/upload', CONFIG)

    expect(res.status).toBe(409)
    expect(res.data.error).toBe('already_onboarded')
    expect(res.data.project_id).toBe(PROJECT)
  })
})

describe('S-23.2 — Public projects are read-only for non-members', () => {
  /** Valid JWT for an identity that is not listed in CONFIG. */
  const outsiderJwt = token('s23-outsider')

  test('step 1 — a non-member can read a public project', async () => {
    const res = await client(outsiderJwt, PROJECT).get('/api/knowledge?limit=1')

    expect(res.status).toBe(200)
  })

  test('step 2 — the same non-member cannot write to the public project', async () => {
    const res = await client(outsiderJwt, PROJECT).post('/api/knowledge', {
      topic:       'security',
      key:         uid('outsider-write'),
      content:     'This write must be rejected because the caller is not a project member.',
      entity_type: 'Decision',
    })

    expect(res.status).toBe(403)
    expect(res.data.error).toBe('not_a_member')
  })
})

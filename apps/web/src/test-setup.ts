import { vi } from 'vitest'

// Mock cloudflare:workers to prevent ReferenceErrors during tests
vi.mock('cloudflare:workers', () => {
  return {
    env: {
      replyloom_db: {},
      replyloom_wa_worker: {
        fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 })),
      },
      replyloom_reply_cache: {},
      replyloom_media: {},
      BETTER_AUTH_SECRET: 'test-secret',
      ENGINE_INTERNAL_SECRET: 'test-engine-secret',
      WS_TOKEN_SECRET: 'test-ws-secret',
      BETTER_AUTH_URL: 'http://localhost:3000',
    },
  }
})

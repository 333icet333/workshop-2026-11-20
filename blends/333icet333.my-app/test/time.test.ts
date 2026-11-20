import { test } from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../plugins/time/index.ts'
import { Acryl } from '../plugins/router/src/index.ts'

test('GET /time returns the current time', async () => {
  const routes: Record<string, Acryl> = {}
  const widgets: any[] = []
  apply({ router: { route: (p: string, a: Acryl) => (routes[p] = a) }, home: { widget: (w: any) => widgets.push(w) }, effect: (f: () => unknown) => f() } as any)
  const res = await routes['/time'].request('/')
  const body = (await res.json()) as { time: string }
  assert.ok(!Number.isNaN(Date.parse(body.time)))
  assert.match(await widgets[0].render(), /Server time/)
})

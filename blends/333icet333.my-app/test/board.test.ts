import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { pinnedInstance, withPort } from '@acryldev/instance'
import { type App, createApp } from '../src/app.ts'

/** Throwaway homes live inside the project (`.acrylblends/` is ignored by git): a sandboxed agent may not write to the system temp folder. */
const scratch = join(fileURLToPath(new URL('..', import.meta.url)), '.acrylblends', 'test')
mkdirSync(scratch, { recursive: true })
const projectRoot = fileURLToPath(new URL('..', import.meta.url))

/** Boot the app in a throwaway home on any free port, run the test, always stop it and remove the home. */
async function withApp(run: (app: App) => Promise<void>) {
  const home = await mkdtemp(join(scratch, 'board-test-'))
  const app = await createApp(withPort(pinnedInstance(home, { root: projectRoot }), 0), {
    listen: false,
  })
  try {
    await run(app)
  } finally {
    await app.stop()
    await rm(home, { recursive: true, force: true })
  }
}

interface Card {
  readonly id: string
  readonly title: string
  readonly status: 'backlog' | 'doing' | 'done'
  readonly owner: string
}

const json = (body: unknown) => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

/** The state cell the page's counts are computed from. */
const cellOf = (app: App) =>
  (
    app.root as unknown as {
      state: { find<T>(key: string): { get(): T } | undefined }
    }
  ).state.find<Card[]>('board.cards')

test('the board page has the three columns, the filter sidebar with its toggle, and the New card button', () =>
  withApp(async (app) => {
    const response = await app.root.router.request('/board', { headers: { accept: 'text/html' } })
    assert.equal(response.status, 200)
    const page = await response.text()
    for (const column of ['backlog', 'doing', 'done']) {
      assert.match(page, new RegExp(`id="board-list-${column}"`), column)
      assert.match(page, new RegExp(`data-column="${column}"`), column)
    }
    for (const filter of ['all', 'mine', 'done']) {
      assert.match(page, new RegExp(`id="board-filter-${filter}"`), filter)
      assert.match(page, new RegExp(`id="board-filter-count-${filter}"`), filter)
    }
    assert.match(page, /id="board-sidebar"[^>]*aria-label="Filters"/)
    assert.match(page, /id="board-sidebar-toggle"[^>]*aria-controls="board-sidebar"/)
    assert.match(page, /<button type="submit" class="primary">New card<\/button>/)
    // The page follows the app's own state, and carries the appearance script so it follows Light and Dark.
    assert.match(page, /watch\('board\.cards'/)
    assert.match(page, /<script src="\.\/appearance\.js"><\/script>/)
  }))

test('a new card lands in the backlog and the state cell the counts read follows it', () =>
  withApp(async (app) => {
    const before = (await (await app.root.router.request('/board/cards')).json()) as {
      cards: Card[]
    }
    assert.equal(before.cards.length, 3, 'a new board starts with one card per column')

    const created = await app.root.router.request('/board/cards', {
      method: 'POST',
      ...json({ title: 'Ship the board', owner: 'Ada' }),
    })
    assert.equal(created.status, 201)
    const answer = (await created.json()) as { card: Card; cards: Card[] }
    assert.equal(answer.card.title, 'Ship the board')
    assert.equal(answer.card.status, 'backlog')
    assert.equal(answer.card.owner, 'Ada')
    assert.equal(answer.cards.length, 4)

    const cell = cellOf(app)
    assert.ok(cell, 'the cards are a state cell the page can follow')
    assert.equal(cell.get().filter((card) => card.title === 'Ship the board').length, 1)

    // Ticking the card's checkbox is a status change: the card moves to the done column and the counts follow, live.
    const done = await app.root.router.request(`/board/cards/${answer.card.id}`, {
      method: 'POST',
      ...json({ status: 'done' }),
    })
    assert.equal(done.status, 200)
    assert.equal((await done.json() as { cards: Card[] }).cards.filter((c) => c.status === 'done').length, 2)
    assert.equal(cell.get().find((card) => card.id === answer.card.id)?.status, 'done')

    const removed = await app.root.router.request(`/board/cards/${answer.card.id}`, {
      method: 'DELETE',
    })
    assert.equal(removed.status, 200)
    assert.equal(((await removed.json()) as { cards: Card[] }).cards.length, 3)
    assert.equal(cell.get().length, 3)
  }))

test('a card needs a title, and an unknown card is a 404', () =>
  withApp(async (app) => {
    const empty = await app.root.router.request('/board/cards', {
      method: 'POST',
      ...json({ title: '   ' }),
    })
    assert.equal(empty.status, 400)
    assert.match(((await empty.json()) as { error: string }).error, /title/)

    const missing = await app.root.router.request('/board/cards/nope', {
      method: 'POST',
      ...json({ status: 'done' }),
    })
    assert.equal(missing.status, 404)
    await missing.body?.cancel()
  }))

test('the cards are kept in a file in the app home, so a restart shows the same board', async () => {
  const home = await mkdtemp(join(scratch, 'board-restart-'))
  try {
    const first = await createApp(withPort(pinnedInstance(home, { root: projectRoot }), 0), {
      listen: false,
    })
    try {
      const created = await first.root.router.request('/board/cards', {
        method: 'POST',
        ...json({ title: 'Keep me' }),
      })
      assert.equal(created.status, 201)
    } finally {
      await first.stop()
    }
    const second = await createApp(withPort(pinnedInstance(home, { root: projectRoot }), 0), {
      listen: false,
    })
    try {
      const cards = (await (await second.root.router.request('/board/cards')).json()) as {
        cards: Card[]
      }
      assert.ok(cards.cards.some((card) => card.title === 'Keep me'))
    } finally {
      await second.stop()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

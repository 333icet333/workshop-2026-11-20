/**
 * Board: a page at /board with backlog, doing and done columns, a filter sidebar with live counts, and a New card button.
 *
 * The cards are kept in `board.json` in the app's home (one whole write through a temporary file and a rename), so they survive a restart, and they
 * are also the state cell `board.cards`, which the page follows with `watch` of `/api/state/client.js`: a card added, ticked or deleted anywhere
 * changes the counts in every open window without a reload or a poll. The cell belongs to this plugin's fiber, so it goes when the plugin does.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type {} from '@acryldev/instance'
import { Acryl } from '@acryldev/blends'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'board'
export const inject = ['router', 'appInstance']

type Status = 'backlog' | 'doing' | 'done'

const STATUSES: readonly Status[] = ['backlog', 'doing', 'done']
const isStatus = (value: unknown): value is Status => STATUSES.includes(value as Status)

interface Card {
  readonly id: string
  readonly title: string
  readonly status: Status
  /** Who the card belongs to: the sidebar's "Mine" counts the cards assigned to the person reading. */
  readonly owner: string
  readonly createdAt: string
}

/** The slice of the state service (`plugins/state`) this plugin uses: one cell that a page follows with `watch`. */
interface StateService {
  cell<T>(key: string, initial: T): { set(value: T): void }
}

/** The state key the page follows: `/api/state/board.cards`. */
const KEY = 'board.cards'
const MAX_TITLE = 200
const MAX_OWNER = 40
const DEFAULT_OWNER = 'You'

const isCard = (value: unknown): value is Card => {
  if (typeof value !== 'object' || value === null) return false
  const card = value as Record<string, unknown>
  return (
    typeof card.id === 'string' &&
    typeof card.title === 'string' &&
    isStatus(card.status) &&
    typeof card.owner === 'string' &&
    typeof card.createdAt === 'string'
  )
}

/** The first cards of a board nobody has used yet, one per column, so the page and its counts show what they do. */
function seed(): Card[] {
  const now = new Date().toISOString()
  return [
    { id: randomUUID(), title: 'Plan the week', status: 'backlog', owner: DEFAULT_OWNER, createdAt: now },
    { id: randomUUID(), title: 'Write the board page', status: 'doing', owner: DEFAULT_OWNER, createdAt: now },
    { id: randomUUID(), title: 'Read the app docs', status: 'done', owner: DEFAULT_OWNER, createdAt: now },
  ]
}

/** The cards in the file; a missing file is a new board (the seed), an unreadable or hand-edited one keeps only the cards it can read. */
function readCards(file: string): Card[] {
  if (!existsSync(file)) return seed()
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? parsed.filter(isCard) : []
  } catch {
    return []
  }
}

/** Write the whole file through a temporary name and a rename, so a crash never leaves half a board. */
function writeCards(file: string, cards: readonly Card[]): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(cards, null, 2)}\n`)
  renameSync(temporary, file)
}

export function apply(ctx: Context): void {
  const file = join(ctx.appInstance.home, `${name}.json`)
  let cards = readCards(file)
  // The cell is created below, once the state service is there; until then a change is only the file and the copy in memory.
  let publish: (next: readonly Card[]) => void = () => {}
  const commit = (next: Card[]): void => {
    cards = next
    writeCards(file, next)
    publish(next)
  }
  const find = (id: string): Card | undefined => cards.find((card) => card.id === id)

  const app = new Acryl()
    .get('/', (c) => c.html(PAGE))
    .get('/cards', (c) => c.json({ cards }))
    .post('/cards', async (c) => {
      const body = (await c.req.json().catch(() => ({}))) as { title?: unknown; owner?: unknown }
      const title = typeof body.title === 'string' ? body.title.trim().slice(0, MAX_TITLE) : ''
      if (title === '') return c.json({ error: 'a card needs a title' }, 400)
      const owner =
        typeof body.owner === 'string' && body.owner.trim() !== ''
          ? body.owner.trim().slice(0, MAX_OWNER)
          : DEFAULT_OWNER
      const card: Card = {
        id: randomUUID(),
        title,
        status: 'backlog',
        owner,
        createdAt: new Date().toISOString(),
      }
      commit([...cards, card])
      return c.json({ card, cards }, 201)
    })
    .post('/cards/:id', async (c) => {
      const card = find(c.req.param('id'))
      if (card === undefined) return c.json({ error: 'no such card' }, 404)
      const body = (await c.req.json().catch(() => ({}))) as { status?: unknown }
      if (!isStatus(body.status)) return c.json({ error: 'status must be backlog, doing or done' }, 400)
      const status: Status = body.status
      commit(cards.map((entry) => (entry.id === card.id ? { ...entry, status } : entry)))
      return c.json({ cards })
    })
    .delete('/cards/:id', (c) => {
      const card = find(c.req.param('id'))
      if (card === undefined) return c.json({ error: 'no such card' }, 404)
      commit(cards.filter((entry) => entry.id !== card.id))
      return c.json({ cards })
    })
  ctx.router.route('/board', app)

  // The cards as a state cell, so the sidebar's counts change in every open window when a card does. It is created from this plugin's context,
  // so it is removed with the plugin: the key is free again at the next reload.
  ctx.inject(['state'], (inner) => {
    const state = (inner as unknown as { state: StateService }).state
    const cell = state.cell<Card[]>(KEY, [...cards])
    publish = (next) => {
      cell.set([...next])
    }
    inner.effect(() => () => {
      publish = () => {}
    }, 'board: the live cards')
  })
}

/**
 * The page. It carries the appearance script (the person's Light, Dark or System choice) and colours itself only with its custom properties. Every
 * id starts with `board-`, every URL is derived from where the page is mounted, and card text is put in with `textContent`, never into HTML.
 */
const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Board</title>
    <script src="./appearance.js"></script>
    <style>
      * { box-sizing: border-box }
      body { margin: 0; font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg) }
      .board-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 12px 20px; border-bottom: 1px solid var(--border); background: var(--surface) }
      .board-top h1 { margin: 0 8px 0 0; font-size: 18px }
      .board-new { display: flex; gap: 8px; margin-left: auto }
      input[type="text"] { font: inherit; padding: 6px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg); min-width: 12rem }
      button { font: inherit; padding: 6px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--fg); cursor: pointer }
      button:hover { border-color: var(--accent) }
      button.primary { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 600 }
      .board-layout { display: flex; align-items: flex-start; gap: 16px; padding: 16px 20px }
      #board-sidebar { flex: none; width: 210px; padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface) }
      #board-sidebar[hidden] { display: none }
      #board-sidebar h2 { margin: 0 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted) }
      .board-filter { display: flex; justify-content: space-between; align-items: center; gap: 8px; width: 100%; margin: 0 0 6px }
      .board-filter span { font-variant-numeric: tabular-nums; color: var(--muted) }
      .board-filter[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: var(--bg); font-weight: 600 }
      .board-filter[aria-pressed="true"] span { color: var(--bg) }
      #board-sidebar hr { border: 0; border-top: 1px solid var(--border); margin: 12px 0 }
      #board-sidebar label { display: block; margin-bottom: 4px; font-size: 13px; color: var(--muted) }
      #board-sidebar input { width: 100% }
      .board-note { margin: 6px 0 0; font-size: 12px; color: var(--muted) }
      .board-columns { flex: 1; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; min-width: 0 }
      .board-column { padding: 12px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); min-height: 140px }
      .board-column h2 { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 14px; color: var(--muted) }
      .board-column h2 span { font-variant-numeric: tabular-nums }
      .board-cards { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px }
      .board-cards:empty::after { content: "No cards"; font-size: 13px; color: var(--muted) }
      .card { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px; background: var(--bg) }
      .card-check { margin: 3px 0 0; accent-color: var(--accent) }
      .card-body { flex: 1; min-width: 0 }
      .card-title { display: block; overflow-wrap: anywhere }
      .card-done .card-title { text-decoration: line-through; color: var(--muted) }
      .card-meta { margin-top: 4px }
      .card-owner { font-size: 11px; color: var(--muted); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px }
      .card-actions { display: flex; flex-direction: column; gap: 4px }
      .card-actions button { padding: 2px 8px; font-size: 12px; color: var(--muted) }
      #board-status { margin: 0 20px 20px; min-height: 1.2em; font-size: 13px; color: var(--muted) }
      @media (max-width: 820px) {
        .board-layout { flex-direction: column }
        .board-columns { grid-template-columns: 1fr; width: 100% }
        #board-sidebar { width: 100% }
      }
    </style>
  </head>
  <body>
    <header class="board-top">
      <h1>Board</h1>
      <button type="button" id="board-sidebar-toggle" aria-expanded="true" aria-controls="board-sidebar">Hide filters</button>
      <form id="board-new" class="board-new">
        <input type="text" id="board-new-title" name="title" placeholder="What needs doing?" aria-label="Title of the new card">
        <button type="submit" class="primary">New card</button>
      </form>
    </header>
    <div class="board-layout">
      <aside id="board-sidebar" aria-label="Filters">
        <h2>Filters</h2>
        <button type="button" class="board-filter" id="board-filter-all" data-filter="all" aria-pressed="true">All <span id="board-filter-count-all">0</span></button>
        <button type="button" class="board-filter" id="board-filter-mine" data-filter="mine" aria-pressed="false">Mine <span id="board-filter-count-mine">0</span></button>
        <button type="button" class="board-filter" id="board-filter-done" data-filter="done" aria-pressed="false">Done <span id="board-filter-count-done">0</span></button>
        <hr>
        <label for="board-person">You are</label>
        <input type="text" id="board-person" value="You">
        <p class="board-note">Mine counts the cards assigned to you.</p>
      </aside>
      <main class="board-columns">
        <section class="board-column" data-column="backlog">
          <h2>Backlog <span id="board-column-count-backlog">0</span></h2>
          <ul class="board-cards" id="board-list-backlog"></ul>
        </section>
        <section class="board-column" data-column="doing">
          <h2>Doing <span id="board-column-count-doing">0</span></h2>
          <ul class="board-cards" id="board-list-doing"></ul>
        </section>
        <section class="board-column" data-column="done">
          <h2>Done <span id="board-column-count-done">0</span></h2>
          <ul class="board-cards" id="board-list-done"></ul>
        </section>
      </main>
    </div>
    <p id="board-status" role="status"></p>
    <script type="module">
      // The page is mounted at <base>/board on the app's own server and at <base>/app/board in the ACRYL frame: every URL is derived from here, so
      // the plugin never writes the frame's prefix.
      const BASE = location.pathname.replace(/\\/board$/, '')
      const at = (path) => BASE + path
      const COLUMNS = ['backlog', 'doing', 'done']
      const FILTERS = ['all', 'mine', 'done']
      const book = { cards: [], filter: 'all', person: 'You' }

      const status = document.getElementById('board-status')
      const say = (text) => { status.textContent = text }

      function element(tag, className, text) {
        const node = document.createElement(tag)
        if (className) node.className = className
        if (text !== undefined) node.textContent = text
        return node
      }

      function readPerson() {
        try {
          const saved = localStorage.getItem('board.person')
          if (typeof saved === 'string' && saved.trim() !== '') return saved.trim()
        } catch (error) { /* storage blocked: stay with the default */ }
        return 'You'
      }

      function matches(card) {
        if (book.filter === 'mine') return card.owner === book.person
        if (book.filter === 'done') return card.status === 'done'
        return true
      }

      function cardNode(card) {
        const item = element('li', 'card')
        item.dataset.cardId = card.id
        if (card.status === 'done') item.classList.add('card-done')

        const check = document.createElement('input')
        check.type = 'checkbox'
        check.className = 'card-check'
        check.checked = card.status === 'done'
        check.setAttribute('aria-label', 'Mark ' + card.title + ' done')
        check.addEventListener('change', () => {
          update(card, check.checked ? 'done' : 'backlog')
        })
        item.append(check)

        const body = element('div', 'card-body')
        body.append(element('span', 'card-title', card.title))
        const meta = element('div', 'card-meta')
        meta.append(element('span', 'card-owner', card.owner))
        body.append(meta)
        item.append(body)

        const actions = element('div', 'card-actions')
        if (card.status !== 'done') {
          const move = element('button', 'card-move', card.status === 'backlog' ? 'Start' : 'Back')
          move.type = 'button'
          move.addEventListener('click', () => {
            update(card, card.status === 'backlog' ? 'doing' : 'backlog')
          })
          actions.append(move)
        }
        const remove = element('button', 'card-delete', 'Delete')
        remove.type = 'button'
        remove.setAttribute('aria-label', 'Delete ' + card.title)
        remove.addEventListener('click', () => { erase(card) })
        actions.append(remove)
        item.append(actions)
        return item
      }

      function render() {
        const counts = {
          all: book.cards.length,
          mine: book.cards.filter((card) => card.owner === book.person).length,
          done: book.cards.filter((card) => card.status === 'done').length,
        }
        for (const filter of FILTERS) {
          const badge = document.getElementById('board-filter-count-' + filter)
          if (badge) badge.textContent = String(counts[filter])
          const button = document.getElementById('board-filter-' + filter)
          if (button) button.setAttribute('aria-pressed', String(book.filter === filter))
        }
        for (const column of COLUMNS) {
          const list = document.getElementById('board-list-' + column)
          const shown = book.cards.filter((card) => card.status === column && matches(card))
          if (list) list.replaceChildren(...shown.map(cardNode))
          const badge = document.getElementById('board-column-count-' + column)
          if (badge) badge.textContent = String(shown.length)
        }
      }

      async function ask(path, options) {
        const reply = await fetch(at(path), options)
        const data = await reply.json().catch(() => ({}))
        if (!reply.ok) throw new Error(data.error || 'the board answered ' + reply.status)
        return data
      }

      const asJson = (body) => ({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })

      async function update(card, next) {
        try {
          const data = await ask('/board/cards/' + encodeURIComponent(card.id), asJson({ status: next }))
          if (Array.isArray(data.cards)) {
            book.cards = data.cards
            render()
          }
          say('')
        } catch (error) {
          say(String(error.message || error))
        }
      }

      async function erase(card) {
        try {
          const data = await ask('/board/cards/' + encodeURIComponent(card.id), { method: 'DELETE' })
          if (Array.isArray(data.cards)) {
            book.cards = data.cards
            render()
          }
          say('Deleted "' + card.title + '"')
        } catch (error) {
          say(String(error.message || error))
        }
      }

      // The header button: a card in the backlog, with the title typed above it (or "New card" when the field is empty).
      document.getElementById('board-new').addEventListener('submit', async (event) => {
        event.preventDefault()
        const field = document.getElementById('board-new-title')
        const title = field.value.trim() || 'New card'
        try {
          const data = await ask('/board/cards', asJson({ title: title, owner: book.person }))
          field.value = ''
          if (Array.isArray(data.cards)) {
            book.cards = data.cards
            render()
          }
          say('Added "' + title + '" to the backlog')
        } catch (error) {
          say(String(error.message || error))
        }
      })

      // The sidebar: the toggle button opens and closes it, and a filter button chooses what the columns show.
      const sidebar = document.getElementById('board-sidebar')
      const toggle = document.getElementById('board-sidebar-toggle')
      toggle.addEventListener('click', () => {
        const open = sidebar.hasAttribute('hidden')
        if (open) sidebar.removeAttribute('hidden')
        else sidebar.setAttribute('hidden', '')
        toggle.setAttribute('aria-expanded', String(open))
        toggle.textContent = open ? 'Hide filters' : 'Show filters'
      })

      for (const button of document.querySelectorAll('[data-filter]')) {
        button.addEventListener('click', () => {
          book.filter = button.dataset.filter
          render()
        })
      }

      // Who "Mine" counts: kept in this browser only, so the board needs no sign-in.
      const who = document.getElementById('board-person')
      book.person = readPerson()
      who.value = book.person
      who.addEventListener('change', () => {
        book.person = who.value.trim() || 'You'
        who.value = book.person
        try {
          localStorage.setItem('board.person', book.person)
        } catch (error) { /* storage blocked: the choice lasts this page */ }
        render()
      })

      async function start() {
        try {
          const data = await ask('/board/cards')
          book.cards = Array.isArray(data.cards) ? data.cards : []
          render()
        } catch (error) {
          say('The board could not load its cards: ' + String(error.message || error))
        }
        // Live counts: one state key for the whole page, over the app's own WebSocket (event streams only if it cannot open).
        try {
          const state = await import(at('/api/state/client.js'))
          state.watch('board.cards', (value) => {
            if (!Array.isArray(value)) return
            book.cards = value
            render()
          })
        } catch (error) {
          say('The board shows what it loaded; live updates are off. Reload to see other changes.')
          console.warn('board: live updates are off', error)
        }
      }

      start()
    </script>
  </body>
</html>
`

import type { Context } from '@deepseek-ai/cordis'
import { Acryl } from '@acryldev/blends'
import type {} from '../home/index.ts'

export const name = 'time'
export const inject = ['router', 'home']

export function apply(ctx: Context) {
  const app = new Acryl().get('/', (c) => c.json({ time: new Date().toISOString() }))
  ctx.router.route('/time', app)
  ctx.effect(() =>
    ctx.home.widget({
      id: 'time',
      title: 'Time',
      render: () => `<p id="time-line">Server time: ${new Date().toISOString()}</p>`,
    }),
  )
}

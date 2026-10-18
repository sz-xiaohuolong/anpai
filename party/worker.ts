/**
 * Worker 入口：把 /parties/room/:code 路由到房间 Durable Object，
 * 其余请求交给静态资源。
 */

import { routePartykitRequest } from 'partyserver'
import { AnpaiRoom } from './server.ts'

export { AnpaiRoom }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const routed = await routePartykitRequest(request, env)
    if (routed) return routed

    if (env.ASSETS) return env.ASSETS.fetch(request)

    return new Response('Not found', { status: 404 })
  },
} satisfies ExportedHandler<Env>

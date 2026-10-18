/**
 * 极简路由。
 *
 * 只支持三条路径；不引 vue-router —— 三个页面不值得一个路由库，
 * 而 `not_found_handling = "single-page-application"` 已保证刷新不 404。
 */

import { readonly, ref } from 'vue'

export type Route =
  | { name: 'home' }
  | { name: 'room'; code: string }
  | { name: 'play'; code: string }

function parse(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] === 'room' && parts[1]) {
    const code = decodeURIComponent(parts[1]).toUpperCase()
    if (parts[2] === 'play') return { name: 'play', code }
    return { name: 'room', code }
  }
  return { name: 'home' }
}

const route = ref<Route>(parse(location.pathname))

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', () => {
    route.value = parse(location.pathname)
  })
}

export function useRoute() {
  return readonly(route)
}

export function navigate(path: string): void {
  history.pushState({}, '', path)
  route.value = parse(path)
}

export function goHome(): void {
  navigate('/')
}

export function goRoom(code: string): void {
  navigate(`/room/${code}`)
}

export function goPlay(code: string): void {
  navigate(`/room/${code}/play`)
}

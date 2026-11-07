// The signed-in routes the header links to, shaped like the app's: the
// AppShell parents carry meta.section and their children a title. The
// components are blanks; the header specs mount the header alone.
import { defineComponent, h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useAppStore } from '@/stores/app'

export const Blank = defineComponent({ render: () => h('div') })

export const SITES = Object.freeze([
  Object.freeze({ id: 'w1', name: 'Wrenfield' }),
  Object.freeze({ id: 'w2', name: 'Acme' }),
])

export function makeShellRouter() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/docs', name: 'docs', component: Blank },
      { path: '/support', name: 'support', component: Blank },
      { path: '/login', name: 'login', component: Blank },
      {
        path: '/dashboard',
        meta: { section: 'analytics' },
        children: [{ path: '', name: 'dashboard', component: Blank, meta: { title: 'Analytics' } }],
      },
      {
        path: '/projects/:websiteId',
        meta: { section: 'analytics' },
        children: [{ path: 'analytics', name: 'analytics', component: Blank }],
      },
      { path: '/agent', name: 'agent', component: Blank, meta: { section: 'agent' } },
      {
        path: '/agent/projects',
        meta: { section: 'agent' },
        children: [{ path: '', name: 'agent-projects', component: Blank, meta: { title: 'Projects' } }],
      },
      {
        path: '/projects/:websiteId/agent',
        meta: { section: 'agent' },
        children: [
          { path: '', name: 'agent-home', component: Blank },
          { path: 'c/:chatId', name: 'agent-chat', component: Blank },
          { path: 'reports', name: 'agent-reports', component: Blank, meta: { title: 'Reports' } },
        ],
      },
      {
        path: '/settings',
        meta: { section: 'settings' },
        children: [
          { path: '', name: 'settings', component: Blank, meta: { title: 'Settings' } },
          { path: 'project', name: 'settings-project', component: Blank, meta: { title: 'Project settings' } },
          {
            path: 'usage-dashboard',
            name: 'settings-command-center',
            component: Blank,
            meta: { title: 'Usage dashboard' },
          },
        ],
      },
      {
        path: '/billing',
        meta: { section: 'settings' },
        children: [{ path: '', name: 'billing', component: Blank, meta: { title: 'Billing' } }],
      },
    ],
  })
  // As the app's router does: the URL's project becomes active once the
  // navigation went through.
  router.afterEach((to, _from, failure) => {
    if (failure || !to.params.websiteId) return
    const app = useAppStore()
    const site = app.websites.find((w) => String(w.id) === String(to.params.websiteId))
    if (site) app.setActiveWebsite(site)
  })
  return router
}

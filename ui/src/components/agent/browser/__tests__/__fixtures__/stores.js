// Stand-ins for the agent and auth stores in browser pane specs. They expose
// only what the pane reads, so pane specs do not depend on the run pipeline
// or on the API client (which imports the router).
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'

export const useAgentStore = defineStore('agent', () => {
  const websiteId = ref('w1')
  const status = ref({ swarm: { enabled: true, max_agents: 30 } })
  const messages = reactive({})
  const paths = reactive({})
  const chatState = reactive({})
  const artifacts = reactive({})
  const loadCalls = []
  // Research agents loaded by API, as the real store keeps them:
  // {[swarmId]: {detail, versions: {[n]: SwarmVersion}, loading, error}}.
  const swarms = reactive({})
  // What the swarm endpoints answer in a spec: details and versions by id,
  // and failures by `swarm:<id>` or `version:<id>:<n>` ({status, code,
  // message}; a 404 sets the entry's error, anything else throws).
  const swarmApi = { details: {}, versions: {}, failures: {} }

  function visiblePath(chatId) {
    return (paths[chatId] || []).map((id) => messages[id]).filter(Boolean)
  }

  function artifact(id) {
    return artifacts[id] || null
  }

  async function loadArtifact(id, version) {
    loadCalls.push([id, version ?? null])
    return artifacts[id] || null
  }

  async function loadVersions(id) {
    loadCalls.push([id, 'versions'])
    return artifacts[id]?.versions || []
  }

  function tableParts(swarmId) {
    const out = []
    for (const message of Object.values(messages)) {
      for (const part of message?.parts || []) {
        if (part && part.type === 'swarm_table' && part.swarm_id === swarmId) out.push(part)
      }
    }
    return out
  }

  function swarmTable(swarmId, version) {
    const part = tableParts(swarmId).find((p) => Number(p.version) === Number(version))
    if (part) return part.table
    return swarms[swarmId]?.versions?.[version]?.table || null
  }

  function latestSwarmVersion(swarmId) {
    const versions = tableParts(swarmId).map((p) => Number(p.version) || 0)
    versions.push(Number(swarms[swarmId]?.detail?.latest_version) || 0)
    return Math.max(...versions) || null
  }

  function swarmCategories(swarmId) {
    return swarms[swarmId]?.detail?.categories || []
  }

  function entry(swarmId) {
    if (!swarms[swarmId]) swarms[swarmId] = { detail: null, versions: {}, loading: false, error: null }
    return swarms[swarmId]
  }

  function fail(target, failure) {
    const error = Object.assign(new Error(failure.message || 'Failed'), failure)
    if (failure.status === 404) {
      target.error = error
      return null
    }
    throw error
  }

  async function loadSwarm(swarmId) {
    loadCalls.push(['swarm', swarmId])
    const target = entry(swarmId)
    const failure = swarmApi.failures[`swarm:${swarmId}`]
    if (failure) return fail(target, failure)
    target.detail = swarmApi.details[swarmId] || null
    target.error = null
    return target.detail
  }

  async function loadSwarmVersion(swarmId, version) {
    loadCalls.push(['version', swarmId, version])
    const target = entry(swarmId)
    const failure = swarmApi.failures[`version:${swarmId}:${version}`]
    if (failure) return fail(target, failure)
    const loaded = swarmApi.versions[`${swarmId}:${version}`] || null
    if (loaded) target.versions = { ...target.versions, [version]: loaded }
    target.error = null
    return loaded
  }

  function isChatBusy() {
    return false
  }

  return {
    websiteId,
    status,
    messages,
    paths,
    chatState,
    artifacts,
    loadCalls,
    swarms,
    swarmApi,
    visiblePath,
    artifact,
    loadArtifact,
    loadVersions,
    swarmTable,
    latestSwarmVersion,
    swarmCategories,
    loadSwarm,
    loadSwarmVersion,
    isChatBusy,
  }
})

// Findings as the results table reads them, without the API client.
export const useAgentFindingsStore = defineStore('agentFindings', () => {
  const canEdit = ref(true)
  const added = reactive({})
  function isAdded(swarmId, sheet, rowKey) {
    return Boolean(added[`${swarmId}:${sheet}:${rowKey}`])
  }
  function init() {}
  async function addFromTable() {
    return { created: [], duplicates: [] }
  }
  return { canEdit, added, isAdded, init, addFromTable }
})

export const useAuthStore = defineStore('auth', () => {
  const user = ref({ id: 7 })
  const session = ref(null)
  const accessToken = ref('test-token')
  return { user, session, accessToken }
})

// A Google results page as the contract describes it.
export function serpCapture(overrides = {}) {
  return {
    capture_id: 'c1',
    query: 'best note app',
    page: 2,
    start: 10,
    location: 'us',
    captured_at: '2026-11-02T14:03:00Z',
    brand: { name: 'Turonote', domain: 'turonote.test' },
    brand_positions: [14],
    results: [
      {
        position: 11,
        title: 'The 12 best note taking apps',
        url: 'https://reviews.test/notes',
        display_url: 'https://reviews.test › notes',
        domain: 'reviews.test',
        snippet: 'We compared note apps.',
        is_yours: false,
        is_competitor: false,
      },
      {
        position: 12,
        title: 'Notely: notes for teams',
        url: 'https://notely.test/',
        display_url: 'https://notely.test',
        domain: 'notely.test',
        snippet: 'Write together.',
        is_yours: false,
        is_competitor: true,
        competitor_name: 'Notely',
      },
      {
        position: 14,
        title: 'Turonote: fast notes',
        url: 'https://turonote.test/',
        display_url: 'https://turonote.test',
        domain: 'turonote.test',
        snippet: 'Capture ideas quickly.',
        is_yours: true,
        is_competitor: false,
      },
    ],
    ai_overview: {
      shown: true,
      mentions_you: false,
      cites_you: true,
      references: [{ title: 'Turonote', url: 'https://turonote.test/', domain: 'turonote.test' }],
    },
    people_also_ask: ['What is the best free note app?'],
    error: null,
    ...overrides,
  }
}

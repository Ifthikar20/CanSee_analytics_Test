// Review payloads (p2_contract.md 13c) for the review specs.

const minutesAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString()

export const CAN_NOTHING = { request: false, approve: false, request_changes: false, withdraw: false, reopen: false, comment: false }

export function review(overrides = {}) {
  return {
    artifact_id: 'a1',
    state: 'draft',
    effective_state: 'draft',
    version: 0,
    latest_version: 2,
    updated_since_request: false,
    reviewer: null,
    requested_by: null,
    requested_at: null,
    decided_by: null,
    decided_at: null,
    revision: 0,
    sole_writer: false,
    can: { ...CAN_NOTHING, request: true, comment: true },
    events: [],
    ...overrides,
  }
}

export function inReview(overrides = {}) {
  return review({
    state: 'in_review',
    effective_state: 'in_review',
    version: 2,
    reviewer: { id: 'u2', name: 'Ana Lopez' },
    requested_by: { id: 'u1', name: 'Site Owner' },
    requested_at: minutesAgo(5),
    revision: 3,
    can: { ...CAN_NOTHING, approve: true, request_changes: true, withdraw: true, comment: true },
    events: [
      {
        id: 'ev1',
        kind: 'requested',
        actor_name: 'Site Owner',
        reviewer_name: 'Ana Lopez',
        version: 2,
        body: 'Check the pricing table.',
        email: 'sent',
        created_at: minutesAgo(5),
      },
    ],
    ...overrides,
  })
}

export const TEAM = [
  { id: 'u1', name: 'Site Owner', email: 'owner@example.com', role: 'owner', is_you: true },
  { id: 'u2', name: 'Ana Lopez', email: 'ana@example.com', role: 'member', is_you: false },
  { id: 'u3', name: 'Ben Ito', email: 'ben@example.com', role: 'admin', is_you: false },
]

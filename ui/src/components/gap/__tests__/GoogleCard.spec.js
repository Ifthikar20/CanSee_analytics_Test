import { afterEach, describe, expect, it } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import GoogleCard from '@/components/gap/GoogleCard.vue'

enableAutoUnmount(afterEach)

function render(aiOverview) {
  const google = { status: 'ok', position: 4, page: 1, score: 70, ai_overview: aiOverview }
  return mount(GoogleCard, { props: { google }, global: { stubs: { RouterLink: true } } })
}

function overviewLine(wrapper) {
  const block = wrapper.findAll('.gc-block').find((b) => b.text().includes("Google's AI Overview"))
  return block ? block.find('.gc-line').text() : null
}

describe('GoogleCard AI Overview', () => {
  it('says an overview Google loaded separately was not captured, instead of no', () => {
    const wrapper = render({ shown: true, content_captured: false, mentions_you: null, cites_you: null, references: [] })
    expect(overviewLine(wrapper)).toBe(
      'Google showed an AI Overview for this query, but its content was not captured, so mentions and citations were not measured.'
    )
    expect(wrapper.text()).not.toContain("Doesn't mention you")
  })

  it('reads a value that was not measured as not measured', () => {
    expect(overviewLine(render({ shown: true, mentions_you: null, cites_you: true, references: [] }))).toBe(
      'Mentions not measured · cites your site'
    )
    expect(overviewLine(render({ shown: true, mentions_you: false, cites_you: null, references: [] }))).toBe(
      "Doesn't mention you · citations not measured"
    )
  })

  it('reads measured values as they are', () => {
    expect(overviewLine(render({ shown: true, captured: true, mentions_you: true, cites_you: false, references: [] }))).toBe(
      "Mentions you · doesn't cite your site"
    )
    expect(overviewLine(render({ shown: false, captured: true, mentions_you: false, cites_you: false, references: [] }))).toBe(
      null
    )
  })
})

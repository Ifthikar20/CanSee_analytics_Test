import { describe, expect, it } from 'vitest'
import source from '../OnboardingFlow.vue?raw'

// The wizard renders inside AppShell's <main id="app-main">; a second main
// landmark nested in the first confuses landmark navigation.
describe('OnboardingFlow landmark', () => {
  it('is a named region, not a nested main', () => {
    const template = source.slice(source.indexOf('<template>'), source.indexOf('<script')).replace(/<!--[\s\S]*?-->/g, '')
    expect(template).not.toMatch(/<main[\s>]/)
    expect(template).toMatch(/<div class="ob-root" role="region" aria-label="Set up your Cansee">/)
  })
})

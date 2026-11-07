// Test fixture only. A stand-in for VizChart (its frozen props, emits and
// slots, design/pages_frontend.md 2f) so page specs can assert the spec
// each chart gets without drawing canvases in jsdom. It prints the title,
// the error or empty title, and renders the actions and custom slots.
import { defineComponent, h } from 'vue'

export const VizChartStub = defineComponent({
    name: 'VizChart',
    props: {
        spec: { type: Object, required: true },
        loading: { type: Boolean, default: false },
        error: { type: String, default: '' },
        empty: { type: Object, default: null },
        height: { type: Number, default: 240 },
        representation: { type: String, default: '' },
        persistKey: { type: String, default: '' },
        compact: { type: Boolean, default: false },
        surface: { type: String, default: '' },
        headingLevel: { type: Number, default: 3 },
        selected: { type: String, default: '' },
    },
    emits: ['update:representation', 'select', 'retry'],
    setup(props, { slots, emit }) {
        return () =>
            h('figure', { class: 'viz-stub', 'data-id': props.spec?.id || '' }, [
                h('p', { class: 'viz-stub-title' }, props.spec?.title || ''),
                props.loading ? h('p', { class: 'viz-stub-loading' }, 'Loading') : null,
                props.error
                    ? h('p', { class: 'viz-stub-error' }, [
                          props.error,
                          h('button', { type: 'button', class: 'viz-stub-retry', onClick: () => emit('retry') }, 'Try again'),
                      ])
                    : null,
                props.empty ? h('p', { class: 'viz-stub-empty' }, props.empty.title) : null,
                props.empty?.body ? h('p', { class: 'viz-stub-empty-body' }, props.empty.body) : null,
                slots.actions?.(),
                slots.custom?.({ spec: props.spec, representation: 'custom' }),
            ])
    },
})

/** The stubbed charts of a wrapper, by spec id. */
export function chartsById(wrapper) {
    const out = {}
    for (const chart of wrapper.findAllComponents(VizChartStub)) {
        out[chart.props('spec')?.id || ''] = chart
    }
    return out
}

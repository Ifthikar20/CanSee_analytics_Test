import { describe, expect, it } from 'vitest'
import { createSseParser, parseSse } from '../sseParser'

function collect() {
    const out = { events: [], comments: [], retries: [] }
    const parser = createSseParser({
        onEvent: (e) => out.events.push(e),
        onComment: (c) => out.comments.push(c),
        onRetry: (ms) => out.retries.push(ms),
    })
    return { parser, out }
}

const FRAME = 'id: 7\nevent: part.delta\ndata: {"seq":7,"type":"part.delta"}\n\n'

describe('sseParser', () => {
    it('parses a contract frame', () => {
        const { events } = parseSse(FRAME)
        expect(events).toEqual([{ type: 'part.delta', data: '{"seq":7,"type":"part.delta"}', id: '7' }])
    })

    it('defaults the event type to message', () => {
        expect(parseSse('data: x\n\n').events).toEqual([{ type: 'message', data: 'x', id: '' }])
    })

    it('joins multi-line data with LF and drops only the final LF', () => {
        expect(parseSse('data: a\ndata: b\ndata:\n\n').events[0].data).toBe('a\nb\n')
        expect(parseSse('data: one\ndata: two\n\n').events[0].data).toBe('one\ntwo')
    })

    it('accepts LF, CR and CRLF line ends, mixed in one stream', () => {
        const lf = parseSse('data: a\n\ndata: b\n\n').events.map((e) => e.data)
        const cr = parseSse('data: a\r\rdata: b\r\r').events.map((e) => e.data)
        const crlf = parseSse('data: a\r\n\r\ndata: b\r\n\r\n').events.map((e) => e.data)
        const mixed = parseSse('data: a\r\n\ndata: b\r\r\n').events.map((e) => e.data)
        expect(lf).toEqual(['a', 'b'])
        expect(cr).toEqual(['a', 'b'])
        expect(crlf).toEqual(['a', 'b'])
        expect(mixed).toEqual(['a', 'b'])
    })

    it('treats a CRLF split across two chunks as one line end', () => {
        const { parser, out } = collect()
        parser.feed('data: a\r')
        parser.feed('\n')
        parser.feed('data: b\r')
        parser.feed('\n\r')
        parser.feed('\n')
        expect(out.events.map((e) => e.data)).toEqual(['a\nb'])
    })

    it('gives the same result for any chunking', () => {
        const stream = 'retry: 3000\n: hello\r\nid: 1\nevent: run.started\ndata: {"a":1}\r\n\r\n' + FRAME
        const whole = parseSse(stream)
        for (const size of [1, 2, 3, 5, 7, 13]) {
            const { parser, out } = collect()
            for (let i = 0; i < stream.length; i += size) parser.feed(stream.slice(i, i + size))
            parser.end()
            expect(out.events).toEqual(whole.events)
            expect(out.comments).toEqual(whole.comments)
            expect(out.retries).toEqual(whole.retries)
        }
    })

    it('strips one leading BOM only at the start of the stream', () => {
        const { parser, out } = collect()
        parser.feed('\uFEFFdata: a\n\n')
        parser.feed('\uFEFFdata: b\n\n')
        expect(out.events.map((e) => e.data)).toEqual(['a'])
        // The second BOM is part of a field name, so that line is an unknown field.
        expect(parseSse('\uFEFF\uFEFFdata: x\n\n').events).toEqual([])
    })

    it('keeps the last event id across events and ignores ids with NUL', () => {
        const { events, lastEventId } = parseSse('id: 4\ndata: a\n\ndata: b\n\nid: 5\u0000\ndata: c\n\n')
        expect(events.map((e) => e.id)).toEqual(['4', '4', '4'])
        expect(lastEventId).toBe('4')
        expect(parseSse('id: 9\n\n').lastEventId).toBe('9')
    })

    it('reports retry only for ASCII digits', () => {
        expect(parseSse('retry: 3000\n\n').retries).toEqual([3000])
        expect(parseSse('retry: 3s\nretry: -1\nretry: 1.5\n\n').retries).toEqual([])
    })

    it('reports comments and never dispatches them', () => {
        const { events, comments } = parseSse(': ping\n:\n:raw\n\n')
        expect(comments).toEqual(['ping', '', 'raw'])
        expect(events).toEqual([])
    })

    it('does not dispatch an event whose data buffer is empty', () => {
        expect(parseSse('event: reconnect\n\n').events).toEqual([])
        expect(parseSse('id: 3\nevent: x\n\n').events).toEqual([])
        // ...but an empty data field still counts as data.
        expect(parseSse('event: x\ndata:\n\n').events).toEqual([{ type: 'x', data: '', id: '' }])
    })

    it('resets the event type after each dispatch', () => {
        const { events } = parseSse('event: a\ndata: 1\n\ndata: 2\n\n')
        expect(events.map((e) => e.type)).toEqual(['a', 'message'])
    })

    it('handles a field with no colon and removes only one leading space', () => {
        expect(parseSse('data\n\n').events[0].data).toBe('')
        expect(parseSse('data:  two spaces\n\n').events[0].data).toBe(' two spaces')
        expect(parseSse('data:no space\n\n').events[0].data).toBe('no space')
        expect(parseSse('data: a:b:c\n\n').events[0].data).toBe('a:b:c')
    })

    it('ignores unknown fields', () => {
        expect(parseSse('foo: bar\ndata: x\nbaz\n\n').events).toEqual([{ type: 'message', data: 'x', id: '' }])
    })

    it('discards an unterminated event at the end of the stream', () => {
        const { parser, out } = collect()
        parser.feed('data: complete\n\ndata: partial\n')
        parser.end()
        expect(out.events.map((e) => e.data)).toEqual(['complete'])
    })

    it('handles a long line delivered in many chunks', () => {
        const payload = JSON.stringify({ text: 'x'.repeat(50000) })
        const { parser, out } = collect()
        const stream = `data: ${payload}\n\n`
        for (let i = 0; i < stream.length; i += 997) parser.feed(stream.slice(i, i + 997))
        expect(out.events).toHaveLength(1)
        expect(JSON.parse(out.events[0].data).text).toHaveLength(50000)
    })
})

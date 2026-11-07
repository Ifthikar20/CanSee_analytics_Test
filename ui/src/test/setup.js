// jsdom gaps shared by every spec. Only stubs the APIs jsdom lacks; specs that
// need behaviour (resize callbacks, media changes) install their own mocks.

if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (query) => ({
        matches: false,
        media: String(query),
        onchange: null,
        addEventListener() {},
        removeEventListener() {},
        addListener() {},
        removeListener() {},
        dispatchEvent() {
            return false
        },
    })
}

class ObserverStub {
    constructor(callback) {
        this.callback = callback
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
        return []
    }
}

if (typeof window.ResizeObserver !== 'function') {
    window.ResizeObserver = ObserverStub
    globalThis.ResizeObserver = ObserverStub
}

if (typeof window.IntersectionObserver !== 'function') {
    window.IntersectionObserver = ObserverStub
    globalThis.IntersectionObserver = ObserverStub
}

if (typeof window.requestAnimationFrame !== 'function') {
    window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16)
    window.cancelAnimationFrame = (id) => clearTimeout(id)
}
if (typeof globalThis.requestAnimationFrame !== 'function') {
    globalThis.requestAnimationFrame = window.requestAnimationFrame
    globalThis.cancelAnimationFrame = window.cancelAnimationFrame
}

// jsdom defines scrollTo but logs "not implemented"; replace it with a no-op.
window.scrollTo = () => {}
window.HTMLElement.prototype.scrollTo = function scrollTo(arg, y) {
    if (arg && typeof arg === 'object') {
        if (typeof arg.top === 'number') this.scrollTop = arg.top
        if (typeof arg.left === 'number') this.scrollLeft = arg.left
    } else if (typeof arg === 'number') {
        this.scrollLeft = arg
        if (typeof y === 'number') this.scrollTop = y
    }
}
window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {}

// The fixture posts as the blog modules see them, for specs outside this
// folder (the pages mock lib/blog/posts.js with these).
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPosts } from '../../content.js'

const HERE = dirname(fileURLToPath(import.meta.url))

export function fixtureFiles(name = 'posts') {
    const dir = join(HERE, name)
    return readdirSync(dir).map((f) => ({ path: join(dir, f), raw: readFileSync(join(dir, f), 'utf8') }))
}

export function fixturePosts(name = 'posts') {
    return loadPosts(fixtureFiles(name)).posts
}

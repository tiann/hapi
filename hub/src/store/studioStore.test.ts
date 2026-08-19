import { afterEach, describe, expect, it } from 'bun:test'
import { Store } from './index'

const stores: Store[] = []

afterEach(() => {
    for (const store of stores.splice(0)) store.close()
})

describe('StudioStore', () => {
    it('isolates owner lookup by namespace and revokes public tokens', () => {
        const store = new Store(':memory:')
        stores.push(store)
        store.sessions.getOrCreateSession('tag-a', {}, null, 'alpha', undefined, undefined, undefined, 'session-a')
        const room = store.studios.createOrActivateRoom('session-a', 'alpha', 'Room', 'contribute')

        expect(store.studios.getRoomById(room.id, 'beta')).toBeNull()
        expect(store.studios.getActiveRoomByToken(room.shareToken)?.id).toBe(room.id)
        expect(store.studios.revokeRoom(room.id, 'alpha')).toBe(true)
        expect(store.studios.getActiveRoomByToken(room.shareToken)).toBeNull()
        const reopened = store.studios.createOrActivateRoom('session-a', 'alpha', 'Room', 'contribute')
        expect(reopened.shareToken).not.toBe(room.shareToken)
        expect(store.studios.getActiveRoomByToken(room.shareToken)).toBeNull()
    })

    it('claims a suggestion once', () => {
        const store = new Store(':memory:')
        stores.push(store)
        store.sessions.getOrCreateSession('tag-a', {}, null, 'alpha', undefined, undefined, undefined, 'session-a')
        const room = store.studios.createOrActivateRoom('session-a', 'alpha', 'Room', 'contribute')
        const post = store.studios.createPost({
            roomId: room.id,
            guestId: 'guest-12345678',
            authorName: 'Guest',
            kind: 'suggestion',
            text: 'Test this'
        })

        expect(store.studios.decidePost(post.id, room.id, 'submitted', 'Edited')?.status).toBe('submitted')
        expect(store.studios.decidePost(post.id, room.id, 'submitted', 'Again')).toBeNull()
    })

    it('returns the newest posts when the room has more than the page limit', () => {
        const store = new Store(':memory:')
        stores.push(store)
        store.sessions.getOrCreateSession('tag-a', {}, null, 'alpha', undefined, undefined, undefined, 'session-a')
        const room = store.studios.createOrActivateRoom('session-a', 'alpha', 'Room', 'contribute')
        for (let index = 0; index < 205; index += 1) {
            store.studios.createPost({
                roomId: room.id,
                guestId: 'guest-12345678',
                authorName: 'Guest',
                kind: 'discussion',
                text: `post-${index}`,
                createdAt: index
            })
        }
        const posts = store.studios.listPosts(room.id)
        expect(posts).toHaveLength(200)
        expect(posts[0]?.text).toBe('post-5')
        expect(posts.at(-1)?.text).toBe('post-204')
    })
})

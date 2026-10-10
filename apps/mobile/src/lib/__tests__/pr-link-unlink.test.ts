import { unlinkPrLink } from '../pr-link-unlink'

const REF = { host: 'github' as const, owner: 'acme', name: 'app', number: 612 }

it('answers null once the backend unlinked it', async () => {
  const client = { unlinkPullRequest: jest.fn(async () => ({ ok: true as const })) }
  await expect(unlinkPrLink(client, 't1', REF)).resolves.toBeNull()
  expect(client.unlinkPullRequest).toHaveBeenCalledWith('t1', REF)
})

it("passes on the backend's refusal", async () => {
  const client = { unlinkPullRequest: async () => ({ ok: false as const, message: 'Not linked.' }) }
  await expect(unlinkPrLink(client, 't1', REF)).resolves.toBe('Not linked.')
})

it('names a missing connection and a failed request instead of doing nothing', async () => {
  await expect(unlinkPrLink(undefined, 't1', REF)).resolves.toMatch(/not open/)
  const client = {
    unlinkPullRequest: async () => {
      throw new Error('socket closed')
    },
  }
  await expect(unlinkPrLink(client, 't1', REF)).resolves.toMatch(/did not reach the backend/)
})

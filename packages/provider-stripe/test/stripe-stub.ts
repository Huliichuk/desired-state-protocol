import { providerError } from '@dsp/provider-sdk'
import { encodeParams, type StripeRequest, type StripeTransport } from '@dsp/provider-stripe'

/**
 * A stand-in for the Stripe API that enforces Stripe's documented rules rather than
 * agreeing with the provider.
 *
 * This is the point of it. A mock that accepts whatever the provider sends proves
 * nothing, because the provider and the mock share an author's assumptions. Every
 * rule below is taken from the Stripe API reference, and each one is capable of
 * rejecting a DSP design that is wrong:
 *
 *   - a price cannot be deleted, at all
 *   - an existing price accepts only `active`, `nickname` and `metadata`
 *   - a product cannot be deleted while any price references it
 *   - a product id must be unique in the account
 *   - a lookup key must be unique among active prices
 *   - a repeated Idempotency-Key returns the first result instead of writing again
 *
 * What it does not reproduce: network behaviour, rate limits, and Stripe's
 * eventually consistent search index. Those need the real API.
 */

interface StoredProduct {
  id: string
  object: 'product'
  name: string
  description: string | null
  active: boolean
  metadata: Record<string, string>
}

interface StoredPrice {
  id: string
  object: 'price'
  lookup_key: string | null
  product: string
  currency: string
  unit_amount: number | null
  recurring: { interval: string } | null
  active: boolean
  nickname: string | null
  metadata: Record<string, string>
}

const PRICE_MUTABLE_FIELDS = new Set(['active', 'nickname', 'metadata'])

export class StripeStub implements StripeTransport {
  readonly #products = new Map<string, StoredProduct>()
  readonly #prices = new Map<string, StoredPrice>()
  readonly #idempotency = new Map<string, unknown>()

  /** Every request, so a test can assert that a read path performed no writes. */
  readonly calls: Array<{ method: string; path: string; idempotencyKey?: string }> = []

  #sequence = 0

  async request<T>(input: StripeRequest): Promise<T> {
    input.signal.throwIfAborted()

    if (!input.apiKey.startsWith('sk_test_')) {
      throw providerError('Stripe rejected the request: invalid API key', { retryable: false })
    }

    this.calls.push({
      method: input.method,
      path: input.path,
      idempotencyKey: input.idempotencyKey,
    })

    // Stripe replays the first response for a repeated key rather than writing again.
    if (input.idempotencyKey !== undefined && input.method === 'POST') {
      const seen = this.#idempotency.get(input.idempotencyKey)
      if (seen !== undefined) return seen as T
    }

    const params = decode(input)
    const result = this.#route(input, params)

    if (input.idempotencyKey !== undefined && input.method === 'POST') {
      this.#idempotency.set(input.idempotencyKey, result)
    }
    return result as T
  }

  #route(input: StripeRequest, params: Record<string, unknown>): unknown {
    const { method, path } = input

    if (method === 'GET' && path === '/v1/products') return this.#listProducts(params)
    if (method === 'GET' && path === '/v1/prices') return this.#listPrices(params)
    if (method === 'POST' && path === '/v1/products') return this.#createProduct(params)
    if (method === 'POST' && path === '/v1/prices') return this.#createPrice(params)

    const productMatch = /^\/v1\/products\/(.+)$/.exec(path)
    if (productMatch?.[1] !== undefined) {
      const id = decodeURIComponent(productMatch[1])
      if (method === 'POST') return this.#updateProduct(id, params)
      if (method === 'DELETE') return this.#deleteProduct(id)
    }

    const priceMatch = /^\/v1\/prices\/(.+)$/.exec(path)
    if (priceMatch?.[1] !== undefined) {
      const id = decodeURIComponent(priceMatch[1])
      if (method === 'POST') return this.#updatePrice(id, params)
      if (method === 'DELETE') {
        // Stripe has no delete endpoint for a price. Not "returns an error" — the
        // route does not exist.
        throw reject(404, `Unrecognized request URL (DELETE: ${path})`)
      }
    }

    throw reject(404, `Unrecognized request URL (${method}: ${path})`)
  }

  #createProduct(params: Record<string, unknown>): StoredProduct {
    const id = params['id'] === undefined ? this.#id('prod') : String(params['id'])
    if (this.#products.has(id)) {
      throw reject(400, `Product already exists with the ID ${id}`)
    }
    if (params['name'] === undefined || String(params['name']) === '') {
      throw reject(400, 'Missing required param: name.')
    }

    const product: StoredProduct = {
      id,
      object: 'product',
      name: String(params['name']),
      description: params['description'] === undefined ? null : String(params['description']),
      active: params['active'] === undefined ? true : params['active'] === 'true',
      metadata: asStrings(params['metadata']),
    }
    this.#products.set(id, product)
    return product
  }

  #updateProduct(id: string, params: Record<string, unknown>): StoredProduct {
    const product = this.#products.get(id)
    if (product === undefined) throw reject(404, `No such product: '${id}'`)
    if (params['id'] !== undefined) throw reject(400, 'Received unknown parameter: id')

    if (params['name'] !== undefined) product.name = String(params['name'])
    if (params['description'] !== undefined) {
      product.description = params['description'] === '' ? null : String(params['description'])
    }
    if (params['active'] !== undefined) product.active = params['active'] === 'true'
    if (params['metadata'] !== undefined) product.metadata = asStrings(params['metadata'])
    return product
  }

  #deleteProduct(id: string): { id: string; deleted: true } {
    const product = this.#products.get(id)
    if (product === undefined) throw reject(404, `No such product: '${id}'`)

    const priced = [...this.#prices.values()].some((price) => price.product === id)
    if (priced) {
      throw reject(
        400,
        'This product cannot be deleted because it has one or more user-created prices. ' +
          'To deactivate it, set active=false.',
      )
    }
    this.#products.delete(id)
    return { id, deleted: true }
  }

  #createPrice(params: Record<string, unknown>): StoredPrice {
    for (const required of ['product', 'currency']) {
      if (params[required] === undefined) throw reject(400, `Missing required param: ${required}.`)
    }
    const product = String(params['product'])
    if (!this.#products.has(product)) throw reject(404, `No such product: '${product}'`)

    const lookupKey = params['lookup_key'] === undefined ? null : String(params['lookup_key'])
    if (lookupKey !== null) {
      const clash = [...this.#prices.values()].some(
        (price) => price.lookup_key === lookupKey && price.active,
      )
      if (clash) {
        throw reject(400, `A price with lookup_key '${lookupKey}' already exists and is active.`)
      }
    }

    const recurring = params['recurring'] as Record<string, unknown> | undefined
    const price: StoredPrice = {
      id: this.#id('price'),
      object: 'price',
      lookup_key: lookupKey,
      product,
      currency: String(params['currency']),
      unit_amount: params['unit_amount'] === undefined ? null : Number(params['unit_amount']),
      recurring: recurring === undefined ? null : { interval: String(recurring['interval']) },
      active: params['active'] === undefined ? true : params['active'] === 'true',
      nickname: params['nickname'] === undefined ? null : String(params['nickname']),
      metadata: asStrings(params['metadata']),
    }
    this.#prices.set(price.id, price)
    return price
  }

  #updatePrice(id: string, params: Record<string, unknown>): StoredPrice {
    const price = this.#prices.get(id)
    if (price === undefined) throw reject(404, `No such price: '${id}'`)

    // The rule that makes this stub worth having.
    const offending = Object.keys(params).filter((key) => !PRICE_MUTABLE_FIELDS.has(key))
    if (offending.length > 0) {
      throw reject(400, `Received unknown parameter: ${offending[0]}`)
    }

    if (params['active'] !== undefined) price.active = params['active'] === 'true'
    if (params['nickname'] !== undefined) {
      price.nickname = params['nickname'] === '' ? null : String(params['nickname'])
    }
    if (params['metadata'] !== undefined) price.metadata = asStrings(params['metadata'])
    return price
  }

  #listProducts(params: Record<string, unknown>): {
    object: 'list'
    data: StoredProduct[]
    has_more: boolean
  } {
    return paginate([...this.#products.values()], params)
  }

  #listPrices(params: Record<string, unknown>): {
    object: 'list'
    data: StoredPrice[]
    has_more: boolean
  } {
    let prices = [...this.#prices.values()]

    const wanted = asList(params['lookup_keys'])
    if (wanted.length > 0) {
      prices = prices.filter(
        (price) => price.lookup_key !== null && wanted.includes(price.lookup_key),
      )
    }
    return paginate(prices, params)
  }

  #id(prefix: string): string {
    this.#sequence += 1
    return `${prefix}_${String(this.#sequence).padStart(6, '0')}`
  }

  /** Test helpers. */
  seedProduct(product: Partial<StoredProduct> & { id: string }): void {
    this.#products.set(product.id, {
      object: 'product',
      name: product.name ?? product.id,
      description: product.description ?? null,
      active: product.active ?? true,
      metadata: product.metadata ?? {},
      id: product.id,
    })
  }

  productCount(): number {
    return this.#products.size
  }

  priceCount(): number {
    return this.#prices.size
  }

  price(lookupKey: string): StoredPrice | undefined {
    return [...this.#prices.values()].find((price) => price.lookup_key === lookupKey)
  }

  product(id: string): StoredProduct | undefined {
    return this.#products.get(id)
  }

  writes(): Array<{ method: string; path: string }> {
    return this.calls.filter((call) => call.method !== 'GET')
  }
}

function paginate<T extends { id: string }>(
  items: T[],
  params: Record<string, unknown>,
): { object: 'list'; data: T[]; has_more: boolean } {
  const sorted = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const after = params['starting_after']
  const start = after === undefined ? 0 : sorted.findIndex((item) => item.id === String(after)) + 1
  const limit = params['limit'] === undefined ? 10 : Number(params['limit'])
  const page = sorted.slice(start, start + limit)

  return { object: 'list', data: page, has_more: start + limit < sorted.length }
}

/**
 * Decodes the form encoding the provider produced, so the stub sees exactly the
 * shape Stripe would: nested keys, string values, and nothing else.
 */
function decode(input: StripeRequest): Record<string, unknown> {
  const encoded = encodeParams(input.params ?? {}).join('&')
  const flat = new URLSearchParams(encoded)
  const result: Record<string, unknown> = {}

  for (const [rawKey, value] of flat.entries()) {
    const nested = /^([^[]+)\[([^\]]*)\]$/.exec(rawKey)
    if (nested?.[1] === undefined) {
      result[rawKey] = value
      continue
    }
    const [, group, member] = nested
    const bucket = (result[group] ?? {}) as Record<string, unknown>
    bucket[member ?? ''] = value
    result[group] = bucket
  }
  return result
}

function asStrings(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object') return {}
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, String(item)]),
  )
}

function asList(value: unknown): string[] {
  if (value === undefined || value === null) return []
  if (typeof value !== 'object') return [String(value)]
  return Object.values(value as Record<string, unknown>).map(String)
}

function reject(status: number, message: string): Error {
  return providerError(`Stripe rejected the request: ${message}`, {
    retryable: status >= 500,
    details: { status },
  })
}

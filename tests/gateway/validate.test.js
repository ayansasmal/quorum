/**
 * Unit tests for gateway/src/shared/graph/validate.js
 *
 * Covers ValidationError class and validateKnowledgeInput() in full.
 * No I/O — pure function tests with no mocks required.
 */

import { describe, it, expect } from 'vitest'
import { ValidationError, validateKnowledgeInput } from '../../gateway/src/shared/graph/validate.js'

// ── Minimal valid fixture ─────────────────────────────────────────────────────

/** Smallest valid input: content + entity_type only. */
const MINIMAL = {
  content: 'A short description of the decision.',
  entity_type: 'Decision',
}

// ── ValidationError class ─────────────────────────────────────────────────────

describe('ValidationError', () => {
  it('carries field, message, and name', () => {
    const err = new ValidationError('content', 'too long')
    expect(err.name).toBe('ValidationError')
    expect(err.field).toBe('content')
    expect(err.message).toBe('too long')
    expect(err instanceof Error).toBe(true)
    expect(err instanceof ValidationError).toBe(true)
  })

  it('message is the short description passed to constructor', () => {
    const err = new ValidationError('topic', 'invalid chars')
    // The spec assigns this.message = message (the short string),
    // so err.message is the human-readable field message.
    expect(err.message).toBe('invalid chars')
    // The full detail lives in the Error super() call — accessible via stack / cause chain.
    expect(String(err)).toContain('ValidationError')
  })
})

// ── Valid inputs — no throw ───────────────────────────────────────────────────

describe('validateKnowledgeInput: valid inputs', () => {
  it('accepts minimal input (content + entity_type)', () => {
    expect(() => validateKnowledgeInput(MINIMAL)).not.toThrow()
  })

  it('accepts full valid input with all fields', () => {
    expect(() =>
      validateKnowledgeInput({
        topic: 'auth-strategy',
        key: 'use-jwt-es256',
        content: 'We use ES256 JWT tokens for all service-to-service authentication.',
        entity_type: 'Decision',
        tags: ['auth', 'security', 'jwt'],
        confidence: 0.9,
        reason: 'Agreed in architecture review on 2025-01-15.',
      }),
    ).not.toThrow()
  })

  it('accepts content of exactly 500 chars', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, content: 'a'.repeat(500) }),
    ).not.toThrow()
  })
})

// ── topic validation ──────────────────────────────────────────────────────────

describe('validateKnowledgeInput: topic', () => {
  it('throws when topic is an empty string', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, topic: '' })).toThrow(ValidationError)
    expect(() => validateKnowledgeInput({ ...MINIMAL, topic: '' })).toThrow(/topic/)
  })

  it('throws when topic contains uppercase letters', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, topic: 'Auth-Strategy' })).toThrow(ValidationError)
  })

  it('throws when topic contains spaces', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, topic: 'auth strategy' })).toThrow(ValidationError)
  })

  it('throws when topic exceeds 60 characters', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, topic: 'a'.repeat(61) }),
    ).toThrow(ValidationError)
  })

  it('accepts a valid topic slug', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, topic: 'auth-strategy-2' })).not.toThrow()
  })
})

// ── key validation ────────────────────────────────────────────────────────────

describe('validateKnowledgeInput: key', () => {
  it('throws when key is an empty string', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, key: '' })).toThrow(ValidationError)
  })

  it('throws when key contains an underscore', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, key: 'use_jwt' })).toThrow(ValidationError)
  })

  it('throws when key exceeds 80 characters', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, key: 'a'.repeat(81) }),
    ).toThrow(ValidationError)
  })

  it('accepts a valid key slug', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, key: 'use-jwt-es256' })).not.toThrow()
  })
})

// ── content validation ────────────────────────────────────────────────────────

describe('validateKnowledgeInput: content', () => {
  it('throws when content is missing', () => {
    expect(() => validateKnowledgeInput({ entity_type: 'Decision' })).toThrow(ValidationError)
  })

  it('throws when content is an empty string', () => {
    expect(() =>
      validateKnowledgeInput({ entity_type: 'Decision', content: '' }),
    ).toThrow(ValidationError)
  })

  it('throws when content exceeds 500 characters', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, content: 'a'.repeat(501) }),
    ).toThrow(ValidationError)
  })

  it('throws when content contains <', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, content: 'Use <strong> tags.' }),
    ).toThrow(ValidationError)
  })

  it('throws when content contains >', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, content: 'Value > threshold means alert.' }),
    ).toThrow(ValidationError)
  })
})

// ── entity_type validation ────────────────────────────────────────────────────

describe('validateKnowledgeInput: entity_type', () => {
  it('throws when entity_type is missing', () => {
    expect(() => validateKnowledgeInput({ content: 'Some content here.' })).toThrow(ValidationError)
  })

  it('throws when entity_type is an invalid value', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, entity_type: 'Rule' }),
    ).toThrow(ValidationError)
  })

  it('accepts Decision', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, entity_type: 'Decision' })).not.toThrow()
  })

  it('accepts Pattern', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, entity_type: 'Pattern' })).not.toThrow()
  })

  it('accepts Constraint', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, entity_type: 'Constraint' })).not.toThrow()
  })

  it('accepts Runbook', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, entity_type: 'Runbook' })).not.toThrow()
  })

  it('accepts Requirement', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, entity_type: 'Requirement' })).not.toThrow()
  })
})

// ── tags validation ───────────────────────────────────────────────────────────

describe('validateKnowledgeInput: tags', () => {
  it('accepts exactly 10 tags', () => {
    const tags = Array.from({ length: 10 }, (_, i) => `tag-${i}`)
    expect(() => validateKnowledgeInput({ ...MINIMAL, tags })).not.toThrow()
  })

  it('throws when tags has 11 items', () => {
    const tags = Array.from({ length: 11 }, (_, i) => `tag-${i}`)
    expect(() => validateKnowledgeInput({ ...MINIMAL, tags })).toThrow(ValidationError)
  })

  it('throws when a tag contains a space', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, tags: ['my tag'] }),
    ).toThrow(ValidationError)
  })

  it('throws when a tag exceeds 40 characters', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, tags: ['a'.repeat(41)] }),
    ).toThrow(ValidationError)
  })

  it('accepts a tag of exactly 40 characters', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, tags: ['a'.repeat(40)] }),
    ).not.toThrow()
  })
})

// ── confidence validation ─────────────────────────────────────────────────────

describe('validateKnowledgeInput: confidence', () => {
  it('accepts confidence of exactly 0.5', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, confidence: 0.5 })).not.toThrow()
  })

  it('accepts confidence of exactly 1.0', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, confidence: 1.0 })).not.toThrow()
  })

  it('throws when confidence is 0.49', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, confidence: 0.49 })).toThrow(ValidationError)
  })

  it('throws when confidence is 1.01', () => {
    expect(() => validateKnowledgeInput({ ...MINIMAL, confidence: 1.01 })).toThrow(ValidationError)
  })
})

// ── reason validation ─────────────────────────────────────────────────────────

describe('validateKnowledgeInput: reason', () => {
  it('throws when requireReason is true and reason is absent', () => {
    expect(() =>
      validateKnowledgeInput(MINIMAL, { requireReason: true }),
    ).toThrow(ValidationError)
  })

  it('throws when reason has 9 characters', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, reason: 'a'.repeat(9) }),
    ).toThrow(ValidationError)
  })

  it('accepts reason with exactly 10 characters', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, reason: 'a'.repeat(10) }),
    ).not.toThrow()
  })

  it('accepts reason with exactly 500 characters', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, reason: 'a'.repeat(500) }),
    ).not.toThrow()
  })

  it('throws when reason has 501 characters', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, reason: 'a'.repeat(501) }),
    ).toThrow(ValidationError)
  })

  it('throws when reason contains <', () => {
    expect(() =>
      validateKnowledgeInput({ ...MINIMAL, reason: 'Do not use <b> tags in output.' }),
    ).toThrow(ValidationError)
  })

  it('accepts reason when requireReason is true and reason is valid', () => {
    expect(() =>
      validateKnowledgeInput(
        { ...MINIMAL, reason: 'Agreed in architecture review.' },
        { requireReason: true },
      ),
    ).not.toThrow()
  })
})

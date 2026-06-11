/**
 * @file Structural checks for production systemd units and timers.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

/** Systemd directory under test. */
const directory = 'crossplane/bootstrap/systemd'

describe('S-DEPLOY systemd units', () => {
  it('defines five services and five timers', () => {
    const files = readdirSync(directory)
    expect(files.filter((file) => file.endsWith('.service'))).toHaveLength(5)
    expect(files.filter((file) => file.endsWith('.timer'))).toHaveLength(5)
  })

  it('gives every service an ExecStart', () => {
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.service'))) {
      expect(readFileSync(`${directory}/${file}`, 'utf8')).toContain('ExecStart=')
    }
  })

  it('gives every timer a Timer section', () => {
    for (const file of readdirSync(directory).filter((name) => name.endsWith('.timer'))) {
      expect(readFileSync(`${directory}/${file}`, 'utf8')).toContain('[Timer]')
    }
  })
})

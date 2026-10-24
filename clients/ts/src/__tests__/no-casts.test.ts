import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// A table's columns are typed against the row they show: `key: keyof Row`.
// Casting the column list (`as ColDef<Row>[]`) switches that check off, and
// that is how `flect invites` printed two empty columns for a month after the
// service renamed orgName to org_name — the compiler would have named both.
// The rule is stated here so a cast cannot come back unnoticed.
describe('the CLI keeps its tables type-checked', () => {
  it('casts no column list and no table options', () => {
    const src = readFileSync(new URL('../cli.ts', import.meta.url), 'utf8')
    expect(src.match(/as ColDef</g) ?? []).toEqual([])
    expect(src.match(/as TableOpts/g) ?? []).toEqual([])
  })
})

import { Command }                                                          from 'commander'
import { buildOrgCommand, buildWsCommand, buildProjCommand, buildEnvCommand, buildAccessCommand, addGlobalCommands } from '../cli.js'
import { createApiClient }                                                  from '@baseworks/cli/client'
import { createContextManager }                                             from '@baseworks/cli/context'
import { runCommand, createMocks, server }                                  from '@baseworks/cli/testing'

export { runCommand, server }

export const TEST_BASE = 'http://flect.test'

export const mocks = createMocks(TEST_BASE)

export function makeProgram(token = 'test-token') {
  const ctx  = createContextManager('org-test')
  const http = createApiClient(() => token, () => TEST_BASE)
  const deps = { http, ctx, appBase: TEST_BASE, cliName: 'flect' }

  const program = new Command('flect').exitOverride().enablePositionalOptions()
  addGlobalCommands(program, deps)
  program.addCommand(buildOrgCommand(deps))
  program.addCommand(buildWsCommand(deps))
  program.addCommand(buildProjCommand(deps))
  program.addCommand(buildEnvCommand(deps))
  program.addCommand(buildAccessCommand(deps))
  return program
}

export function run(args: string[]) {
  return runCommand(makeProgram(), args)
}

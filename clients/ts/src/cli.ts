import { Command } from 'commander';
import { clr, kv, table, summary, success, warn, fatal, printOutput, outputOption, prompt } from '@baseworks/cli/display';
import { fmtDate } from '@baseworks/cli/fmt';
import { tree }    from '@baseworks/cli/tree';
import type { ColDef, TableOpts } from '@baseworks/cli/display';
import type { TreeNode }          from '@baseworks/cli/tree';
import type { ApiClient }         from '@baseworks/cli/client';
import type { ContextManager }    from '@baseworks/cli/context';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OrgCliDeps {
  http:     ApiClient;
  ctx:      ContextManager<Record<string, string | undefined>>;
  appBase:  string;
  cliName?: string;
}

type OrgRow  = { id: string; short_id: string; slug: string; name: string; created_at?: number };
type OrgMeta = OrgRow & { metadata?: Record<string, unknown> };
type WsRow   = { id: string; short_id: string; slug: string; name: string; is_default?: boolean };
type ProjRow = { id: string; short_id: string; slug: string; name: string; is_default?: boolean };
type EnvRow  = { id: string; short_id: string; slug: string; name: string; is_default?: boolean };
type Membership = { id: string; org_id: string; user_id: string; role: string; created_at: number; updated_at: number };
type Invitation = { id: string; org_id: string; email: string; role: string; invited_by: string; created_at: number; updated_at: number; org_slug?: string; org_name?: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function activeOrgSlug(ctx: OrgCliDeps['ctx'], cliName: string, flagOrg?: string): string {
  return flagOrg
    ?? ctx.getContext()?.['org']
    ?? (ctx.loadConfig() as Record<string, unknown>)['activeOrg'] as string | undefined
    ?? fatal(`No active org. Run: ${cliName} use <org>`);
}

function activeWsSlug(ctx: OrgCliDeps['ctx'], cliName: string, flagWs?: string): string {
  return flagWs
    ?? ctx.getContext()?.['workspace']
    ?? fatal(`No active workspace. Run: ${cliName} use <org>/<ws>`);
}

function activeProjSlug(ctx: OrgCliDeps['ctx'], cliName: string, flagProj?: string): string {
  return flagProj
    ?? ctx.getContext()?.['project']
    ?? fatal(`No active project. Run: ${cliName} use <org>/<ws>/<proj>`);
}

// Merge an `ls` subcommand's own options with its parent noun command's. The
// `-o/--output` flag lands on the parent for non-positional commands (org) but
// on the child for positional ones (ws/proj/env); scope overrides (--org/--ws/
// --proj) land on whichever the user typed. Prefer a child value that differs
// from the default, else fall back to the parent — so `orgs ls -o wide` and
// `ws ls -o wide --org acme` both resolve correctly regardless of where the
// flag was parsed. (optsWithGlobals is unusable here: the parent's default
// 'table' overwrites the child's explicit value.)
function listOpts(cmd: Command): { output: string; org?: string; ws?: string; proj?: string } {
  const self   = cmd.opts()               as Record<string, string | undefined>;
  const parent = (cmd.parent?.opts() ?? {}) as Record<string, string | undefined>;
  return {
    output: self['output'] && self['output'] !== 'table' ? self['output']! : (parent['output'] ?? self['output'] ?? 'table'),
    org:    self['org']  ?? parent['org'],
    ws:     self['ws']   ?? parent['ws'],
    proj:   self['proj'] ?? parent['proj'],
  };
}

// ─── buildOrgCommand ──────────────────────────────────────────────────────────
// Mounts as: program.addCommand(buildOrgCommand(deps))
// Usage: flect org           → list
//        flect org create    → create
//        flect org get <slug>
//        flect org update <slug>
//        flect org delete <slug>
//        flect org meta ...

export function buildOrgCommand(deps: OrgCliDeps): Command {
  const { http, ctx } = deps;
  const cli = deps.cliName ?? 'cli';

  const listOrgs = async (opts: { output: string }) => {
    const res = await http.get<{ orgs: OrgMeta[] }>('/v1/orgs').catch(e => { console.error(e.message); process.exit(1); });
    printOutput(res.orgs, opts.output, (wide) => {
      table(res.orgs, [
        { key: 'short_id', label: 'ID' },
        { key: 'slug',    label: 'SLUG' },
        { key: 'name',    label: 'NAME' },
        { key: 'created_at', label: 'CREATED', wide: true, fmt: v => fmtDate(v as number) },
        { key: 'id',      label: 'FULL ID',  wide: true },
      ] as ColDef<OrgMeta>[], { wide, emptyHint: `No orgs yet.  Run: ${cli} org create --name <n>` });
      summary(`${res.orgs.length} org${res.orgs.length !== 1 ? 's' : ''}`);
    }, 'slug');
  };

  // `org` (bare) → list. Plural alias `orgs` and explicit `ls` subcommand both
  // run the same list, so `org`, `orgs`, `org ls`, and `orgs ls` are equivalent.
  const cmd = new Command('org')
    .alias('orgs')
    .description('Organization management')
    .option(...outputOption())
    .action(listOrgs);

  cmd.addCommand(
    new Command('ls')
      .description('List organizations (alias of the bare command)')
      .option(...outputOption())
      .action(function (this: Command) { return listOrgs(listOpts(this)); }),
  );

  cmd.addCommand(
    new Command('create')
      .description('Create a new organization')
      .requiredOption('--name <name>', 'Display name')
      .option('--slug <slug>', 'URL slug (auto-generated if omitted)')
      .action(async (opts: { name: string; slug?: string }) => {
        const res = await http.post<{ org: OrgRow }>('/v1/orgs', { name: opts.name, slug: opts.slug }).catch(e => { console.error(e.message); process.exit(1); });
        success(`Org created: ${res.org.slug}`);
        kv([['id', res.org.short_id], ['slug', res.org.slug]]);
      }),
  );

  cmd.addCommand(
    new Command('get').argument('<slug>')
      .description('Get org details')
      .option(...outputOption())
      .action(async (slug: string, opts: { output: string }) => {
        const res  = await http.get<{ org: OrgMeta }>(`/v1/orgs/${slug}`).catch(e => { console.error(e.message); process.exit(1); });
        const meta = res.org.metadata ?? {};
        printOutput(res.org as unknown as Record<string, unknown>, opts.output, () => {
          kv([['id', res.org.short_id], ['slug', res.org.slug], ['name', res.org.name], ['full_id', res.org.id]]);
          if (Object.keys(meta).length) {
            console.log(`  ${clr.dim}── metadata ──${clr.reset}`);
            kv(Object.entries(meta).map(([k, v]) => [k, JSON.stringify(v)] as [string, string]));
          }
        }, 'slug');
      }),
  );

  cmd.addCommand(
    new Command('update').argument('<slug>')
      .description('Update org name or slug')
      .option('--name <name>', 'New display name')
      .option('--slug <new-slug>', 'New URL slug')
      .action(async (slug: string, opts: { name?: string; slug?: string }) => {
        if (!opts.name && !opts.slug) { warn('Provide at least --name or --slug'); return; }
        const body: Record<string, string> = {};
        if (opts.name) body['name'] = opts.name;
        if (opts.slug) body['slug'] = opts.slug;
        const res = await http.patch<{ org: OrgRow }>(`/v1/orgs/${slug}`, body).catch(e => { console.error(e.message); process.exit(1); });
        success('Org updated.');
        kv([['id', res.org.short_id], ['slug', res.org.slug], ['name', res.org.name]]);
      }),
  );

  cmd.addCommand(
    new Command('delete').argument('<slug>')
      .description('Delete an organization')
      .action(async (slug: string) => {
        await http.del(`/v1/orgs/${slug}`).catch(e => { console.error(e.message); process.exit(1); });
        success(`Org deleted: ${slug}`);
      }),
  );

  // org meta sub-group
  const meta = new Command('meta').description('Manage org metadata');

  meta.addCommand(
    new Command('get').argument('<slug>').argument('[key]')
      .description('Show metadata (all or one key)')
      .action(async (slug: string, key?: string) => {
        const res  = await http.get<{ org: OrgMeta }>(`/v1/orgs/${slug}`).catch(e => { console.error(e.message); process.exit(1); });
        const m    = res.org.metadata ?? {};
        if (key) {
          const val = m[key];
          if (val === undefined) warn(`Key '${key}' not found.`);
          else console.log(`  ${clr.dim}${key}${clr.reset}  ${JSON.stringify(val)}`);
        } else if (!Object.keys(m).length) {
          console.log(`  ${clr.dim}(no metadata)${clr.reset}`);
        } else {
          kv(Object.entries(m).map(([k, v]) => [k, JSON.stringify(v)] as [string, string]));
        }
      }),
  );

  meta.addCommand(
    new Command('set').argument('<slug>').argument('<key>').argument('<value>')
      .description('Set a metadata key (JSON or string)')
      .action(async (slug: string, key: string, value: string) => {
        let parsed: unknown;
        try { parsed = JSON.parse(value); } catch { parsed = value; }
        await http.patch(`/v1/orgs/${slug}/metadata`, { [key]: parsed }).catch(e => { console.error(e.message); process.exit(1); });
        success(`Metadata key '${key}' set.`);
      }),
  );

  meta.addCommand(
    new Command('delete-key').argument('<slug>').argument('<key>')
      .description('Remove a metadata key')
      .action(async (slug: string, key: string) => {
        await http.del(`/v1/orgs/${slug}/metadata/${key}`).catch(e => { console.error(e.message); process.exit(1); });
        success(`Metadata key '${key}' deleted.`);
      }),
  );

  cmd.addCommand(meta);

  // ── members sub-group ───────────────────────────────────────────────────────
  // flect org members            → list members of the active org
  // flect org members add <uid>  → add a member directly (by user id)
  // flect org members rm  <uid>  → remove a member
  const listMembers = async (opts: { org?: string; output: string }) => {
    const orgSlug = activeOrgSlug(ctx, cli, opts.org);
    const res     = await http.get<{ members: Membership[] }>(`/v1/orgs/${orgSlug}/members`).catch(e => { console.error(e.message); process.exit(1); });
    printOutput(res.members, opts.output, (wide) => {
      table(res.members, [
        { key: 'user_id',   label: 'USER ID' },
        { key: 'role',      label: 'ROLE' },
        { key: 'created_at', label: 'JOINED', wide: true, fmt: v => fmtDate(v as number) },
        { key: 'id',        label: 'FULL ID', wide: true },
      ] as ColDef<Membership>[], { wide, emptyHint: `No members yet.` } as TableOpts & { wide: boolean });
      summary(`${res.members.length} member${res.members.length !== 1 ? 's' : ''}`);
    }, 'user_id');
  };

  const members = new Command('members')
    .aliases(['member'])
    .description('Manage org members')
    .enablePositionalOptions()
    .option('--org <slug>', 'Override active org')
    .option(...outputOption())
    .action(listMembers);

  members.addCommand(
    new Command('ls')
      .description('List members (alias of the bare command)')
      .option('--org <slug>', 'Override active org')
      .option(...outputOption())
      .action(function (this: Command) { return listMembers(listOpts(this)); }),
  );

  members.addCommand(
    new Command('add').argument('<userId>')
      .description('Add a member by user id')
      .option('--role <role>', 'owner | admin | member | viewer', 'member')
      .option('--org <slug>', 'Override active org')
      .action(async (userId: string, opts: { role: string; org?: string }) => {
        const orgSlug = activeOrgSlug(ctx, cli, opts.org);
        await http.post(`/v1/orgs/${orgSlug}/members`, { user_id: userId, role: opts.role }).catch(e => { console.error(e.message); process.exit(1); });
        success(`Member added: ${userId} (${opts.role})`);
      }),
  );

  members.addCommand(
    new Command('rm').aliases(['remove', 'delete']).argument('<userId>')
      .description('Remove a member')
      .option('--org <slug>', 'Override active org')
      .action(async (userId: string, opts: { org?: string }) => {
        const orgSlug = activeOrgSlug(ctx, cli, opts.org);
        await http.del(`/v1/orgs/${orgSlug}/members/${userId}`).catch(e => { console.error(e.message); process.exit(1); });
        success(`Member removed: ${userId}`);
      }),
  );

  cmd.addCommand(members);

  // ── invite (owner/admin) ────────────────────────────────────────────────────
  // flect org invite <email> --role  → send a pending invitation
  cmd.addCommand(
    new Command('invite').argument('<email>')
      .description('Invite a user to the org by email (they accept on next login)')
      .option('--role <role>', 'owner | admin | member | viewer', 'member')
      .option('--org <slug>', 'Override active org')
      .action(async (email: string, opts: { role: string; org?: string }) => {
        const orgSlug = activeOrgSlug(ctx, cli, opts.org);
        const res = await http.post<{ invitation: Invitation }>(`/v1/orgs/${orgSlug}/invitations`, { email, role: opts.role }).catch(e => { console.error(e.message); process.exit(1); });
        success(`Invitation sent to ${res.invitation.email} (${res.invitation.role})`);
        kv([['id', res.invitation.id], ['email', res.invitation.email], ['role', res.invitation.role]]);
      }),
  );

  // ── invites sub-group (owner/admin) ─────────────────────────────────────────
  // flect org invites            → list pending invitations for the active org
  // flect org invites revoke <id>
  const listOrgInvites = async (opts: { org?: string; output: string }) => {
    const orgSlug = activeOrgSlug(ctx, cli, opts.org);
    const res     = await http.get<{ invitations: Invitation[] }>(`/v1/orgs/${orgSlug}/invitations`).catch(e => { console.error(e.message); process.exit(1); });
    printOutput(res.invitations, opts.output, (wide) => {
      table(res.invitations, [
        { key: 'email',     label: 'EMAIL' },
        { key: 'role',      label: 'ROLE' },
        { key: 'invited_by', label: 'INVITED BY', wide: true },
        { key: 'created_at', label: 'SENT', wide: true, fmt: v => fmtDate(v as number) },
        { key: 'id',        label: 'ID' },
      ] as ColDef<Invitation>[], { wide, emptyHint: `No pending invitations.  Run: ${cli} org invite <email>` } as TableOpts & { wide: boolean });
      summary(`${res.invitations.length} pending invitation${res.invitations.length !== 1 ? 's' : ''}`);
    }, 'email');
  };

  const invites = new Command('invites')
    .description('Pending invitations for the org')
    .enablePositionalOptions()
    .option('--org <slug>', 'Override active org')
    .option(...outputOption())
    .action(listOrgInvites);

  invites.addCommand(
    new Command('ls')
      .description('List pending invitations (alias of the bare command)')
      .option('--org <slug>', 'Override active org')
      .option(...outputOption())
      .action(function (this: Command) { return listOrgInvites(listOpts(this)); }),
  );

  invites.addCommand(
    new Command('revoke').aliases(['rm', 'delete']).argument('<id>')
      .description('Revoke a pending invitation')
      .option('--org <slug>', 'Override active org')
      .action(async (id: string, opts: { org?: string }) => {
        const orgSlug = activeOrgSlug(ctx, cli, opts.org);
        await http.del(`/v1/orgs/${orgSlug}/invitations/${id}`).catch(e => { console.error(e.message); process.exit(1); });
        success(`Invitation revoked: ${id}`);
      }),
  );

  cmd.addCommand(invites);
  return cmd;
}

// ─── buildInvitesCommand ──────────────────────────────────────────────────────
// Invitee-facing, top-level. Matched on the caller's token email server-side.
// Usage: flect invites             → list my pending invitations
//        flect invites accept <id> → accept one (join the org)
export function buildInvitesCommand(deps: OrgCliDeps): Command {
  const { http } = deps;
  const cli = deps.cliName ?? 'cli';

  const listMine = async (opts: { output: string }) => {
    const res = await http.get<{ invitations: Invitation[] }>('/v1/invitations').catch(e => { console.error(e.message); process.exit(1); });
    printOutput(res.invitations, opts.output, (wide) => {
      table(res.invitations, [
        { key: 'orgName',   label: 'ORG' },
        { key: 'orgSlug',   label: 'SLUG' },
        { key: 'role',      label: 'ROLE' },
        { key: 'invited_by', label: 'INVITED BY', wide: true },
        { key: 'created_at', label: 'SENT', wide: true, fmt: v => fmtDate(v as number) },
        { key: 'id',        label: 'ID' },
      ] as ColDef<Invitation>[], { wide, emptyHint: `No invitations for you.` } as TableOpts & { wide: boolean });
      summary(`${res.invitations.length} invitation${res.invitations.length !== 1 ? 's' : ''} — accept with: ${cli} invites accept <id>`);
    }, 'id');
  };

  const cmd = new Command('invites')
    .description('Invitations addressed to you')
    .enablePositionalOptions()
    .option(...outputOption())
    .action(listMine);

  cmd.addCommand(
    new Command('ls')
      .description('List my invitations (alias of the bare command)')
      .option(...outputOption())
      .action(function (this: Command) { return listMine(listOpts(this)); }),
  );

  cmd.addCommand(
    new Command('accept').argument('<id>')
      .description('Accept an invitation and join the org')
      .action(async (id: string) => {
        const res = await http.post<{ member: Membership }>(`/v1/invitations/${id}/accept`, {}).catch(e => { console.error(e.message); process.exit(1); });
        success(`Joined org as ${res.member.role}.`);
        kv([['org_id', res.member.org_id], ['role', res.member.role]]);
      }),
  );

  return cmd;
}

// ─── buildWsCommand ───────────────────────────────────────────────────────────
// Usage: flect ws            → list (requires active org)
//        flect ws create
//        flect ws delete <slug>

export function buildWsCommand(deps: OrgCliDeps): Command {
  const { http, ctx } = deps;
  const cli = deps.cliName ?? 'cli';

  const listWs = async (opts: { org?: string; output: string }) => {
    const orgSlug = activeOrgSlug(ctx, cli, opts.org);
    const res     = await http.get<{ workspaces: WsRow[] }>(`/v1/orgs/${orgSlug}/workspaces`).catch(e => { console.error(e.message); process.exit(1); });
    printOutput(res.workspaces, opts.output, (wide) => {
      table(res.workspaces, [
        { key: 'short_id',   label: 'ID' },
        { key: 'slug',      label: 'SLUG' },
        { key: 'name',      label: 'NAME' },
        { key: 'is_default', label: 'DEFAULT', fmt: v => v ? '✓' : '' },
        { key: 'id',        label: 'FULL ID',  wide: true },
      ] as ColDef<WsRow>[], { wide, emptyHint: `No workspaces yet.  Run: ${cli} ws create --name <n>` } as TableOpts & { wide: boolean });
      summary(`${res.workspaces.length} workspace${res.workspaces.length !== 1 ? 's' : ''}`);
    }, 'slug');
  };

  const cmd = new Command('ws')
    .aliases(['workspace', 'workspaces'])
    .description('Workspace management')
    .enablePositionalOptions()
    .option('--org <slug>', 'Override active org')
    .option(...outputOption())
    .action(listWs);

  cmd.addCommand(
    new Command('ls')
      .description('List workspaces (alias of the bare command)')
      .option('--org <slug>', 'Override active org')
      .option(...outputOption())
      .action(function (this: Command) { return listWs(listOpts(this)); }),
  );

  cmd.addCommand(
    new Command('create')
      .description('Create a workspace')
      .requiredOption('--name <name>', 'Display name')
      .option('--slug <slug>', 'URL slug (auto-generated if omitted)')
      .option('--org <slug>', 'Override active org')
      .action(async (opts: { name: string; slug?: string; org?: string }) => {
        const orgSlug = activeOrgSlug(ctx, cli, opts.org);
        const res     = await http.post<{ workspace: WsRow }>(`/v1/orgs/${orgSlug}/workspaces`, { name: opts.name, slug: opts.slug }).catch(e => { console.error(e.message); process.exit(1); });
        success(`Workspace created: ${res.workspace.slug}`);
        kv([['id', res.workspace.short_id], ['slug', res.workspace.slug]]);
      }),
  );

  cmd.addCommand(
    new Command('get').argument('<ref>')
      .description('Get workspace details')
      .option('--org <slug>', 'Override active org')
      .option(...outputOption())
      .action(async (ref: string, opts: { org?: string; output: string }) => {
        const orgSlug = activeOrgSlug(ctx, cli, opts.org);
        const res = await http.get<{ workspace: WsRow }>(`/v1/orgs/${orgSlug}/workspaces/${ref}`).catch(e => { console.error(e.message); process.exit(1); });
        printOutput(res.workspace as unknown as Record<string, unknown>, opts.output, () => {
          kv([['id', res.workspace.short_id], ['slug', res.workspace.slug], ['name', res.workspace.name], ['full_id', res.workspace.id]]);
        }, 'slug');
      }),
  );

  cmd.addCommand(
    new Command('update').argument('<ref>')
      .description('Update a workspace')
      .option('--name <name>', 'New display name')
      .option('--slug <new-slug>', 'New URL slug')
      .option('--org <slug>', 'Override active org')
      .action(async (ref: string, opts: { name?: string; slug?: string; org?: string }) => {
        if (!opts.name && !opts.slug) { warn('Provide at least --name or --slug'); return; }
        const orgSlug = activeOrgSlug(ctx, cli, opts.org);
        const body: Record<string, string> = {};
        if (opts.name) body['name'] = opts.name;
        if (opts.slug) body['slug'] = opts.slug;
        const res = await http.patch<{ workspace: WsRow }>(`/v1/orgs/${orgSlug}/workspaces/${ref}`, body).catch(e => { console.error(e.message); process.exit(1); });
        success('Workspace updated.');
        kv([['id', res.workspace.short_id], ['slug', res.workspace.slug], ['name', res.workspace.name]]);
      }),
  );

  cmd.addCommand(
    new Command('delete').argument('<ref>')
      .description('Delete a workspace')
      .option('--org <slug>', 'Override active org')
      .action(async (ref: string, opts: { org?: string }) => {
        const orgSlug = activeOrgSlug(ctx, cli, opts.org);
        await http.del(`/v1/orgs/${orgSlug}/workspaces/${ref}`).catch(e => { console.error(e.message); process.exit(1); });
        success(`Workspace deleted: ${ref}`);
      }),
  );

  return cmd;
}

// ─── buildProjCommand ─────────────────────────────────────────────────────────
// Usage: flect proj          → list (requires active org + ws)
//        flect proj create
//        flect proj delete <slug>

export function buildProjCommand(deps: OrgCliDeps): Command {
  const { http, ctx } = deps;
  const cli = deps.cliName ?? 'cli';

  const listProj = async (opts: { org?: string; ws?: string; output: string }) => {
    const orgSlug = activeOrgSlug(ctx, cli, opts.org);
    const wsSlug  = activeWsSlug(ctx, cli, opts.ws);
    const res     = await http.get<{ projects: ProjRow[] }>(`/v1/orgs/${orgSlug}/workspaces/${wsSlug}/projects`).catch(e => { console.error(e.message); process.exit(1); });
    printOutput(res.projects, opts.output, (wide) => {
      table(res.projects, [
        { key: 'short_id',   label: 'ID' },
        { key: 'slug',      label: 'SLUG' },
        { key: 'name',      label: 'NAME' },
        { key: 'is_default', label: 'DEFAULT', fmt: v => v ? '✓' : '' },
        { key: 'id',        label: 'FULL ID',  wide: true },
      ] as ColDef<ProjRow>[], { wide, emptyHint: `No projects yet.  Run: ${cli} proj create --name <n>` } as TableOpts & { wide: boolean });
      summary(`${res.projects.length} project${res.projects.length !== 1 ? 's' : ''}`);
    }, 'slug');
  };

  const cmd = new Command('proj')
    .aliases(['project', 'projects'])
    .description('Project management')
    .enablePositionalOptions()
    .option('--org <slug>', 'Override active org')
    .option('--ws <slug>',  'Override active workspace')
    .option(...outputOption())
    .action(listProj);

  cmd.addCommand(
    new Command('ls')
      .description('List projects (alias of the bare command)')
      .option('--org <slug>', 'Override active org')
      .option('--ws <slug>',  'Override active workspace')
      .option(...outputOption())
      .action(function (this: Command) { return listProj(listOpts(this)); }),
  );

  cmd.addCommand(
    new Command('create')
      .description('Create a project')
      .requiredOption('--name <name>', 'Display name')
      .option('--slug <slug>', 'URL slug (auto-generated if omitted)')
      .option('--org <slug>', 'Override active org')
      .option('--ws <slug>',  'Override active workspace')
      .action(async (opts: { name: string; slug?: string; org?: string; ws?: string }) => {
        const orgSlug = activeOrgSlug(ctx, cli, opts.org);
        const wsSlug  = activeWsSlug(ctx, cli, opts.ws);
        const res     = await http.post<{ project: ProjRow }>(`/v1/orgs/${orgSlug}/workspaces/${wsSlug}/projects`, { name: opts.name, slug: opts.slug }).catch(e => { console.error(e.message); process.exit(1); });
        success(`Project created: ${res.project.slug}`);
        kv([['id', res.project.short_id], ['slug', res.project.slug]]);
      }),
  );

  cmd.addCommand(
    new Command('get').argument('<ref>')
      .description('Get project details')
      .option('--org <slug>', 'Override active org')
      .option('--ws <slug>',  'Override active workspace')
      .option(...outputOption())
      .action(async (ref: string, opts: { org?: string; ws?: string; output: string }) => {
        const orgSlug = activeOrgSlug(ctx, cli, opts.org);
        const wsSlug  = activeWsSlug(ctx, cli, opts.ws);
        const res = await http.get<{ project: ProjRow }>(`/v1/orgs/${orgSlug}/workspaces/${wsSlug}/projects/${ref}`).catch(e => { console.error(e.message); process.exit(1); });
        printOutput(res.project as unknown as Record<string, unknown>, opts.output, () => {
          kv([['id', res.project.short_id], ['slug', res.project.slug], ['name', res.project.name], ['full_id', res.project.id]]);
        }, 'slug');
      }),
  );

  cmd.addCommand(
    new Command('update').argument('<ref>')
      .description('Update a project')
      .option('--name <name>', 'New display name')
      .option('--slug <new-slug>', 'New URL slug')
      .option('--default', 'Set as default project')
      .option('--org <slug>', 'Override active org')
      .option('--ws <slug>',  'Override active workspace')
      .action(async (ref: string, opts: { name?: string; slug?: string; default?: boolean; org?: string; ws?: string }) => {
        if (!opts.name && !opts.slug && !opts.default) { warn('Provide at least --name, --slug, or --default'); return; }
        const orgSlug = activeOrgSlug(ctx, cli, opts.org);
        const wsSlug  = activeWsSlug(ctx, cli, opts.ws);
        const body: Record<string, unknown> = {};
        if (opts.name) body['name'] = opts.name;
        if (opts.slug) body['slug'] = opts.slug;
        if (opts.default) body['is_default'] = true;
        const res = await http.patch<{ project: ProjRow }>(`/v1/orgs/${orgSlug}/workspaces/${wsSlug}/projects/${ref}`, body).catch(e => { console.error(e.message); process.exit(1); });
        success('Project updated.');
        kv([['id', res.project.short_id], ['slug', res.project.slug], ['name', res.project.name], ['default', res.project.is_default ? '✓' : '']]);
      }),
  );

  cmd.addCommand(
    new Command('delete').argument('<ref>')
      .description('Delete a project')
      .option('--org <slug>', 'Override active org')
      .option('--ws <slug>',  'Override active workspace')
      .action(async (ref: string, opts: { org?: string; ws?: string }) => {
        const orgSlug = activeOrgSlug(ctx, cli, opts.org);
        const wsSlug  = activeWsSlug(ctx, cli, opts.ws);
        await http.del(`/v1/orgs/${orgSlug}/workspaces/${wsSlug}/projects/${ref}`).catch(e => { console.error(e.message); process.exit(1); });
        success(`Project deleted: ${ref}`);
      }),
  );

  return cmd;
}

// ─── buildEnvCommand ──────────────────────────────────────────────────────────
// Usage: flect env            → list (requires active org + ws + proj)
//        flect env create
//        flect env get <ref>
//        flect env update <ref>
//        flect env delete <ref>

export function buildEnvCommand(deps: OrgCliDeps): Command {
  const { http, ctx } = deps;
  const cli = deps.cliName ?? 'cli';

  function basePath(orgSlug: string, wsSlug: string, projSlug: string) {
    return `/v1/orgs/${orgSlug}/workspaces/${wsSlug}/projects/${projSlug}/envs`;
  }

  const listEnv = async (opts: { org?: string; ws?: string; proj?: string; output: string }) => {
    const orgSlug  = activeOrgSlug(ctx, cli, opts.org);
    const wsSlug   = activeWsSlug(ctx, cli, opts.ws);
    const projSlug = activeProjSlug(ctx, cli, opts.proj);
    const res = await http.get<{ envs: EnvRow[] }>(basePath(orgSlug, wsSlug, projSlug)).catch(e => { console.error(e.message); process.exit(1); });
    printOutput(res.envs, opts.output, (wide) => {
      table(res.envs, [
        { key: 'short_id',   label: 'ID' },
        { key: 'slug',      label: 'SLUG' },
        { key: 'name',      label: 'NAME' },
        { key: 'is_default', label: 'DEFAULT', fmt: v => v ? '✓' : '' },
        { key: 'id',        label: 'FULL ID',  wide: true },
      ] as ColDef<EnvRow>[], { wide, emptyHint: `No envs yet.  Run: ${cli} env create --name <n>` } as TableOpts & { wide: boolean });
      summary(`${res.envs.length} env${res.envs.length !== 1 ? 's' : ''}`);
    }, 'slug');
  };

  const cmd = new Command('env')
    .alias('envs')
    .description('Environment management')
    .enablePositionalOptions()
    .option('--org <slug>',  'Override active org')
    .option('--ws <slug>',   'Override active workspace')
    .option('--proj <slug>', 'Override active project')
    .option(...outputOption())
    .action(listEnv);

  cmd.addCommand(
    new Command('ls')
      .description('List environments (alias of the bare command)')
      .option('--org <slug>',  'Override active org')
      .option('--ws <slug>',   'Override active workspace')
      .option('--proj <slug>', 'Override active project')
      .option(...outputOption())
      .action(function (this: Command) { return listEnv(listOpts(this)); }),
  );

  cmd.addCommand(
    new Command('create')
      .description('Create an environment')
      .requiredOption('--name <name>', 'Display name')
      .option('--slug <slug>', 'URL slug (auto-generated if omitted)')
      .option('--org <slug>',  'Override active org')
      .option('--ws <slug>',   'Override active workspace')
      .option('--proj <slug>', 'Override active project')
      .action(async (opts: { name: string; slug?: string; org?: string; ws?: string; proj?: string }) => {
        const orgSlug  = activeOrgSlug(ctx, cli, opts.org);
        const wsSlug   = activeWsSlug(ctx, cli, opts.ws);
        const projSlug = activeProjSlug(ctx, cli, opts.proj);
        const res = await http.post<{ env: EnvRow }>(basePath(orgSlug, wsSlug, projSlug), { name: opts.name, slug: opts.slug }).catch(e => { console.error(e.message); process.exit(1); });
        success(`Env created: ${res.env.slug}`);
        kv([['id', res.env.short_id], ['slug', res.env.slug]]);
      }),
  );

  cmd.addCommand(
    new Command('get').argument('<ref>')
      .description('Get environment details')
      .option('--org <slug>',  'Override active org')
      .option('--ws <slug>',   'Override active workspace')
      .option('--proj <slug>', 'Override active project')
      .option(...outputOption())
      .action(async (ref: string, opts: { org?: string; ws?: string; proj?: string; output: string }) => {
        const orgSlug  = activeOrgSlug(ctx, cli, opts.org);
        const wsSlug   = activeWsSlug(ctx, cli, opts.ws);
        const projSlug = activeProjSlug(ctx, cli, opts.proj);
        const res = await http.get<{ env: EnvRow }>(`${basePath(orgSlug, wsSlug, projSlug)}/${ref}`).catch(e => { console.error(e.message); process.exit(1); });
        printOutput(res.env as unknown as Record<string, unknown>, opts.output, () => {
          kv([['id', res.env.short_id], ['slug', res.env.slug], ['name', res.env.name], ['full_id', res.env.id]]);
        }, 'slug');
      }),
  );

  cmd.addCommand(
    new Command('update').argument('<ref>')
      .description('Update an environment')
      .option('--name <name>', 'New display name')
      .option('--slug <new-slug>', 'New URL slug')
      .option('--org <slug>',  'Override active org')
      .option('--ws <slug>',   'Override active workspace')
      .option('--proj <slug>', 'Override active project')
      .action(async (ref: string, opts: { name?: string; slug?: string; org?: string; ws?: string; proj?: string }) => {
        if (!opts.name && !opts.slug) { warn('Provide at least --name or --slug'); return; }
        const orgSlug  = activeOrgSlug(ctx, cli, opts.org);
        const wsSlug   = activeWsSlug(ctx, cli, opts.ws);
        const projSlug = activeProjSlug(ctx, cli, opts.proj);
        const body: Record<string, string> = {};
        if (opts.name) body['name'] = opts.name;
        if (opts.slug) body['slug'] = opts.slug;
        const res = await http.patch<{ env: EnvRow }>(`${basePath(orgSlug, wsSlug, projSlug)}/${ref}`, body).catch(e => { console.error(e.message); process.exit(1); });
        success('Env updated.');
        kv([['id', res.env.short_id], ['slug', res.env.slug], ['name', res.env.name]]);
      }),
  );

  cmd.addCommand(
    new Command('delete').argument('<ref>')
      .description('Delete an environment')
      .option('--org <slug>',  'Override active org')
      .option('--ws <slug>',   'Override active workspace')
      .option('--proj <slug>', 'Override active project')
      .action(async (ref: string, opts: { org?: string; ws?: string; proj?: string }) => {
        const orgSlug  = activeOrgSlug(ctx, cli, opts.org);
        const wsSlug   = activeWsSlug(ctx, cli, opts.ws);
        const projSlug = activeProjSlug(ctx, cli, opts.proj);
        await http.del(`${basePath(orgSlug, wsSlug, projSlug)}/${ref}`).catch(e => { console.error(e.message); process.exit(1); });
        success(`Env deleted: ${ref}`);
      }),
  );

  return cmd;
}

// ─── addGlobalCommands ────────────────────────────────────────────────────────
// Adds use / ls / ps directly onto the root program.
// Usage: flect use [org/ws/proj]
//        flect ls
//        flect ps

export function addGlobalCommands(program: Command, deps: OrgCliDeps): void {
  const { http, ctx } = deps;
  const cli = deps.cliName ?? 'cli';

  program.addCommand(
    new Command('use')
      .alias('context')
      .description('Set active org / workspace / project (interactive if no arg)')
      .argument('[path]', 'org  or  org/ws  or  org/ws/proj')
      .action(async (path?: string) => {
        await runUseCommand(http, ctx, path);
      }),
  );

  program.addCommand(
    new Command('ls')
      .description('Tree view of all orgs, workspaces, and projects')
      .action(async () => {
        const ctxData    = ctx.getContext() as Record<string, string | undefined> | undefined;
        const activeOrg  = ctxData?.['org'];
        const activeWs   = ctxData?.['workspace'];
        const activeProj = ctxData?.['project'];

        const { orgs } = await http.get<{ orgs: OrgRow[] }>('/v1/orgs').catch(e => { console.error(e.message); process.exit(1); });

        let totalWs   = 0;
        let totalProj = 0;

        const nodes: TreeNode[] = await Promise.all(
          orgs.map(async (org) => {
            const { workspaces } = await http.get<{ workspaces: WsRow[] }>(`/v1/orgs/${org.slug}/workspaces`);
            totalWs += workspaces.length;

            const wsNodes: TreeNode[] = await Promise.all(
              workspaces.map(async (ws) => {
                const { projects } = await http.get<{ projects: ProjRow[] }>(`/v1/orgs/${org.slug}/workspaces/${ws.slug}/projects`);
                totalProj += projects.length;
                const isActiveWs = org.slug === activeOrg && ws.slug === activeWs;
                return {
                  label:    isActiveWs ? clr.bold + ws.slug + clr.reset : ws.slug,
                  badge:    isActiveWs ? clr.cyan + '●' + clr.reset : undefined,
                  children: projects.map(p => {
                    const isActiveProj = isActiveWs && p.slug === activeProj;
                    return {
                      label: isActiveProj ? clr.bold + p.slug + clr.reset : p.slug,
                      badge: isActiveProj ? clr.green + '●' + clr.reset : undefined,
                    };
                  }),
                };
              }),
            );

            const isActiveOrg = org.slug === activeOrg;
            return {
              label:    isActiveOrg ? clr.bold + org.slug + clr.reset : org.slug,
              badge:    isActiveOrg ? clr.cyan + '★' + clr.reset : undefined,
              meta:     org.name && org.name !== org.slug ? org.name : undefined,
              children: wsNodes,
            };
          }),
        );

        console.log();
        tree(nodes);
        console.log();
        console.log(
          `  ${clr.dim}${orgs.length} org${orgs.length !== 1 ? 's' : ''}` +
          `  ·  ${totalWs} workspace${totalWs !== 1 ? 's' : ''}` +
          `  ·  ${totalProj} project${totalProj !== 1 ? 's' : ''}` +
          (activeOrg ? `  ·  active: ${clr.bold}${activeOrg}/${activeWs}/${activeProj}${clr.reset}${clr.dim}` : '') +
          clr.reset,
        );
        console.log();
      }),
  );

  program.addCommand(
    new Command('ps')
      .description('Show active session (context, token, api endpoint)')
      .action(() => {
        const ctxData = ctx.getContext() as Record<string, string | undefined> | undefined;
        const cfg     = ctx.loadConfig() as Record<string, unknown>;
        const token   = (cfg['token'] as string | undefined)
          ?? Object.values((cfg['orgs'] as Record<string, { token?: string }> | undefined) ?? {})
            .find(e => e?.token)?.token;
        const apiBase = (cfg['apiBase'] as string | undefined) ?? deps.appBase;

        console.log();
        if (ctxData?.['org']) {
          console.log(
            `  ${clr.dim}context${clr.reset}   ` +
            `${clr.bold}${ctxData['org']}${clr.reset}` +
            ` ${clr.dim}/${clr.reset} ${ctxData['workspace'] ?? '—'}` +
            ` ${clr.dim}/${clr.reset} ${ctxData['project'] ?? '—'}` +
            `  ${clr.green}● active${clr.reset}`,
          );
        } else {
          console.log(`  ${clr.dim}context${clr.reset}   ${clr.yellow}not set${clr.reset}  ${clr.dim}(run: ${cli} use)${clr.reset}`);
        }
        if (token) {
          console.log(`  ${clr.dim}token  ${clr.reset}   ${clr.cyan}${token.slice(0, 14)}…${clr.reset}`);
        } else {
          console.log(`  ${clr.dim}token  ${clr.reset}   ${clr.yellow}none${clr.reset}  ${clr.dim}(run: ${cli} login)${clr.reset}`);
        }
        console.log(`  ${clr.dim}api    ${clr.reset}   ${clr.dim}${apiBase}${clr.reset}`);
        console.log(`  ${clr.dim}config ${clr.reset}   ${clr.dim}${ctx.configPath}${clr.reset}`);
        console.log();
      }),
  );
}

// ─── buildAccessCommand (the PDP) ──────────────────────────────────────────────
// Usage: flect access role <scope> [--user <id>]
//        flect access check <app> <action> <scope> [--user <id>]
//        flect access app list
//        flect access app policies <name>

type AppRow    = { name: string; origin: string };
type PolicyRow = { action: string; minRole: string };

export function buildAccessCommand(deps: OrgCliDeps): Command {
  const { http } = deps;
  const die = (e: unknown): never => { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); };

  const cmd = new Command('access').description('Access decisions & app policies (PDP)');

  cmd.addCommand(
    new Command('role').argument('<scope>')
      .description('Effective role of a user at a scope (org role, inherited)')
      .option('--user <id>', 'Target user (default: you)')
      .action(async (scope: string, opts: { user?: string }) => {
        const q   = new URLSearchParams({ scope, ...(opts.user ? { user: opts.user } : {}) });
        const res = await http.get<{ role: string; via?: { scopeKind: string } }>(`/authz/role?${q}`).catch(die);
        kv([['role', res.role], ['via', res.via ? res.via.scopeKind : '—']]);
      }),
  );

  cmd.addCommand(
    new Command('check').argument('<app>').argument('<action>').argument('<scope>')
      .description('Ask the PDP whether an app action is allowed at a scope')
      .option('--user <id>', 'Target user (default: you)')
      .action(async (app: string, action: string, scope: string, opts: { user?: string }) => {
        const res = await http.post<{ allowed: boolean; role: string; minRole?: string; reason?: string }>(
          '/authz/check',
          { app, action, scope_id: scope, ...(opts.user ? { user_id: opts.user } : {}) },
        ).catch(die);
        kv([
          ['allowed', res.allowed ? 'yes' : 'no'],
          ['your role', res.role],
          ['required', res.minRole ?? '—'],
          ...(res.reason ? [['reason', res.reason] as [string, string]] : []),
        ]);
        if (!res.allowed) process.exit(1); // non-zero so `if flect access check …` works in scripts
      }),
  );

  const appCmd = new Command('app').description('Registered apps & their policies');

  appCmd.addCommand(
    new Command('list').description('Apps registered with the PDP')
      .option(...outputOption())
      .action(async (opts: { output: string }) => {
        const res = await http.get<{ apps: AppRow[] }>('/apps').catch(die);
        printOutput(res.apps, opts.output, () =>
          table(res.apps, [{ key: 'name', label: 'APP' }, { key: 'origin', label: 'ORIGIN' }] as ColDef<AppRow>[]),
        );
      }),
  );

  appCmd.addCommand(
    new Command('policies').argument('<name>').description("An app's action → min-role table")
      .option(...outputOption())
      .action(async (name: string, opts: { output: string }) => {
        const res = await http.get<{ policies: PolicyRow[] }>(`/apps/${encodeURIComponent(name)}/policies`).catch(die);
        printOutput(res.policies, opts.output, () =>
          table(res.policies, [{ key: 'action', label: 'ACTION' }, { key: 'minRole', label: 'MIN ROLE' }] as ColDef<PolicyRow>[]),
        );
      }),
  );

  cmd.addCommand(appCmd);
  return cmd;
}

// ─── orgCommand (backward compat) ────────────────────────────────────────────

export function orgCommand(deps: OrgCliDeps): Command {
  const root = new Command('org').description('Org, workspace, and project management');
  addGlobalCommands(root, deps);
  root.addCommand(buildOrgCommand(deps));
  root.addCommand(buildWsCommand(deps));
  root.addCommand(buildProjCommand(deps));
  root.addCommand(buildAccessCommand(deps));
  return root;
}

// ─── use command implementation ───────────────────────────────────────────────

async function runUseCommand(
  http: ApiClient,
  ctx:  ContextManager<Record<string, string | undefined>>,
  path?: string,
): Promise<void> {
  async function pick<T extends { id: string; slug: string; name?: string }>(label: string, items: T[]): Promise<T> {
    if (!items.length) fatal(`No ${label}s found.`);
    if (items.length === 1) return items[0]!;
    console.log(`\nSelect ${label}:`);
    items.forEach((it, i) => console.log(`  ${clr.cyan}${i + 1}${clr.reset}  ${it.slug}${it.name ? `  ${clr.dim}${it.name}${clr.reset}` : ''}`));
    const ans = await prompt(`${label} [1-${items.length}]: `);
    const n   = parseInt(ans, 10);
    if (!n || n < 1 || n > items.length) fatal('Invalid selection.');
    return items[n - 1]!;
  }

  const parts    = (path ?? '').split('/').map(s => s.trim()).filter(Boolean);
  const orgHint  = parts[0];
  const wsHint   = parts[1];
  const projHint = parts[2];
  const envHint  = parts[3];

  let orgSlug: string;
  if (orgHint) {
    orgSlug = orgHint;
  } else {
    const { orgs } = await http.get<{ orgs: OrgRow[] }>('/v1/orgs').catch(e => { console.error(e.message); process.exit(1); });
    const org = await pick('org', orgs);
    orgSlug = org.slug;
  }

  const orgRes = await http.get<{ org: OrgRow }>(`/v1/orgs/${orgSlug}`)
    .catch(() => fatal(`Org not found: ${orgSlug}`));

  if (parts.length <= 1 && orgHint) {
    const cfg = ctx.loadConfig() as Record<string, unknown>;
    ctx.saveConfig({ ...cfg, activeOrg: orgRes.org.slug, context: { org: orgRes.org.slug, orgId: orgRes.org.id } } as never);
    success('Active org set.');
    kv([['org', orgRes.org.slug]]);
    return;
  }

  const { workspaces } = await http.get<{ workspaces: WsRow[] }>(`/v1/orgs/${orgSlug}/workspaces`).catch(e => { console.error(e.message); process.exit(1); });
  const ws = wsHint
    ? (workspaces.find(w => w.slug === wsHint) ?? fatal(`Workspace not found: ${wsHint}`))
    : (workspaces.length === 1 ? workspaces[0]! : await pick('workspace', workspaces));

  if (parts.length === 2) {
    const cfg = ctx.loadConfig() as Record<string, unknown>;
    ctx.saveConfig({ ...cfg, activeOrg: orgRes.org.slug } as never);
    ctx.setContext({ org: orgRes.org.slug, orgId: orgRes.org.id, workspace: ws!.slug, workspaceId: ws!.id });
    success('Active context set.');
    kv([['org', orgRes.org.slug], ['workspace', ws!.slug]]);
    return;
  }

  const projRes = await http.get<{ projects: ProjRow[] }>(`/v1/orgs/${orgSlug}/workspaces/${ws!.slug}/projects`).catch(e => { console.error(e.message); process.exit(1); });
  const { projects } = projRes!;
  const proj = projHint
    ? (projects.find(p => p.slug === projHint) ?? fatal(`Project not found: ${projHint}`))
    : (projects.length === 1 ? projects[0]! : await pick('project', projects));

  const envBase = `/v1/orgs/${orgSlug}/workspaces/${ws!.slug}/projects/${proj!.slug}/envs`;
  const envRes = await http.get<{ envs: EnvRow[] }>(envBase).catch(e => { console.error(e.message); process.exit(1); });
  let { envs } = envRes;

  // auto-create production env if project has none
  if (!envs.length) {
    const created = await http.post<{ env: EnvRow }>(envBase, { name: 'Production', slug: 'production' }).catch(e => { console.error(e.message); process.exit(1); });
    envs = [created.env];
    warn('Created default env: production');
  }

  const env = envHint
    ? (envs.find(e => e.slug === envHint) ?? fatal(`Env not found: ${envHint}`))
    : (envs.length === 1 ? envs[0]! : await pick('env', envs));

  ctx.setContext({
    org:         orgRes.org.slug,
    orgId:       orgRes.org.id,
    workspace:   ws!.slug,
    workspaceId: ws!.id,
    project:     proj!.slug,
    projectId:   proj!.id,
    env:         env!.slug,
    envId:       env!.id,
  });

  success('Active context set.');
  kv([['org', orgRes.org.slug], ['workspace', ws!.slug], ['project', proj!.slug], ['env', env!.slug]]);
}

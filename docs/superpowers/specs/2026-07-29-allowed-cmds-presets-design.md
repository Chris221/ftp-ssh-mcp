# SSH_ALLOWED_CMDS `@preset` tokens — design

Date: 2026-07-29
Status: approved

## Problem

The `SSH_ALLOWED_CMDS` default (`npm,node,mysql,mysqldump,touch,ls,cat,tail,head,df,du,pwd`)
is a flat, Node-deploy-flavoured list. Users on other stacks either accept
irrelevant commands in their allowlist or retype the useful basics by hand.
The list also reads as tailored rather than generic.

## Design

`SSH_ALLOWED_CMDS` accepts preset tokens alongside literal command names.
An entry starting with `@` names a preset; anything else is a literal.

Presets (a constant in `src/config.mjs`):

| Preset   | Commands                                 |
| -------- | ---------------------------------------- |
| `@basic` | `ls, cat, tail, head, df, du, pwd, touch` |
| `@node`  | `node, npm`                              |
| `@php`   | `php, composer`                          |
| `@mysql` | `mysql, mysqldump`                       |

- Expansion happens once, in `resolveSsh`. The expanded, deduplicated list is
  stored in `config.ssh.allowedCommands`; `validateCommand` and everything
  downstream are unchanged.
- The default becomes `@basic,@node,@mysql`, which expands to exactly the old
  literal list — no behavior change for existing configs.
- An unknown `@name` throws at startup, naming the bad token and listing the
  valid presets. Preset names are lowercase and matched case-sensitively.
- Docs: a preset table in the README Variables section; `.env.example` shows
  the preset default and a literal-mix example.

## Out of scope

- Panel-named presets (`@cpanel`): presets describe stacks, not products.
- `@git` and other additional presets: easy to add later once asked for.
- Preset mechanisms for any other variable.

## Testing

Config-level tests: expansion, literal mixing, dedup, unknown-preset error,
and default-equals-old-list equivalence. The ssh-exec wire tests already
prove enforcement of whatever list resolves.

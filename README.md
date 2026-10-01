# adb-plugin-custom-commands

Custom Commands plugin for [Advanced Discord Bot](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot) (ADB).

## Features

- **Four Command Types**:
  - `slash`: Discord application slash commands (e.g. `/name`) registered dynamically on a per-guild basis.
  - `text`: Traditional chat commands parsed using a configurable/default prefix (e.g. `!name`).
  - `user`: Discord user context menu commands (Apps -> `name`).
  - `message`: Discord message context menu commands (Apps -> `name`).
- **Embed Responses**: Opt-in to reply using high-quality Discord embeds or standard text.
- **Dynamic Variables**:
  - `{user}`: Mentions the user executing the command (e.g. `<@userId>`).
  - `{server}`: The server/guild name.
  - `{timestamp}`: A dynamically rendered Discord timestamp (e.g. `<t:unix_time:f>`).
  - `{args:all}`: Joins all provided arguments into a single space-separated string.
  - `{args:N}`: Resolves positional parameters:
    - **Slash & Text Commands**: The N-th space-separated word of arguments (1-indexed).
    - **User Context Menu Commands**:
      - `{args:1}`: Target user mention
      - `{args:2}`: Target username
      - `{args:3}`: Target user ID
    - **Message Context Menu Commands**:
      - `{args:1}`: Target message author mention
      - `{args:2}`: Target message text content
      - `{args:3}`: Target message ID
      - `{args:4}`: Target message author username

## Management Commands

Use the `/customcommand` command group to manage your custom commands:
- `/customcommand create [name] [type] [response] [embed] [description]` — Create a new command.
- `/customcommand edit [name] [response] [embed] [description]` — Edit matching commands.
- `/customcommand delete [name]` — Delete matching commands (cleans up from Discord API).
- `/customcommand list` — List all registered custom commands for this server.
- `/customcommand show [name]` — Show configuration details for matching commands.

Management requires the Manage Server permission and defers an ephemeral reply
before database or Discord API work. Large lists are split across ephemeral
replies; `show` sends each matching definition separately and shortens long
fields for display without changing the saved template.

Variables are substituted once: dollar signs and placeholder-like text inside
arguments, server names, or quoted messages remain literal. Expanded responses
are shortened with `...` to fit Discord's 2000-character message limit or
4096-character embed-description limit. Stored templates remain unchanged.

## Installation & Setup

1. Copy or symlink this directory into the `plugins/` directory of your Advanced Discord Bot folder:
   ```bash
   ln -s $(pwd) /path/to/Advanced-Discord-Bot/plugins/adb-plugin-custom-commands
   ```
2. Run `npm install` in the plugin directory to restore dependencies.
3. Start/Restart the bot. Since this plugin adds slash commands, you must run the deployment command in the main bot repo to register the control commands with Discord:
   ```bash
   node deploy-commands.js
   ```

## Local Testing (No Discord connection/Mongo required)

Verify everything works by executing:
```bash
npm install
npm test
```

This runs the smoke harness and `test/regressions.js` against in-memory storage.
The regressions check ownership, concurrent refreshes, command restrictions,
deferred replies, variable expansion, and Discord payload limits.

With a compatible local Core checkout, also run the paired integration suite:

```bash
ADB_CORE_PATH=/home/dead/Projects/Advanced-Discord-Bot node --test test/core-runtime.test.js
```

That suite uses the real `PluginManager`, command sync, and dispatcher with fake
Discord/Mongo I/O. Neither suite is a live Discord or MongoDB test.

## Runtime Integration

This plugin explicitly declares `system:raw-client` in both `permissions` and
`capabilities`. It requires owner-approved, un-isolated access for guild command
management, prefix-message replies, and full context-menu interactions. It does
not require globally disabling plugin isolation.

Current Core treats raw-client plugins as always on and refuses per-guild plugin
toggles for them. A missing or false top-level config `enabled` flag therefore
does not disable this plugin. Per-command restrictions live in
`config.data._commands[name]`; both the application and prefix paths enforce
their enable flag and allowed roles, rejecting malformed restrictions.

Custom application commands use `ctx.registerCommand` and carry `guildIds` plus
`guildData[guildId]` (serialized command data, including type `1`, `2`, or `3`).
Current Core bulk sync filters by `guildIds` and selects `guildData[guildId]`.
The control command has no guild restriction. Registry refreshes read and apply
database snapshots serially so a delayed read cannot restore a deleted command.
Core resolves ownership by the current registration and prunes stale name
reservations when a new command is registered. It still lacks an unregister API
to immediately release deleted names from `commandNames`, so dashboard command
listings can retain deleted names until another registration or unload.

The current name-keyed dispatcher cannot represent multiple application types
with the same name. Conflicting names are rejected, and colliding persisted
records are left intact but not registered. Current Core routes context menus
through its shared permission, cooldown, and hook pipeline. The plugin's context
listener yields while `client.runtimeCommandDispatch === true`; without that
dispatcher, the listener delegates to the owned executor as a fallback.

## License

This project is licensed under the GNU Affero General Public License v3.0.

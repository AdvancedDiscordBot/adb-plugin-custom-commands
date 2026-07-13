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

This runs the comprehensive local test suite in `test/local-harness.js` using `test/mock-ctx.js` to ensure variables, creation, listing, execution, editing, and deletion work flawlessly.

## License

This project is licensed under the GNU Affero General Public License v3.0.

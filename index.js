const { EmbedBuilder } = require("discord.js");
const { createCustomCommandControl } = require("./commands/customcommand");
const customCommandSchema = require("./models/customCommand");

/**
 * Replace template variables in the response content.
 */
function replaceVariables(template, { user, guild, args = [], timestamp, targetUser, targetMessage }) {
	let result = template;

	// Replace {user}
	const userMention = user ? `<@${user.id}>` : "";
	result = result.replace(/\{user\}/g, userMention);

	// Replace {server}
	const serverName = guild ? guild.name : "";
	result = result.replace(/\{server\}/g, serverName);

	// Replace {timestamp}
	const tsStr = `<t:${Math.floor((timestamp || Date.now()) / 1000)}:f>`;
	result = result.replace(/\{timestamp\}/g, tsStr);

	// Replace {args:N}
	const argsRegex = /\{args:(\d+)\}/g;
	result = result.replace(argsRegex, (match, nStr) => {
		const n = parseInt(nStr, 10);
		if (args && args[n - 1] !== undefined) {
			return args[n - 1];
		}
		// If targetUser exists (User Context Menu)
		if (targetUser) {
			if (n === 1) return `<@${targetUser.id}>`;
			if (n === 2) return targetUser.username;
			if (n === 3) return targetUser.id;
		}
		// If targetMessage exists (Message Context Menu)
		if (targetMessage) {
			if (n === 1) return `<@${targetMessage.author.id}>`;
			if (n === 2) return targetMessage.content;
			if (n === 3) return targetMessage.id;
			if (n === 4) return targetMessage.author.username;
		}
		return "";
	});

	// Replace {args:all} as a convenience helper
	result = result.replace(/\{args:all\}/g, args.join(" "));

	return result;
}

/**
 * Executes a custom slash or context menu command.
 */
async function executeCustomCommand(interaction, cmd, ctx) {
	try {
		let args = [];
		let targetUser = null;
		let targetMessage = null;

		if (interaction.isChatInputCommand()) {
			const argsStr = interaction.options.getString("args") || "";
			args = argsStr.trim().split(/ +/).filter(Boolean);
		} else if (interaction.isUserContextMenuCommand()) {
			targetUser = interaction.targetUser;
		} else if (interaction.isMessageContextMenuCommand()) {
			targetMessage = interaction.targetMessage;
		}

		const processed = replaceVariables(cmd.response, {
			user: interaction.user,
			guild: interaction.guild,
			args,
			timestamp: Date.now(),
			targetUser,
			targetMessage,
		});

		if (cmd.embed) {
			const embed = new EmbedBuilder()
				.setDescription(processed)
				.setColor(0x5865F2);
			await interaction.reply({ embeds: [embed] });
		} else {
			await interaction.reply({ content: processed });
		}
	} catch (error) {
		ctx.logger.error(`Error executing custom command ${cmd.name}:`, error);
		try {
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content: "❌ Failed to execute custom command.", ephemeral: true });
			} else {
				await interaction.reply({ content: "❌ Failed to execute custom command.", ephemeral: true });
			}
		} catch (e) {
			ctx.logger.error("Failed to send error reply:", e);
		}
	}
}

/**
 * Executes a custom text (prefix) command.
 */
async function executeCustomTextCommand(message, cmd, args, ctx) {
	try {
		const processed = replaceVariables(cmd.response, {
			user: message.author,
			guild: message.guild,
			args,
			timestamp: Date.now(),
		});

		if (cmd.embed) {
			const embed = new EmbedBuilder()
				.setDescription(processed)
				.setColor(0x5865F2);
			await message.reply({ embeds: [embed] });
		} else {
			await message.reply({ content: processed });
		}
	} catch (error) {
		ctx.logger.error(`Error executing custom text command ${cmd.name}:`, error);
		try {
			await message.reply({ content: "❌ Failed to execute custom command." });
		} catch (e) {
			ctx.logger.error("Failed to send text error reply:", e);
		}
	}
}

/**
 * Register a custom slash command executor in client.commands.
 */
function registerGlobalSlashExecutor(client, CustomCommandModel, name, ctx) {
	if (!client.commands.has(name)) {
		client.commands.set(name, {
			data: {
				name: name,
				description: "Custom slash command",
				options: [
					{
						name: "args",
						type: 3, // STRING
						description: "Arguments for the command",
						required: false,
					},
				],
				toJSON() {
					return this;
				},
			},
			async execute(interaction) {
				const dbCmd = await CustomCommandModel.findOne({
					guildId: interaction.guildId,
					name: interaction.commandName,
					type: "slash",
				});
				if (dbCmd) {
					await executeCustomCommand(interaction, dbCmd, ctx);
				} else {
					await interaction.reply({ content: "❌ Custom command not found in this server.", ephemeral: true });
				}
			},
		});
	}
}

/**
 * Every ADB plugin exports a single `load(ctx)` function. `ctx` is frozen
 * and namespaced to this plugin.
 */
async function load(ctx) {
	const CustomCommandModel = ctx.defineModel("customCommand", customCommandSchema);

	// Register the /customcommand control command
	ctx.registerCommand(
		createCustomCommandControl(CustomCommandModel, ctx, executeCustomCommand, registerGlobalSlashExecutor),
	);

	// Load existing slash commands and register their executors in client.commands
	try {
		const slashCommands = await CustomCommandModel.find({ type: "slash" });
		for (const cmd of slashCommands) {
			registerGlobalSlashExecutor(ctx.client, CustomCommandModel, cmd.name, ctx);
		}
	} catch (err) {
		ctx.logger.error("Failed to load and register existing custom slash commands:", err);
	}

	// Register listener for text prefix commands
	ctx.registerEvent("messageCreate", async (message) => {
		if (message.author.bot || !message.guild) return;

		// Default prefix is "!"
		const prefix = "!";
		if (!message.content.startsWith(prefix)) return;

		const args = message.content.slice(prefix.length).trim().split(/ +/);
		const commandName = args.shift().toLowerCase();

		if (!commandName) return;

		const dbCmd = await CustomCommandModel.findOne({
			guildId: message.guild.id,
			name: commandName,
			type: "text",
		});

		if (dbCmd) {
			await executeCustomTextCommand(message, dbCmd, args, ctx);
		}
	});

	// Register listener for user/message context menu commands
	ctx.registerEvent("interactionCreate", async (interaction) => {
		if (!interaction.guild) return;

		if (interaction.isUserContextMenuCommand() || interaction.isMessageContextMenuCommand()) {
			const type = interaction.isUserContextMenuCommand() ? "user" : "message";
			const dbCmd = await CustomCommandModel.findOne({
				guildId: interaction.guildId,
				name: interaction.commandName,
				type: type,
			});

			if (dbCmd) {
				await executeCustomCommand(interaction, dbCmd, ctx);
			}
		}
	});

	ctx.logger.info("Custom Commands plugin loaded");
}

module.exports = { load, replaceVariables };

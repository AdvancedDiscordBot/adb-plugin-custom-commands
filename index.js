const { EmbedBuilder } = require("discord.js");
const { createCustomCommandControl, commandData, respond } = require("./commands/customcommand");
const customCommandSchema = require("./models/customCommand");
const usageSchema = require("./models/usage");

async function trackUsage(ctx, UsageModel, guildId, userId, name) {
	try {
		await UsageModel.findOneAndUpdate(
			{ guildId, userId, name },
			{ $inc: { uses: 1 }, $set: { lastUsedAt: new Date() } },
			{ upsert: true }
		);
	} catch (err) {
		ctx.logger.error(`Failed to record usage for custom command ${name}:`, err);
	}
}

/**
 * Replace template variables in the response content.
 */
function replaceVariables(template, { user, guild, args = [], timestamp, targetUser, targetMessage }) {
	// Only placeholders in the template are expanded; inserted values stay literal.
	return template.replace(/\{(user|server|timestamp|args:(?:all|\d+))\}/g, (_match, variable) => {
		if (variable === "user") return user ? `<@${user.id}>` : "";
		if (variable === "server") return guild ? guild.name : "";
		if (variable === "timestamp") return `<t:${Math.floor((timestamp || Date.now()) / 1000)}:f>`;
		if (variable === "args:all") return args.join(" ");
		const n = parseInt(variable.slice(5), 10);
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
}

/**
 * Executes a custom slash or context menu command.
 */
async function executeCustomCommand(interaction, cmd, ctx, UsageModel) {
	try {
		await trackUsage(ctx, UsageModel, interaction.guildId, interaction.user.id, cmd.name);
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

		let processed = replaceVariables(cmd.response, {
			user: interaction.user,
			guild: interaction.guild,
			args,
			timestamp: Date.now(),
			targetUser,
			targetMessage,
		});
		const maxLength = cmd.embed ? 4096 : 2000;
		if (processed.length > maxLength) processed = `${processed.slice(0, maxLength - 3)}...`;

		if (cmd.embed) {
			const embed = new EmbedBuilder()
				.setDescription(processed)
				.setColor(0x5865F2);
			await respond(interaction, { embeds: [embed] });
		} else {
			await respond(interaction, { content: processed });
		}
	} catch (error) {
		ctx.logger.error(`Error executing custom command ${cmd.name}:`, error);
		try {
			await respond(interaction, { content: "❌ Failed to execute custom command.", ephemeral: true });
		} catch (e) {
			ctx.logger.error("Failed to send error reply:", e);
		}
	}
}

/**
 * Executes a custom text (prefix) command.
 */
async function executeCustomTextCommand(message, cmd, args, ctx, UsageModel) {
	try {
		await trackUsage(ctx, UsageModel, message.guild.id, message.author.id, cmd.name);
		let processed = replaceVariables(cmd.response, {
			user: message.author,
			guild: message.guild,
			args,
			timestamp: Date.now(),
		});
		const maxLength = cmd.embed ? 4096 : 2000;
		if (processed.length > maxLength) processed = `${processed.slice(0, maxLength - 3)}...`;

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

function commandAllowed(config, name, member) {
	const command = config?._commands?.[name];
	if (config?.enabled === false || command?.enabled === false) return false;
	if (command?.enabled !== undefined && typeof command.enabled !== "boolean") return false;
	const allowedRoles = command?.allowedRoles;
	if (allowedRoles === undefined) return true;
	if (!Array.isArray(allowedRoles) || !allowedRoles.every((role) => typeof role === "string")) return false;
	if (!allowedRoles.length) return true;
	const roles = member?.roles;
	return Array.isArray(roles)
		? roles.some((id) => allowedRoles.includes(id))
		: !!roles?.cache?.some((role) => allowedRoles.includes(role.id));
}

/**
 * Every ADB plugin exports a single `load(ctx)` function. `ctx` is frozen
 * and namespaced to this plugin.
 */
async function load(ctx) {
	const CustomCommandModel = ctx.defineModel("customCommand", customCommandSchema);
	const UsageModel = ctx.defineModel("usage", usageSchema);
	const registrations = new Map();
	const handled = new WeakSet();
	let active = true;
	let refreshQueue = Promise.resolve();
	const registry = {
		conflict(name, type) {
			const current = ctx.client.commands.get(name);
			const own = registrations.get(name);
			if (current && current !== own) return `Command name \`${name}\` is already registered by another command or plugin.`;
			if (own && own.data.type !== { slash: 1, user: 2, message: 3 }[type]) return `Command name \`${name}\` already has a conflicting application command type.`;
			return null;
		},
		owns(cmd) {
			const own = registrations.get(cmd.name);
			return active && own && ctx.client.commands.get(cmd.name) === own && own.guildIds.includes(cmd.guildId) && !registry.conflict(cmd.name, cmd.type);
		},
		async execute(interaction, name, expectedType) {
			if (!active || handled.has(interaction)) return;
			handled.add(interaction);
			const type = interaction.isChatInputCommand() ? "slash" : interaction.isUserContextMenuCommand() ? "user" : interaction.isMessageContextMenuCommand() ? "message" : null;
			if (type !== expectedType || !registry.owns({ name, type, guildId: interaction.guildId })) {
				return respond(interaction, { content: "Custom command not found in this server.", ephemeral: true });
			}
			try {
				if (!interaction.deferred && !interaction.replied) await interaction.deferReply();
				const config = await ctx.db.getPluginConfig(interaction.guildId, "adb-plugin-custom-commands");
				if (!commandAllowed(config?.data, name, interaction.member)) {
					return respond(interaction, { content: "This command is disabled or you do not have the required role.", ephemeral: true });
				}
				const dbCmd = await CustomCommandModel.findOne({ guildId: interaction.guildId, name, type });
				if (!dbCmd) return respond(interaction, { content: "Custom command not found in this server.", ephemeral: true });
				await executeCustomCommand(interaction, dbCmd, ctx, UsageModel);
			} catch (err) {
				ctx.logger.error(`Custom command ${name} failed:`, err);
				await respond(interaction, { content: "Failed to execute custom command.", ephemeral: true });
			}
		},
		async refresh() {
			// Read and apply snapshots in order, including after a failed refresh.
			const previous = refreshQueue;
			let release;
			refreshQueue = new Promise((resolve) => { release = resolve; });
			await previous;
			try {
				if (!active) return;
				const commands = await CustomCommandModel.find({});
				if (!active) return;
				for (const own of registrations.values()) own.guildIds = [];
				for (const cmd of commands) {
					if (cmd.type === "text") continue;
					try {
						const conflict = registry.conflict(cmd.name, cmd.type);
						if (conflict) throw new Error(conflict);
						const data = commandData(cmd);
						let own = registrations.get(cmd.name);
						if (!own) {
							const command = {
								data, guildIds: [cmd.guildId], guildData: { [cmd.guildId]: data },
								execute: (interaction) => registry.execute(interaction, cmd.name, cmd.type),
							};
							ctx.registerCommand(command);
							own = ctx.client.commands.get(cmd.name);
							registrations.set(cmd.name, own);
						}
						if (!own.guildIds.length) {
							own.data = data;
							own.guildData = {};
						}
						if (!own.guildIds.includes(cmd.guildId)) own.guildIds.push(cmd.guildId);
						own.guildData[cmd.guildId] = data;
					} catch (err) {
						ctx.logger.warn(`Skipping custom command ${cmd.name} in ${cmd.guildId}:`, err.message);
					}
				}
				for (const [name, own] of registrations) {
					if (own.guildIds.length) continue;
					if (ctx.client.commands.get(name) === own) ctx.client.commands.delete(name);
					registrations.delete(name);
				}
			} finally {
				release();
			}
		},
	};

	// Register the /customcommand control command
	ctx.registerCommand(
		createCustomCommandControl(CustomCommandModel, ctx, registry),
	);

	// Persisted commands must enter the same ownership/sync path as new ones.
	try {
		await registry.refresh();
	} catch (err) {
		ctx.logger.error("Failed to load and register existing custom commands:", err);
	}
	ctx.hooks.on("onPluginUnload", ({ pluginName }) => {
		if (pluginName !== "adb-plugin-custom-commands") return;
		active = false;
		for (const [name, own] of registrations) {
			own.guildIds = [];
			if (ctx.client.commands.get(name) === own) ctx.client.commands.delete(name);
		}
		registrations.clear();
	});

	// Register listener for text prefix commands
	ctx.registerEvent("messageCreate", async (message) => {
		if (!active || !message.author || message.author.bot || !message.guild || typeof message.content !== "string") return;

		// Text-command prefix is configured from the dashboard (settings.prefix).
		// Falls back to "!" when unset. Read per-message so live edits apply
		// without a reload.
		let prefix = "!";
		let config;
		try {
			const cfg = await ctx.db.getPluginConfig(message.guild.id, "adb-plugin-custom-commands");
			config = cfg?.data;
			const p = cfg?.data?.prefix;
			if (typeof p === "string" && p.length > 0) prefix = p;
		} catch (err) {
			ctx.logger.error("Failed to read custom-commands prefix config:", err);
			return;
		}
		if (!message.content.startsWith(prefix)) return;

		const args = message.content.slice(prefix.length).trim().split(/ +/);
		const commandName = args.shift().toLowerCase();

		if (!commandName || !commandAllowed(config, commandName, message.member)) return;

		const dbCmd = await CustomCommandModel.findOne({
			guildId: message.guild.id,
			name: commandName,
			type: "text",
		});

		if (dbCmd) {
			await executeCustomTextCommand(message, dbCmd, args, ctx, UsageModel);
		}
	});

	// Register listener for user/message context menu commands
	ctx.registerEvent("interactionCreate", async (interaction) => {
		// The unified core dispatcher owns permission checks and execution when installed.
		if (ctx.client.runtimeCommandDispatch === true) return;
		if (!active || !interaction.guild) return;

		if (interaction.isUserContextMenuCommand() || interaction.isMessageContextMenuCommand()) {
			const type = interaction.isUserContextMenuCommand() ? "user" : "message";
			if (registry.owns({ name: interaction.commandName, type, guildId: interaction.guildId })) {
				await ctx.client.commands.get(interaction.commandName).execute(interaction);
			}
		}
	});

	ctx.logger.info("Custom Commands plugin loaded");
}

module.exports = { load, replaceVariables };

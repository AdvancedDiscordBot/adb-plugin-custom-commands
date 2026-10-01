const { EmbedBuilder, PermissionFlagsBits } = require("discord.js");

const slashTextRegex = /^[a-z0-9_-]{1,32}$/;
const contextMenuRegex = /^[a-zA-Z0-9_ -]{1,32}$/;

function commandData(cmd) {
	const type = { slash: 1, user: 2, message: 3 }[cmd.type];
	if (!type || !(type === 1 ? slashTextRegex : contextMenuRegex).test(cmd.name)) {
		throw new Error(`Invalid application command: ${cmd.name} (${cmd.type})`);
	}
	return {
		name: cmd.name,
		type,
		...(type === 1 ? {
			description: (cmd.description || "Custom command").slice(0, 100),
			options: [{ name: "args", type: 3, description: "Arguments for the command", required: false }], // STRING
		} : {}),
	};
}

function respond(interaction, payload) {
	if (interaction.replied) return interaction.followUp(payload);
	if (interaction.deferred) return interaction.editReply(payload);
	return interaction.reply(payload);
}

function createCustomCommandControl(CustomCommandModel, ctx, registry) {
	return {
		data: {
			name: "customcommand",
			description: "Manage guild custom commands",
			default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
			dm_permission: false,
			options: [
				{
					name: "create",
					description: "Create a new custom command",
					type: 1, // SUB_COMMAND
					options: [
						{
							name: "name",
							description: "Name of the custom command",
							type: 3, // STRING
							required: true,
						},
						{
							name: "type",
							description: "Type of the command (slash, text, user, message)",
							type: 3, // STRING
							required: true,
							choices: [
								{ name: "slash", value: "slash" },
								{ name: "text", value: "text" },
								{ name: "user", value: "user" },
								{ name: "message", value: "message" },
							],
						},
						{
							name: "response",
							description: "Response text (supports variables like {user}, {server}, {args:N})",
							type: 3, // STRING
							required: true,
						},
						{
							name: "embed",
							description: "Whether the response should be sent in an embed (default: false)",
							type: 5, // BOOLEAN
							required: false,
						},
						{
							name: "description",
							description: "Description of the command (slash command only)",
							type: 3, // STRING
							required: false,
						},
					],
				},
				{
					name: "edit",
					description: "Edit an existing custom command",
					type: 1, // SUB_COMMAND
					options: [
						{
							name: "name",
							description: "Name of the custom command to edit",
							type: 3, // STRING
							required: true,
						},
						{
							name: "response",
							description: "New response text",
							type: 3, // STRING
							required: false,
						},
						{
							name: "embed",
							description: "Whether the response should be sent in an embed",
							type: 5, // BOOLEAN
							required: false,
						},
						{
							name: "description",
							description: "New description (slash command only)",
							type: 3, // STRING
							required: false,
						},
					],
				},
				{
					name: "delete",
					description: "Delete a custom command",
					type: 1, // SUB_COMMAND
					options: [
						{
							name: "name",
							description: "Name of the custom command to delete",
							type: 3, // STRING
							required: true,
						},
					],
				},
				{
					name: "list",
					description: "List all custom commands in this guild",
					type: 1, // SUB_COMMAND
				},
				{
					name: "show",
					description: "Show details of a specific custom command",
					type: 1, // SUB_COMMAND
					options: [
						{
							name: "name",
							description: "Name of the custom command to show",
							type: 3, // STRING
							required: true,
						},
					],
				},
			],
		},
		async execute(interaction) {
			const reply = (payload) => respond(interaction, payload);
			if (!interaction.guildId || !interaction.guild) {
				return reply({ content: "Use this command in a server.", ephemeral: true });
			}
			const permissions = interaction.memberPermissions || interaction.member?.permissions;
			if (!permissions?.has(PermissionFlagsBits.ManageGuild)) {
				return reply({ content: "You need the Manage Server permission to manage custom commands.", ephemeral: true });
			}
			if (!interaction.deferred && !interaction.replied) await interaction.deferReply({ ephemeral: true });
			const subcommand = interaction.options.getSubcommand();

			if (subcommand === "create") {
				const nameInput = interaction.options.getString("name");
				const type = interaction.options.getString("type");
				const response = interaction.options.getString("response");
				const embed = interaction.options.getBoolean("embed") || false;
				const description = interaction.options.getString("description") || "Custom command";
				if (!["slash", "text", "user", "message"].includes(type)) {
					return reply({ content: "Invalid custom command type.", ephemeral: true });
				}

				let name = nameInput;
				if (type === "slash" || type === "text") {
					name = nameInput.toLowerCase();
					if (!slashTextRegex.test(name)) {
						return reply({
							content: "❌ Slash and text command names must contain only letters, numbers, hyphens, or underscores, and be between 1 and 32 characters.",
							ephemeral: true,
						});
					}
				} else {
					if (!contextMenuRegex.test(name)) {
						return reply({
							content: "❌ Context menu command names must contain only letters, numbers, spaces, hyphens, or underscores, and be between 1 and 32 characters.",
							ephemeral: true,
						});
					}
				}

				const conflict = type !== "text" && registry.conflict(name, type);
				if (conflict) return reply({ content: conflict, ephemeral: true });

				// Check if duplicate exists for this guild, name and type
				const existing = await CustomCommandModel.findOne({
					guildId: interaction.guildId,
					name,
					type,
				});

				if (existing) {
					return reply({
						content: `❌ A custom command named \`${name}\` with type \`${type}\` already exists in this server.`,
						ephemeral: true,
					});
				}

				// Save to database
				const saved = await CustomCommandModel.create({
					guildId: interaction.guildId,
					name,
					type,
					response,
					embed,
					description,
				});

				// Register ownership before touching Discord's name-upserting API.
				if (type !== "text") {
					await registry.refresh();
					if (!registry.owns(saved)) {
						await CustomCommandModel.deleteOne({ _id: saved._id });
						return reply({ content: `Command name \`${name}\` conflicts with an existing registration.`, ephemeral: true });
					}
					try {
						await interaction.guild.commands.create(commandData(saved));
					} catch (err) {
						ctx.logger.error(`Failed to register dynamic command ${name} to Discord:`, err);
						return reply({ content: `Saved custom command \`${name}\`, but Discord registration failed. Check bot permissions and retry command sync.`, ephemeral: true });
					}
				}

				return reply({
					content: `✅ Successfully created custom command \`${name}\` (Type: ${type}).`,
					ephemeral: true,
				});
			}

			if (subcommand === "delete") {
				const nameInput = interaction.options.getString("name");
				
				const allGuildCommands = await CustomCommandModel.find({ guildId: interaction.guildId });
				const matches = allGuildCommands.filter(
					(c) => c.name.toLowerCase() === nameInput.toLowerCase()
				);

				if (matches.length === 0) {
					return reply({
						content: `❌ No custom command named \`${nameInput}\` found in this server.`,
						ephemeral: true,
					});
				}

				const owned = matches.filter((match) => match.type !== "text" && registry.owns(match));
				for (const match of matches) {
					await CustomCommandModel.deleteOne({
						_id: match._id,
					});
				}

				await registry.refresh();
				// Remove from Discord's API if they are slash or context menu commands
				if (owned.length && interaction.guild.commands) {
					try {
						const guildCommands = await interaction.guild.commands.fetch();
						for (const match of owned) {
							// A create may have reused the name while the fetch was pending.
							if (registry.conflict(match.name, match.type) || registry.owns(match)) continue;
							if (match.type !== "text") {
								const discordType = match.type === "slash" ? 1 : match.type === "user" ? 2 : 3;
								const existing = guildCommands.find(
									(c) => c.name === match.name && c.type === discordType,
								);
								if (existing) {
									await interaction.guild.commands.delete(existing.id);
								}
							}
						}
					} catch (err) {
						ctx.logger.error(`Failed to delete command ${nameInput} from Discord:`, err);
						return reply({ content: `Deleted custom command \`${nameInput}\` locally, but Discord removal failed. Retry command sync.`, ephemeral: true });
					}
				}

				const deletedTypes = matches.map((m) => m.type).join(", ");
				return reply({
					content: `✅ Successfully deleted custom command \`${nameInput}\` (Type(s): ${deletedTypes}).`,
					ephemeral: true,
				});
			}

			if (subcommand === "edit") {
				const nameInput = interaction.options.getString("name");
				const response = interaction.options.getString("response");
				const embed = interaction.options.getBoolean("embed");
				const description = interaction.options.getString("description");

				const allGuildCommands = await CustomCommandModel.find({ guildId: interaction.guildId });
				const matches = allGuildCommands.filter(
					(c) => c.name.toLowerCase() === nameInput.toLowerCase()
				);

				if (matches.length === 0) {
					return reply({
						content: `❌ No custom command named \`${nameInput}\` found in this server.`,
						ephemeral: true,
					});
				}

				const updateFields = {};
				if (response !== null) updateFields.response = response;
				if (embed !== null) updateFields.embed = embed;
				if (description !== null) updateFields.description = description;
				updateFields.updatedAt = new Date();

				for (const match of matches) {
					await CustomCommandModel.updateOne({
						_id: match._id,
					}, {
						$set: updateFields,
					});
				}

				await registry.refresh();
				// Update Discord's API if needed (e.g. description changed for slash commands)
				if (description !== null && interaction.guild && interaction.guild.commands) {
					try {
						const guildCommands = await interaction.guild.commands.fetch();
						for (const match of matches) {
							if (match.type === "slash" && registry.owns(match)) {
								const existing = guildCommands.find((c) => c.name === match.name && c.type === 1);
								if (existing) {
									await interaction.guild.commands.edit(existing.id, {
										description: commandData({ name: match.name, type: match.type, description }).description,
									});
								}
							}
						}
					} catch (err) {
						ctx.logger.error(`Failed to update command ${nameInput} on Discord:`, err);
						return reply({ content: `Updated custom command \`${nameInput}\` locally, but Discord update failed. Retry command sync.`, ephemeral: true });
					}
				}

				return reply({
					content: `✅ Successfully updated custom command \`${nameInput}\`.`,
					ephemeral: true,
				});
			}

			if (subcommand === "show") {
				const nameInput = interaction.options.getString("name");

				const allGuildCommands = await CustomCommandModel.find({ guildId: interaction.guildId });
				const matches = allGuildCommands.filter(
					(c) => c.name.toLowerCase() === nameInput.toLowerCase()
				);

				if (matches.length === 0) {
					return reply({
						content: `❌ No custom command named \`${nameInput}\` found in this server.`,
						ephemeral: true,
					});
				}

				for (const cmd of matches) {
					const preview = cmd.response.length > 1000 ? `${cmd.response.slice(0, 997)}...` : cmd.response;
					const embed = new EmbedBuilder()
						.setColor(0x5865F2)
						.setTitle(`🛠️ Custom Command: ${cmd.name}`)
						.addFields(
							{ name: "📋 Type", value: cmd.type, inline: true },
							{ name: "📦 Send as Embed", value: cmd.embed ? "Yes" : "No", inline: true },
							{ name: "📝 Description", value: (cmd.description || "N/A").slice(0, 1024), inline: false },
							{ name: "💬 Response Template", value: `\`\`\`\n${preview}\n\`\`\``, inline: false },
						)
						.setTimestamp();
					await reply({ embeds: [embed], ephemeral: true });
				}
				return;
			}

			if (subcommand === "list") {
				const commandsList = await CustomCommandModel.find({
					guildId: interaction.guildId,
				}).sort({ name: 1, type: 1 });

				if (commandsList.length === 0) {
					return reply({
						content: "ℹ️ There are no custom commands registered in this server.",
						ephemeral: true,
					});
				}

				const pages = [""];
				for (const cmd of commandsList) {
					const trigger = cmd.type === "slash" ? `\`/${cmd.name}\`` : cmd.type === "text" ? `\`!${cmd.name}\`` : `\`${cmd.name}\` (Context Menu)`;
					const line = `• ${trigger} — Type: **${cmd.type}** — Embed: **${cmd.embed ? "Yes" : "No"}**`;
					if (pages[pages.length - 1].length + line.length + 1 > 4096) pages.push("");
					pages[pages.length - 1] += `${pages[pages.length - 1] ? "\n" : ""}${line}`;
				}
				for (const description of pages) {
					const embed = new EmbedBuilder()
						.setColor(0x5865F2)
						.setTitle("🛠️ Custom Commands List")
						.setDescription(description)
						.setTimestamp();
					await reply({ embeds: [embed], ephemeral: true });
				}
				return;
			}
		},
	};
}

module.exports = { createCustomCommandControl, commandData, respond };

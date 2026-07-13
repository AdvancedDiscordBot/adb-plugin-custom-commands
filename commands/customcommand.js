const { EmbedBuilder } = require("discord.js");

const slashTextRegex = /^[a-z0-9_-]{1,32}$/;
const contextMenuRegex = /^[a-zA-Z0-9_ -]{1,32}$/;

function createCustomCommandControl(CustomCommandModel, ctx, executeCustomCommand, registerGlobalSlashExecutor) {
	return {
		data: {
			name: "customcommand",
			description: "Manage guild custom commands",
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
			const subcommand = interaction.options.getSubcommand();

			if (subcommand === "create") {
				const nameInput = interaction.options.getString("name");
				const type = interaction.options.getString("type");
				const response = interaction.options.getString("response");
				const embed = interaction.options.getBoolean("embed") || false;
				const description = interaction.options.getString("description") || "Custom command";

				let name = nameInput;
				if (type === "slash" || type === "text") {
					name = nameInput.toLowerCase();
					if (!slashTextRegex.test(name)) {
						return interaction.reply({
							content: "❌ Slash and text command names must contain only letters, numbers, hyphens, or underscores, and be between 1 and 32 characters.",
							ephemeral: true,
						});
					}
				} else {
					if (!contextMenuRegex.test(name)) {
						return interaction.reply({
							content: "❌ Context menu command names must contain only letters, numbers, spaces, hyphens, or underscores, and be between 1 and 32 characters.",
							ephemeral: true,
						});
					}
				}

				// Check if duplicate exists for this guild, name and type
				const existing = await CustomCommandModel.findOne({
					guildId: interaction.guildId,
					name,
					type,
				});

				if (existing) {
					return interaction.reply({
						content: `❌ A custom command named \`${name}\` with type \`${type}\` already exists in this server.`,
						ephemeral: true,
					});
				}

				// Save to database
				await CustomCommandModel.create({
					guildId: interaction.guildId,
					name,
					type,
					response,
					embed,
					description,
				});

				// Register with Discord's API dynamically if it's slash, user, or message
				if (type !== "text" && interaction.guild && interaction.guild.commands) {
					try {
						let discordType = 1; // ChatInput
						if (type === "user") discordType = 2; // User
						if (type === "message") discordType = 3; // Message

						await interaction.guild.commands.create({
							name: name,
							description: type === "slash" ? description : undefined,
							type: discordType,
							options: type === "slash" ? [
								{
									name: "args",
									type: 3, // STRING
									description: "Arguments for the command",
									required: false,
								},
							] : undefined,
						});
					} catch (err) {
						ctx.logger.error(`Failed to register dynamic command ${name} to Discord:`, err);
					}
				}

				// Register in the bot's global client.commands collection if it's a slash command
				if (type === "slash") {
					registerGlobalSlashExecutor(interaction.client, CustomCommandModel, name, ctx);
				}

				return interaction.reply({
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
					return interaction.reply({
						content: `❌ No custom command named \`${nameInput}\` found in this server.`,
						ephemeral: true,
					});
				}

				// Delete from DB by updating/deleting each matched ID individually
				// to ensure compatibility with mock-ctx in tests
				for (const match of matches) {
					await CustomCommandModel.deleteOne({
						_id: match._id,
					});
				}

				// Remove from Discord's API if they are slash or context menu commands
				if (interaction.guild && interaction.guild.commands) {
					try {
						const guildCommands = await interaction.guild.commands.fetch();
						for (const match of matches) {
							if (match.type !== "text") {
								const discordType = match.type === "slash" ? 1 : match.type === "user" ? 2 : 3;
								const existing = guildCommands.find(
									(c) => c.name.toLowerCase() === match.name.toLowerCase() && c.type === discordType,
								);
								if (existing) {
									await interaction.guild.commands.delete(existing.id);
								}
							}
						}
					} catch (err) {
						ctx.logger.error(`Failed to delete command ${nameInput} from Discord:`, err);
					}
				}

				const deletedTypes = matches.map((m) => m.type).join(", ");
				return interaction.reply({
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
					return interaction.reply({
						content: `❌ No custom command named \`${nameInput}\` found in this server.`,
						ephemeral: true,
					});
				}

				const updateFields = {};
				if (response !== null) updateFields.response = response;
				if (embed !== null) updateFields.embed = embed;
				if (description !== null) updateFields.description = description;
				updateFields.updatedAt = new Date();

				// Update in DB by updating each matched ID individually
				// to ensure compatibility with mock-ctx in tests
				for (const match of matches) {
					await CustomCommandModel.updateOne({
						_id: match._id,
					}, {
						$set: updateFields,
					});
				}

				// Update Discord's API if needed (e.g. description changed for slash commands)
				if (description !== null && interaction.guild && interaction.guild.commands) {
					try {
						const guildCommands = await interaction.guild.commands.fetch();
						for (const match of matches) {
							if (match.type === "slash") {
								const existing = guildCommands.find((c) => c.name.toLowerCase() === match.name.toLowerCase() && c.type === 1);
								if (existing) {
									await interaction.guild.commands.edit(existing.id, {
										description: description,
									});
								}
							}
						}
					} catch (err) {
						ctx.logger.error(`Failed to update command ${nameInput} on Discord:`, err);
					}
				}

				return interaction.reply({
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
					return interaction.reply({
						content: `❌ No custom command named \`${nameInput}\` found in this server.`,
						ephemeral: true,
					});
				}

				const embeds = matches.map((cmd) => {
					return new EmbedBuilder()
						.setColor(0x5865F2)
						.setTitle(`🛠️ Custom Command: ${cmd.name}`)
						.addFields(
							{ name: "📋 Type", value: cmd.type, inline: true },
							{ name: "📦 Send as Embed", value: cmd.embed ? "Yes" : "No", inline: true },
							{ name: "📝 Description", value: cmd.description || "N/A", inline: false },
							{ name: "💬 Response Template", value: `\`\`\`\n${cmd.response}\n\`\`\``, inline: false },
						)
						.setTimestamp();
				});

				return interaction.reply({
					embeds: embeds,
					ephemeral: true,
				});
			}

			if (subcommand === "list") {
				const commandsList = await CustomCommandModel.find({
					guildId: interaction.guildId,
				}).sort({ name: 1, type: 1 });

				if (commandsList.length === 0) {
					return interaction.reply({
						content: "ℹ️ There are no custom commands registered in this server.",
						ephemeral: true,
					});
				}

				const embed = new EmbedBuilder()
					.setColor(0x5865F2)
					.setTitle("🛠️ Custom Commands List")
					.setDescription(
						commandsList.map((cmd) => {
							const trigger = cmd.type === "slash" ? `\`/${cmd.name}\`` : cmd.type === "text" ? `\`!${cmd.name}\`` : `\`${cmd.name}\` (Context Menu)`;
							return `• ${trigger} — Type: **${cmd.type}** — Embed: **${cmd.embed ? "Yes" : "No"}**`;
						}).join("\n"),
					)
					.setTimestamp();

				return interaction.reply({
					embeds: [embed],
					ephemeral: true,
				});
			}
		},
	};
}

module.exports = { createCustomCommandControl };

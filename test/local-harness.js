// Run with: npm test (or) node test/local-harness.js

const assert = require("node:assert");
const { load, replaceVariables } = require("../index.js");
const { createMockCtx } = require("./mock-ctx");

function fakeControlInteraction({ subcommand, options = {}, guildId = "test-guild", user = { id: "test-user", username: "testuser" }, client }) {
	const replies = [];
	return {
		guildId,
		user,
		client,
		guild: {
			name: "Test Server",
			commands: {
				create: async (data) => data,
				delete: async () => {},
				edit: async () => {},
				fetch: async () => [],
			},
		},
		isChatInputCommand: () => true,
		isUserContextMenuCommand: () => false,
		isMessageContextMenuCommand: () => false,
		options: {
			getSubcommand: () => subcommand,
			getString: (name) => options[name] ?? null,
			getBoolean: (name) => options[name] ?? null,
		},
		reply: async (payload) => {
			replies.push(payload);
			return payload;
		},
		followUp: async (payload) => {
			replies.push(payload);
			return payload;
		},
		replies,
	};
}

function fakeSlashInteraction(commandName, options = {}, guildId = "test-guild", user = { id: "test-user", username: "testuser" }, client) {
	const replies = [];
	return {
		guildId,
		user,
		client,
		guild: { name: "Test Server" },
		commandName,
		isChatInputCommand: () => true,
		isUserContextMenuCommand: () => false,
		isMessageContextMenuCommand: () => false,
		options: {
			getString: (name) => options[name] ?? null,
		},
		reply: async (payload) => {
			replies.push(payload);
			return payload;
		},
		followUp: async (payload) => {
			replies.push(payload);
			return payload;
		},
		replies,
	};
}

function fakeUserContextMenuInteraction(commandName, targetUser, guildId = "test-guild", user = { id: "test-user", username: "testuser" }, client) {
	const replies = [];
	return {
		guildId,
		user,
		client,
		guild: { name: "Test Server" },
		commandName,
		targetUser,
		targetId: targetUser.id,
		isChatInputCommand: () => false,
		isUserContextMenuCommand: () => true,
		isMessageContextMenuCommand: () => false,
		reply: async (payload) => {
			replies.push(payload);
			return payload;
		},
		replies,
	};
}

function fakeMessageContextMenuInteraction(commandName, targetMessage, guildId = "test-guild", user = { id: "test-user", username: "testuser" }, client) {
	const replies = [];
	return {
		guildId,
		user,
		client,
		guild: { name: "Test Server" },
		commandName,
		targetMessage,
		targetId: targetMessage.id,
		isChatInputCommand: () => false,
		isUserContextMenuCommand: () => false,
		isMessageContextMenuCommand: () => true,
		reply: async (payload) => {
			replies.push(payload);
			return payload;
		},
		replies,
	};
}

async function main() {
	console.log("🧪 Starting custom-commands plugin tests...");

	// 1. Test replaceVariables utility function
	const template = "Hello {user} from {server}! Args: {args:1} & {args:all}. Timestamp: {timestamp}";
	const ts = Date.now();
	const replaced = replaceVariables(template, {
		user: { id: "12345" },
		guild: { name: "Discord Server" },
		args: ["first", "second"],
		timestamp: ts,
	});

	assert.ok(replaced.includes("<@12345>"), "Expected user mention in output");
	assert.ok(replaced.includes("Discord Server"), "Expected server name in output");
	assert.ok(replaced.includes("first"), "Expected first argument in output");
	assert.ok(replaced.includes("first second"), "Expected all arguments in output");
	assert.ok(replaced.includes(`<t:${Math.floor(ts / 1000)}:f>`), "Expected timestamp in output");
	console.log("✅ replaceVariables tests passed");

	// Setup mock context
	const { ctx, registeredCommands, emitEvent, models } = createMockCtx({
		pluginName: "adb-plugin-custom-commands",
	});

	await load(ctx);

	// Verify main control command registered
	assert.ok(registeredCommands.has("customcommand"), "expected /customcommand to be registered");
	const customCommandControl = registeredCommands.get("customcommand");

	// 2. Test /customcommand create
	// Create Slash command "greet"
	const createSlashInteraction = fakeControlInteraction({
		subcommand: "create",
		options: {
			name: "greet",
			type: "slash",
			response: "Greetings {user}! Args: {args:1}",
			embed: true,
			description: "Greet a user",
		},
		client: ctx.client,
	});
	await customCommandControl.execute(createSlashInteraction);
	assert.strictEqual(createSlashInteraction.replies[0].content, "✅ Successfully created custom command `greet` (Type: slash).");

	// Create Text command "pong"
	const createTextInteraction = fakeControlInteraction({
		subcommand: "create",
		options: {
			name: "pong",
			type: "text",
			response: "Ping! {args:all}",
			embed: false,
		},
		client: ctx.client,
	});
	await customCommandControl.execute(createTextInteraction);
	assert.strictEqual(createTextInteraction.replies[0].content, "✅ Successfully created custom command `pong` (Type: text).");

	// Create User Context command "Profile Info"
	const createUserMenuInteraction = fakeControlInteraction({
		subcommand: "create",
		options: {
			name: "Profile Info",
			type: "user",
			response: "Target User mention: {args:1}, Username: {args:2}, ID: {args:3}",
			embed: false,
		},
		client: ctx.client,
	});
	await customCommandControl.execute(createUserMenuInteraction);
	assert.strictEqual(createUserMenuInteraction.replies[0].content, "✅ Successfully created custom command `Profile Info` (Type: user).");

	console.log("✅ Command creation tests passed");

	// 3. Test execution of custom slash command
	assert.ok(ctx.client.commands.has("greet"), "Expected custom command 'greet' to be registered in client.commands");
	const greetExecutor = ctx.client.commands.get("greet");
	const execSlashInteraction = fakeSlashInteraction("greet", { args: "bob" }, "test-guild", { id: "test-user" }, ctx.client);
	await greetExecutor.execute(execSlashInteraction);
	
	const embedReply = execSlashInteraction.replies[0].embeds[0];
	assert.ok(embedReply, "Expected an embed reply");
	assert.strictEqual(embedReply.data.description, "Greetings <@test-user>! Args: bob");

	console.log("✅ Custom slash command execution passed");

	// 4. Test execution of custom text (prefix) command
	const textReplies = [];
	const fakeMessage = {
		content: "!pong hello world",
		author: { id: "sender-id", username: "sender", bot: false },
		guild: { id: "test-guild", name: "Test Server" },
		reply: async (payload) => {
			textReplies.push(payload);
			return payload;
		},
	};
	await emitEvent("messageCreate", fakeMessage);
	assert.strictEqual(textReplies[0].content, "Ping! hello world");

	console.log("✅ Custom text command execution passed");

	// 5. Test execution of user context menu command
	const execUserMenuInteraction = fakeUserContextMenuInteraction(
		"Profile Info",
		{ id: "target-id", username: "targetuser" },
		"test-guild",
		{ id: "test-user" },
		ctx.client
	);
	await emitEvent("interactionCreate", execUserMenuInteraction);
	assert.strictEqual(
		execUserMenuInteraction.replies[0].content,
		"Target User mention: <@target-id>, Username: targetuser, ID: target-id"
	);

	console.log("✅ Custom user context menu command execution passed");

	// 6. Test /customcommand list
	const listInteraction = fakeControlInteraction({ subcommand: "list", client: ctx.client });
	await customCommandControl.execute(listInteraction);
	const listEmbed = listInteraction.replies[0].embeds[0];
	assert.ok(listEmbed, "Expected custom command list embed response");
	assert.ok(listEmbed.data.description.includes("• `Profile Info` (Context Menu) — Type: **user**"));
	assert.ok(listEmbed.data.description.includes("• `/greet` — Type: **slash**"));
	assert.ok(listEmbed.data.description.includes("• `!pong` — Type: **text**"));

	console.log("✅ Custom command listing tests passed");

	// 7. Test /customcommand show
	const showInteraction = fakeControlInteraction({
		subcommand: "show",
		options: { name: "greet" },
		client: ctx.client,
	});
	await customCommandControl.execute(showInteraction);
	const showEmbed = showInteraction.replies[0].embeds[0];
	assert.ok(showEmbed, "Expected custom command details embed response");
	assert.strictEqual(showEmbed.data.title, "🛠️ Custom Command: greet");

	console.log("✅ Custom command show tests passed");

	// 8. Test /customcommand edit
	const editInteraction = fakeControlInteraction({
		subcommand: "edit",
		options: {
			name: "greet",
			response: "Edited greetings {user}!",
			embed: false,
		},
		client: ctx.client,
	});
	await customCommandControl.execute(editInteraction);
	assert.strictEqual(editInteraction.replies[0].content, "✅ Successfully updated custom command `greet`.");

	// Log DB model store state & reply payload for debugging
	const CustomCommandModel = models.get("plugin_adb-plugin-custom-commands_customCommand");
	console.log("DEBUG: DB Store: ", CustomCommandModel._store);

	// Execute again to confirm update
	const execSlashInteraction2 = fakeSlashInteraction("greet", { args: "bob" }, "test-guild", { id: "test-user" }, ctx.client);
	await greetExecutor.execute(execSlashInteraction2);
	console.log("DEBUG: execSlashInteraction2.replies[0]: ", execSlashInteraction2.replies[0]);

	assert.strictEqual(execSlashInteraction2.replies[0].content, "Edited greetings <@test-user>!");

	console.log("✅ Custom command edit tests passed");

	// 9. Test /customcommand delete
	const deleteInteraction = fakeControlInteraction({
		subcommand: "delete",
		options: { name: "greet" },
		client: ctx.client,
	});
	await customCommandControl.execute(deleteInteraction);
	assert.strictEqual(deleteInteraction.replies[0].content, "✅ Successfully deleted custom command `greet` (Type(s): slash).");

	console.log("✅ Custom command deletion tests passed");

	console.log("🎉 All plugin tests completed successfully!");
}

main().catch((error) => {
	console.error("❌ Test harness failed:", error);
	process.exit(1);
});

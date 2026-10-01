"use strict";

const assert = require("node:assert/strict");
const { Collection, PermissionFlagsBits } = require("discord.js");
const { load, replaceVariables } = require("../index");
const schema = require("../models/customCommand");
const manifest = require("../plugin.json");
const { createMockCtx } = require("./mock-ctx");

const PLUGIN = "adb-plugin-custom-commands";
const types = { slash: 1, user: 2, message: 3 };

function validatePayload(payload) {
	assert.ok((payload.content?.length || 0) <= 2000, "Discord content limit: 2000");
	const embeds = (payload.embeds || []).map((embed) => embed.toJSON ? embed.toJSON() : embed);
	assert.ok(embeds.length <= 10, "Discord embed count limit: 10");
	let total = 0;
	for (const embed of embeds) {
		assert.ok((embed.description?.length || 0) <= 4096, "Discord description limit: 4096");
		total += (embed.title?.length || 0) + (embed.description?.length || 0) + (embed.footer?.text?.length || 0);
		for (const field of embed.fields || []) {
			assert.ok(field.value.length <= 1024, "Discord field value limit: 1024");
			total += field.name.length + field.value.length;
		}
	}
	assert.ok(total <= 6000, "Discord aggregate embed text limit: 6000");
}

function interaction(ctx, { name = "customcommand", type = 1, sub = "create", options = {}, guildId = "guild", allowed = true, deferred = false } = {}) {
	const calls = [];
	const replies = [];
	const api = [];
	const discordCommands = new Collection();
	return {
		guildId, commandName: name, commandType: type, user: { id: "user" }, client: ctx.client,
		memberPermissions: { has: (permission) => permission === PermissionFlagsBits.ManageGuild && allowed },
		member: { roles: { cache: new Collection() } },
		guild: guildId ? {
			id: guildId, name: "Server", commands: {
				create: async (data) => { api.push(["create", data]); return data; },
				fetch: async () => discordCommands,
				delete: async (id) => api.push(["delete", id]),
				edit: async (id, data) => api.push(["edit", id, data]),
			},
		} : null,
		isChatInputCommand: () => type === 1,
		isUserContextMenuCommand: () => type === 2,
		isMessageContextMenuCommand: () => type === 3,
		targetUser: { id: "target", username: "Target" },
		targetMessage: { id: "message", author: { id: "author", username: "Author" }, content: "Quoted text" },
		options: { getSubcommand: () => sub, getString: (key) => options[key] ?? null, getBoolean: (key) => options[key] ?? null },
		deferred, replied: false, replies, calls, api, discordCommands,
		async deferReply(payload) {
			assert.ok(!this.deferred && !this.replied, "must not defer an acknowledged interaction");
			this.deferred = true;
			calls.push(["defer", payload]);
		},
		async reply(payload) {
			assert.ok(!this.deferred && !this.replied, "reply cannot follow deferReply");
			validatePayload(payload);
			this.replied = true;
			calls.push(["reply", payload]);
			replies.push(payload);
		},
		async editReply(payload) {
			assert.ok(this.deferred || this.replied, "editReply requires acknowledgement");
			validatePayload(payload);
			this.replied = true;
			calls.push(["edit", payload]);
			replies.push(payload);
		},
		async followUp(payload) {
			assert.ok(this.deferred || this.replied);
			validatePayload(payload);
			calls.push(["followUp", payload]);
			replies.push(payload);
		},
	};
}

async function setup(commands = [], occupied = []) {
	const mock = createMockCtx({ pluginName: PLUGIN });
	const errors = [];
	mock.ctx.logger.error = (...args) => errors.push(args);
	mock.ctx.logger.warn = (...args) => errors.push(args);
	const model = mock.ctx.defineModel("customCommand", schema);
	for (const command of commands) await model.create({ guildId: "guild", response: "Hello {user}", ...command });
	for (const command of occupied) mock.ctx.client.commands.set(command.data.name, command);
	await load(mock.ctx);
	return {
		...mock, model, errors,
		usage: mock.models.get(`plugin_${PLUGIN}_usage`),
		control: mock.registeredCommands.get("customcommand"),
	};
}

module.exports = async function regressions() {
	let passed = 0;
	const failures = [];
	async function test(name, run) {
		try {
			await run();
			passed++;
			console.log(`PASS ${name}`);
		} catch (error) {
			failures.push(name);
			console.error(`FAIL ${name}: ${error.stack}`);
		}
	}

	await test("manifest explicitly discloses raw-client in both permission systems", async () => {
		assert.ok(manifest.permissions.system?.includes("raw-client"));
		assert.ok(manifest.capabilities.system?.includes("raw-client"));
		assert.equal(manifest.process.model, "persistent");
		assert.match(manifest.process.persistentReason, /raw-client/);
		assert.notEqual(manifest.isolation, false, "do not use an isolation override instead of permissions");
	});

	await test("load registers slash and both context types with guild-scoped sync metadata", async () => {
		const { registeredCommands } = await setup([
			{ name: "greet", type: "slash", description: "First guild" },
			{ name: "greet", type: "slash", guildId: "other", description: "Second guild" },
			{ name: "Profile", type: "user" }, { name: "Quote", type: "message" }, { name: "text", type: "text" },
		]);
		for (const [name, type] of [["greet", 1], ["Profile", 2], ["Quote", 3]]) {
			const command = registeredCommands.get(name);
			assert.ok(command, `${name} must be registered through ctx.registerCommand`);
			assert.equal(command.data.type, type);
			assert.ok(command.guildIds.includes("guild"));
		}
		const greet = registeredCommands.get("greet");
		assert.deepEqual(greet.guildIds.sort(), ["guild", "other"]);
		assert.equal(greet.guildData.guild.description, "First guild");
		assert.equal(greet.guildData.other.description, "Second guild");
		assert.ok(!registeredCommands.has("text"));
	});

	await test("runtime creation registers every application type through the owning context", async () => {
		const { ctx, control, registeredCommands } = await setup();
		for (const [type, discordType] of Object.entries(types)) {
			const input = interaction(ctx, { options: { name: type, type, response: "Hi", description: "Description" } });
			await control.execute(input);
			assert.match(input.replies[0].content, /Successfully created/);
			assert.equal(registeredCommands.get(type)?.data.type, discordType);
			assert.deepEqual(registeredCommands.get(type).guildIds, ["guild"]);
			assert.equal(input.api[0][1].type, discordType);
			if (type !== "slash") assert.ok(!input.api[0][1].description);
		}
	});

	await test("foreign and control-command names are rejected before database or Discord writes", async () => {
		const foreign = { data: { name: "ping" }, execute: async () => {} };
		const { ctx, model, control } = await setup([], [foreign]);
		for (const name of ["ping", "customcommand"]) {
			for (const type of Object.keys(types)) {
				const input = interaction(ctx, { options: { name, type, response: "Must not shadow" } });
				await control.execute(input);
				assert.match(input.replies[0].content, /already|reserved|conflict/i);
				assert.equal(input.api.length, 0);
			}
		}
		assert.equal(await model.countDocuments({}), 0);
		assert.equal(ctx.client.commands.get("ping"), foreign);
	});

	await test("persisted collisions cannot hijack context interactions or block unrelated registrations", async () => {
		const foreign = { data: { name: "Profile", type: 2 }, execute: async () => {} };
		const { ctx, emitEvent, registeredCommands, model } = await setup([
			{ name: "Profile", type: "user" }, { name: "safe", type: "slash" },
		], [foreign]);
		assert.equal(ctx.client.commands.get("Profile"), foreign);
		assert.ok(registeredCommands.has("safe"));
		assert.equal(await model.countDocuments({}), 2, "do not delete persisted user data to resolve conflicts");
		const input = interaction(ctx, { name: "Profile", type: 2 });
		await emitEvent("interactionCreate", input);
		assert.equal(input.replies.length, 0);
	});

	await test("management requires Manage Server at runtime and rejects DMs", async () => {
		const { ctx, control, model } = await setup([{ name: "existing", type: "text" }]);
		assert.equal(control.data.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
		for (const sub of ["create", "edit", "delete"]) {
			const input = interaction(ctx, { sub, allowed: false, options: { name: "existing", type: "text", response: "Changed" } });
			await control.execute(input);
			assert.match(input.replies[0].content, /Manage Server/i);
			assert.equal(input.api.length, 0);
		}
		const dm = interaction(ctx, { guildId: null, options: { name: "dm", type: "text", response: "No" } });
		await control.execute(dm);
		assert.match(dm.replies[0].content, /server|guild/i);
		assert.equal(await model.countDocuments({}), 1);
		assert.equal((await model.findOne({ name: "existing" })).response, "Hello {user}");
	});

	await test("management defers before I/O and respects an existing defer", async () => {
		const { ctx, control, model } = await setup();
		const input = interaction(ctx, { options: { name: "managed", type: "slash", response: "Hi" } });
		const findOne = model.findOne;
		model.findOne = (...args) => { assert.ok(input.deferred); return findOne(...args); };
		await control.execute(input);
		model.findOne = findOne;
		assert.equal(input.calls[0][0], "defer");
		assert.equal(input.calls[0][1].ephemeral, true);
		assert.equal(input.replies.length, 1);
		for (const sub of ["edit", "delete"]) {
			const edit = interaction(ctx, { sub, deferred: true, options: { name: "managed", response: "Updated" } });
			await control.execute(edit);
			assert.deepEqual(edit.calls.map(([method]) => method), ["edit"]);
		}
	});

	await test("slash and context executors finish deferred replies once, even with duplicate routing", async () => {
		const { ctx, emitEvent, registeredCommands, usage } = await setup([
			{ name: "greet", type: "slash" }, { name: "Profile", type: "user", response: "{args:2}" }, { name: "Quote", type: "message", response: "{args:2}" },
		]);
		for (const [name, type, expected] of [["greet", 1, "Hello <@user>"], ["Profile", 2, "Target"], ["Quote", 3, "Quoted text"]]) {
			const input = interaction(ctx, { name, type, deferred: true });
			const command = registeredCommands.get(name);
			assert.ok(command);
			await Promise.all([command.execute(input), emitEvent("interactionCreate", input)]);
			assert.deepEqual(input.calls.map(([method]) => method), ["edit"]);
			assert.equal(input.replies[0].content, expected);
			assert.equal((await usage.findOne({ name })).uses, 1);
		}
	});

	await test("all application execution paths enforce live command and role configuration", async () => {
		const { ctx, registeredCommands, emitEvent, usage } = await setup([{ name: "greet", type: "slash" }, { name: "Profile", type: "user" }]);
		for (const [name, type] of [["greet", 1], ["Profile", 2]]) {
			const run = (input) => type === 1 ? ctx.client.commands.get(name).execute(input) : emitEvent("interactionCreate", input);
			for (const config of [{ enabled: false }, { _commands: { [name]: { enabled: false } } }, { _commands: { [name]: { allowedRoles: ["allowed"] } } }]) {
				await ctx.db.updatePluginConfig("guild", PLUGIN, config);
				const denied = interaction(ctx, { name, type });
				await run(denied);
				assert.match(denied.replies[0].content, /disabled|required role|not allowed/i);
				assert.equal(await usage.countDocuments({}), 0);
			}
			const allowed = interaction(ctx, { name, type });
			allowed.member.roles = ["allowed"];
			await run(allowed);
			assert.equal(allowed.replies[0].content, "Hello <@user>");
			await usage.deleteMany({});
			assert.ok(registeredCommands.has(name));
		}
	});

	await test("text commands honor live prefix and permissions without usage for denied calls", async () => {
		const { ctx, emitEvent, usage } = await setup([{ name: "echo", type: "text", response: "{args:all}" }]);
		const replies = [];
		const message = { author: { id: "user" }, guild: { id: "guild", name: "Server" }, member: { roles: ["allowed"] }, content: "?echo hi", reply: async (payload) => replies.push(payload) };
		await ctx.db.updatePluginConfig("guild", PLUGIN, { prefix: "?", enabled: false });
		await emitEvent("messageCreate", message);
		assert.equal(replies.length, 0);
		await ctx.db.updatePluginConfig("guild", PLUGIN, { prefix: "?", _commands: { echo: { enabled: false } } });
		await emitEvent("messageCreate", message);
		assert.equal(replies.length, 0);
		assert.equal(await usage.countDocuments({}), 0);
		await ctx.db.updatePluginConfig("guild", PLUGIN, { prefix: "?", _commands: { echo: { allowedRoles: ["allowed"] } } });
		await emitEvent("messageCreate", message);
		assert.equal(replies[0].content, "hi");
	});

	await test("deletion updates guild scope and removes only executors still owned by this load", async () => {
		const { ctx, control, registeredCommands } = await setup([{ name: "greet", type: "slash" }, { name: "greet", type: "slash", guildId: "other" }]);
		const original = registeredCommands.get("greet");
		await control.execute(interaction(ctx, { sub: "delete", options: { name: "greet" } }));
		assert.deepEqual(ctx.client.commands.get("greet").guildIds, ["other"]);
		await control.execute(interaction(ctx, { sub: "delete", guildId: "other", options: { name: "greet" } }));
		assert.ok(!ctx.client.commands.has("greet"));
		assert.deepEqual(original.guildIds, [], "stale references must not execute deleted commands");
		const foreign = { data: { name: "greet" }, execute: async () => {} };
		ctx.client.commands.set("greet", foreign);
		await ctx.hooks.emitHook("onPluginUnload", { pluginName: PLUGIN });
		assert.equal(ctx.client.commands.get("greet"), foreign);
	});

	await test("a delayed deletion cannot remove a newly recreated command with the same name", async () => {
		const { ctx, control, model } = await setup([{ name: "greet", type: "slash" }]);
		const deletion = interaction(ctx, { sub: "delete", options: { name: "greet" } });
		deletion.discordCommands.set("command", { id: "command", name: "greet", type: 1 });
		let release;
		let started;
		const blocked = new Promise((resolve) => { release = resolve; });
		const fetching = new Promise((resolve) => { started = resolve; });
		deletion.guild.commands.fetch = async () => { started(); await blocked; return deletion.discordCommands; };
		const deleting = control.execute(deletion);
		await fetching;
		const creation = interaction(ctx, { options: { name: "greet", type: "slash", response: "Recreated" } });
		await control.execute(creation);
		release();
		await deleting;
		assert.deepEqual(deletion.api, []);
		assert.equal((await model.findOne({ name: "greet" })).response, "Recreated");
		assert.deepEqual(ctx.client.commands.get("greet").guildIds, ["guild"]);
	});

	await test("a delayed registry refresh cannot restore a concurrently deleted command", async () => {
		const { ctx, control, model } = await setup([{ name: "greet", type: "slash" }]);
		const find = model.find;
		let release;
		let entered;
		let stalled = false;
		const blocked = new Promise((resolve) => { release = resolve; });
		const reading = new Promise((resolve) => { entered = resolve; });
		model.find = (query = {}) => {
			if (Object.keys(query).length || stalled) return find(query);
			stalled = true;
			const snapshot = model._store.map((row) => ({ ...row }));
			entered();
			return blocked.then(() => snapshot);
		};
		const editing = control.execute(interaction(ctx, { sub: "edit", options: { name: "greet", response: "Updated" } }));
		await reading;
		const deleting = control.execute(interaction(ctx, { sub: "delete", options: { name: "greet" } }));
		try {
			await new Promise(setImmediate);
		} finally {
			release();
		}
		await Promise.all([editing, deleting]);
		assert.equal(await model.countDocuments({}), 0);
		assert.equal(ctx.client.commands.has("greet"), false, "stale query results must not restore deleted sync metadata");
	});

	await test("malformed command restrictions fail closed in application and prefix paths", async () => {
		const { ctx, emitEvent, usage } = await setup([
			{ name: "greet", type: "slash" }, { name: "Profile", type: "user" }, { name: "greet", type: "text" },
		]);
		for (const restriction of [{ enabled: "false" }, { allowedRoles: "staff" }, { allowedRoles: null }, { allowedRoles: [123] }]) {
			await ctx.db.updatePluginConfig("guild", PLUGIN, { _commands: { greet: restriction, Profile: restriction } });
			for (const [name, type] of [["greet", 1], ["Profile", 2]]) {
				const input = interaction(ctx, { name, type });
				if (type === 1) await ctx.client.commands.get(name).execute(input);
				else await emitEvent("interactionCreate", input);
				assert.match(input.replies[0].content, /disabled|required role|not allowed/i);
			}
			const replies = [];
			await emitEvent("messageCreate", { content: "!greet", author: { id: "user" }, guild: { id: "guild" }, reply: async (payload) => replies.push(payload) });
			assert.equal(replies.length, 0);
			assert.equal(await usage.countDocuments({}), 0);
		}
	});

	await test("description edits update guild-specific sync metadata", async () => {
		const { ctx, control, registeredCommands } = await setup([{ name: "greet", type: "slash", description: "Original" }, { name: "greet", type: "slash", guildId: "other", description: "Other" }]);
		await control.execute(interaction(ctx, { sub: "edit", options: { name: "greet", description: "Updated" } }));
		const command = registeredCommands.get("greet");
		assert.equal(command.guildData.guild.description, "Updated");
		assert.equal(command.guildData.other.description, "Other");
	});

	await test("description edits work with hydrated mongoose documents, not only plain test records", async () => {
		const mongoose = require("mongoose");
		const HydratedCommand = new mongoose.Mongoose().model("OfflineCommand", schema);
		const { ctx, control, model } = await setup([{ _id: new mongoose.Types.ObjectId(), name: "greet", type: "slash" }]);
		const find = model.find;
		model.find = async (query) => (await find(query)).map((doc) => HydratedCommand.hydrate(doc));
		const input = interaction(ctx, { sub: "edit", options: { name: "greet", description: "Changed on Discord" } });
		input.discordCommands.set("command", { id: "command", name: "greet", type: 1 });
		await control.execute(input);
		assert.deepEqual(input.api, [["edit", "command", { description: "Changed on Discord" }]]);
		assert.match(input.replies[0].content, /Successfully updated/);
	});

	await test("wrong-guild and wrong-type invocations cannot execute a registered command", async () => {
		const { ctx, registeredCommands, usage } = await setup([{ name: "greet", type: "slash" }]);
		for (const options of [{ guildId: "other" }, { type: 2 }]) {
			const input = interaction(ctx, { name: "greet", ...options });
			await registeredCommands.get("greet").execute(input);
			assert.match(input.replies[0].content, /not found/i);
		}
		assert.equal(await usage.countDocuments({}), 0);
	});

	await test("runtime creation in another guild extends existing registration metadata", async () => {
		const { ctx, control, registeredCommands } = await setup([{ name: "greet", type: "slash", description: "Original" }]);
		const input = interaction(ctx, { guildId: "other", options: { name: "greet", type: "slash", description: "Other", response: "Other guild" } });
		await control.execute(input);
		assert.match(input.replies[0].content, /Successfully created/);
		assert.deepEqual(registeredCommands.get("greet").guildIds.sort(), ["guild", "other"]);
		assert.equal(registeredCommands.get("greet").guildData.other.description, "Other");
		const execute = interaction(ctx, { name: "greet", guildId: "other" });
		await registeredCommands.get("greet").execute(execute);
		assert.equal(execute.replies[0].content, "Other guild");
	});

	await test("a colliding stored command cannot edit or delete another plugin's Discord command", async () => {
		const foreign = { data: { name: "ping", type: 1 }, execute: async () => {} };
		const { ctx, control } = await setup([{ name: "ping", type: "slash" }], [foreign]);
		for (const sub of ["edit", "delete"]) {
			const input = interaction(ctx, { sub, options: { name: "ping", description: "Hijacked" } });
			input.discordCommands.set("foreign-id", { id: "foreign-id", name: "ping", type: 1 });
			await control.execute(input);
			assert.deepEqual(input.api, []);
			assert.equal(ctx.client.commands.get("ping"), foreign);
		}
	});

	await test("Discord registration failures are reported, with saved metadata available for retry", async () => {
		const { ctx, control, registeredCommands, model } = await setup();
		const input = interaction(ctx, { options: { name: "retry", type: "slash", response: "Hi" } });
		input.guild.commands.create = async () => { throw new Error("Missing permissions"); };
		await control.execute(input);
		assert.match(input.replies[0].content, /failed|unable/i);
		assert.doesNotMatch(input.replies[0].content, /Successfully created/);
		assert.ok(await model.findOne({ name: "retry" }));
		assert.deepEqual(registeredCommands.get("retry").guildIds, ["guild"]);
	});

	await test("usage models are isolated between two plugin loads", async () => {
		const first = await setup([{ name: "echo", type: "text" }]);
		const second = await setup([{ name: "echo", type: "text" }]);
		await first.emitEvent("messageCreate", { content: "!echo", author: { id: "user" }, guild: { id: "guild" }, reply: async () => {} });
		assert.equal((await first.usage.findOne({ name: "echo" }))?.uses, 1);
		assert.equal(await second.usage.countDocuments({}), 0);
	});

	await test("name-keyed runtime refuses conflicting custom command types without corrupting existing commands", async () => {
		const { ctx, control, model } = await setup([{ name: "greet", type: "slash" }]);
		const existing = ctx.client.commands.get("greet");
		const input = interaction(ctx, { options: { name: "greet", type: "user", response: "No" } });
		await control.execute(input);
		assert.match(input.replies[0].content, /already|conflict/i);
		assert.equal(await model.countDocuments({}), 1);
		assert.equal(ctx.client.commands.get("greet"), existing);
		assert.equal(input.api.length, 0);
	});

	await test("variables preserve literal dollar signs and do not expand inserted placeholders", async () => {
		const server = "{args:1} $& $$";
		const args = ["{args:all}", "$&"];
		assert.equal(replaceVariables("{server}|{args:1}|{args:all}", { guild: { name: server }, args }), `${server}|${args[0]}|${args.join(" ")}`);
		assert.equal(replaceVariables("{args:2}", { targetMessage: { content: "{args:all}" } }), "{args:all}");
	});

	await test("show previews long fields without altering saved templates or exceeding Discord limits", async () => {
		const response = "long template ".repeat(200);
		const description = "description ".repeat(200);
		const { ctx, control, model } = await setup(["slash", "text", "user", "message"].map((type) => ({ name: "shared", type, response, description })));
		const input = interaction(ctx, { sub: "show", options: { name: "shared" } });
		await control.execute(input);
		assert.equal(input.replies.flatMap((payload) => payload.embeds).length, 4);
		assert.ok(input.replies.every((payload) => payload.ephemeral === true));
		for (const row of model._store) assert.equal(row.response, response);
	});

	await test("large command lists keep every name reachable within Discord reply limits", async () => {
		const names = Array.from({ length: 100 }, (_, i) => `command_${i}`.padEnd(32, "x"));
		const { ctx, control } = await setup(names.map((name) => ({ name, type: "text" })));
		const input = interaction(ctx, { sub: "list" });
		await control.execute(input);
		const descriptions = input.replies.flatMap((payload) => payload.embeds.map((embed) => embed.toJSON().description)).join("\n");
		for (const name of names) assert.ok(descriptions.includes(name), `missing ${name}`);
		assert.ok(input.replies.length > 1);
		assert.ok(input.replies.every((payload) => payload.ephemeral === true));
		assert.equal(input.calls.filter(([method]) => method === "edit").length, 1);
	});

	await test("expanded application and text responses fit the selected Discord payload type", async () => {
		for (const type of ["slash", "text"]) for (const embed of [false, true]) {
			const response = "{args:all}".repeat(5);
			const { ctx, emitEvent, model } = await setup([{ name: "echo", type, embed, response }]);
			let replies;
			if (type === "slash") {
				const input = interaction(ctx, { name: "echo", options: { args: "x".repeat(1000) } });
				await ctx.client.commands.get("echo").execute(input);
				replies = input.replies;
			} else {
				replies = [];
				await emitEvent("messageCreate", {
					content: `!echo ${"x".repeat(1000)}`, author: { id: "user" }, guild: { id: "guild" },
					reply: async (payload) => { validatePayload(payload); replies.push(payload); },
				});
			}
			assert.equal(replies.length, 1);
			const content = embed ? replies[0].embeds?.[0].toJSON().description : replies[0].content;
			assert.equal(content, `${"x".repeat((embed ? 4096 : 2000) - 3)}...`);
			assert.equal(model._store[0].response, response);
		}
	});

	console.log(`Custom command regressions: ${passed} passed, ${failures.length} failed`);
	assert.deepEqual(failures, []);
};

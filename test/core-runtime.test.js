const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

// Paired-repository integration test: ADB_CORE_PATH can select a different core checkout.
const core = process.env.ADB_CORE_PATH || path.resolve(__dirname, "../../Advanced-Discord-Bot");
const { PluginManager } = require(path.join(core, "core/PluginManager"));
const { HookBus } = require(path.join(core, "core/HookBus"));
const { guildCommandBody } = require(path.join(core, "core/command-sync"));
const { fakeCollection } = require(path.join(core, "test/worker-model-roundtrip.test"));
const mongoose = require(path.join(core, "node_modules/mongoose"));
const manifest = require("../plugin.json");
const pluginName = manifest.name;

async function setup(t, seeds) {
	const client = new EventEmitter();
	client.commands = new Map();
	const hooks = new HookBus();
	const manager = new PluginManager({ client, hooks, scheduler: {}, db: { getPluginConfig: async () => ({ data: {} }) } });
	client.pluginManager = manager;
	client.hooks = hooks;
	manager.enableIsolation();
	manager.grantedEnv = () => ({}); // The environment boundary is empty in this test, never the host's secrets.
	const administration = manager.initPluginState("administration", { version: "2.0.0" });
	administration.loaded = true;
	manager.plugins.set("administration", administration);
	const models = [];
	for (const [name, schema] of [["customCommand", require("../models/customCommand")], ["usage", require("../models/usage")]]) {
		const Model = mongoose.model(`plugin_${pluginName}_${name}`, schema);
		fakeCollection(Model);
		models.push(Model);
	}
	t.after(async () => {
		await manager.shutdown();
		for (const Model of models) mongoose.deleteModel(Model.modelName);
	});
	for (const seed of seeds) await models[0].create(seed);
	await manager.loadPlugin({ name: pluginName, manifest, source: "package", basePath: path.resolve(__dirname, ".."), entryPath: path.resolve(__dirname, "../index.js") });
	assert.equal(manager.plugins.get(pluginName).loaded, true, manager.plugins.get(pluginName).lastError);
	return { client, hooks, manager, models };
}

function interaction(guildId, name, type = 1, options = {}) {
	return {
		guildId, commandName: name, commandType: type,
		guild: { id: guildId, name: guildId, commands: { fetch: async () => [], delete: async () => {} } },
		user: { id: "user", username: "User" }, targetUser: { id: "target", username: "Target" },
		memberPermissions: { bitfield: 8n, has: () => true }, replies: [],
		isChatInputCommand: () => type === 1,
		isUserContextMenuCommand: () => type === 2,
		isMessageContextMenuCommand: () => type === 3,
		options: { getSubcommand: () => options.subcommand, getString: (key) => options[key] ?? null },
		async deferReply() { this.deferred = true; },
		async reply(payload) { this.replied = true; this.replies.push(payload); },
		async editReply(payload) { this.replied = true; this.replies.push(payload); },
		async followUp(payload) { this.replies.push(payload); },
	};
}

test("real custom plugin loads per-guild definitions and deletion releases ownership without deleting replacements", async (t) => {
	const f = await setup(t, [
		{ guildId: "first", name: "greet", type: "slash", response: "first", description: "First definition" },
		{ guildId: "second", name: "greet", type: "slash", response: "second", description: "Second definition" },
		{ guildId: "first", name: "Profile", type: "user", response: "{args:2}" },
		{ guildId: "second", name: "Quote", type: "message", response: "{args:2}" },
	]);
	const body = (guild) => guildCommandBody(f.manager, f.client, guild);
	assert.equal(body("first").find((command) => command.name === "greet").description, "First definition");
	assert.equal(body("second").find((command) => command.name === "greet").description, "Second definition");
	assert.equal(body("first").find((command) => command.name === "Profile").type, 2);
	assert.equal(body("second").find((command) => command.name === "Quote").type, 3);
	assert.deepEqual(body("third").map((command) => command.name), ["customcommand"]);
	const control = f.client.commands.get("customcommand");
	await control.execute(interaction("first", "customcommand", 1, { subcommand: "delete", name: "greet" }));
	assert.equal(body("first").some((command) => command.name === "greet"), false);
	assert.equal(body("second").some((command) => command.name === "greet"), true);
	await control.execute(interaction("second", "customcommand", 1, { subcommand: "delete", name: "greet" }));
	assert.equal(f.client.commands.has("greet"), false);
	f.manager.plugins.set("replacement", f.manager.initPluginState("replacement", {}));
	const replacement = { data: { name: "greet", description: "Replacement" }, execute() {} };
	f.manager.registerCommand("replacement", replacement);
	await f.manager.unloadPlugin(pluginName);
	assert.equal(f.client.commands.get("greet"), replacement);
	assert.equal(f.client.listenerCount("messageCreate"), 0);
	assert.equal(f.hooks.handlers.get("onPluginUnload").length, 0);
});

test("context fallback yields to the core dispatch marker, and still works without the core dispatcher", async (t) => {
	const f = await setup(t, [{ guildId: "first", name: "Profile", type: "user", response: "{args:2}" }]);
	const command = f.client.commands.get("Profile");
	const execute = command.execute;
	let invocations = 0;
	command.execute = (input) => { invocations++; return execute(input); };
	const coreState = f.manager.initPluginState("core", {});
	coreState.loaded = true;
	f.manager.plugins.set("core", coreState);
	f.manager.registerEvent("core", "interactionCreate", require(path.join(core, "events/interactionCreate")).execute);
	assert.equal(f.client.runtimeCommandDispatch, true);
	const first = interaction("first", "Profile", 2);
	await Promise.all(f.client.listeners("interactionCreate").map((listener) => listener(first)));
	assert.equal(invocations, 1);
	assert.equal(first.replies[0].content, "Target");
	f.manager.clearPluginRegistrations("core");
	assert.equal(f.client.runtimeCommandDispatch, false);
	const fallback = interaction("first", "Profile", 2);
	await Promise.all(f.client.listeners("interactionCreate").map((listener) => listener(fallback)));
	assert.equal(invocations, 2);
	assert.equal(fallback.replies[0].content, "Target");
});

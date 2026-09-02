const { Schema } = require("mongoose");

// Per-user custom command usage for the member-scope /me/command-usage page.
// One doc per (guild, user, command name); written at both execution paths.
module.exports = new Schema({
	guildId: { type: String, required: true, index: true },
	userId: { type: String, required: true, index: true },
	name: { type: String, required: true },
	uses: { type: Number, default: 0 },
	lastUsedAt: { type: Date, default: Date.now },
});

const { Schema } = require("mongoose");

const customCommandSchema = new Schema({
	guildId: { type: String, required: true, index: true },
	name: { type: String, required: true },
	type: { type: String, required: true, enum: ["slash", "text", "user", "message"] },
	response: { type: String, required: true },
	embed: { type: Boolean, default: false },
	description: { type: String, default: "Custom command" },
	createdAt: { type: Date, default: Date.now },
	updatedAt: { type: Date, default: Date.now },
});

// Ensure a guild cannot have duplicate custom commands with the same name and type
customCommandSchema.index({ guildId: 1, name: 1, type: 1 }, { unique: true });

module.exports = customCommandSchema;

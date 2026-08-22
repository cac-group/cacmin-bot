/** Database entity types - snake_case matches SQLite columns */

export interface User {
	id: number; // Telegram user ID
	username: string;
	whitelist: boolean; // Exempt from restrictions
	blacklist: boolean; // Blocked from group
	role: "owner" | "admin" | "elevated" | "pleb";
	warning_count: number;
	muted_until?: number; // Unix timestamp
	created_at: number;
	updated_at: number;
}

export interface GlobalAction {
	id: number;
	restriction: string;
	restrictedAction?: string;
	metadata?: string;
	restrictedUntil?: number; // Unix timestamp, undefined = permanent
	createdAt: number;
}

export interface Violation {
	id: number;
	userId: number;
	ruleId: number;
	restriction: string;
	message?: string;
	timestamp: number;
	bailAmount: number; // JUNO tokens
	paid: boolean;
	paymentTx?: string;
	paidByUserId?: number;
	paidAt?: number;
}

export interface JailEvent {
	id: number;
	userId: number;
	eventType: "jailed" | "unjailed" | "auto_unjailed" | "bail_paid";
	adminId?: number;
	durationMinutes?: number;
	bailAmount: number; // JUNO tokens
	paidByUserId?: number;
	paymentTx?: string;
	timestamp: number;
	metadata?: string; // JSON-encoded
}

export interface UserRestriction {
	id: number;
	userId: number;
	restriction:
		| "no_stickers"
		| "no_urls"
		| "regex_block"
		| "random_delete"
		| "no_media"
		| "no_photos"
		| "no_videos"
		| "no_documents"
		| "muted"
		| "no_gifs"
		| "no_specific_gif"
		| "no_voice"
		| "no_forwarding";
	restrictedAction?: string; // Sticker pack ID, domain, regex pattern, or gif file_unique_id
	metadata?: string; // JSON-encoded
	restrictedUntil?: number; // Unix timestamp, undefined = permanent
	severity: "delete" | "mute" | "jail"; // Penalty severity
	violationThreshold: number; // Violations before auto-jail
	autoJailDuration: number; // Auto-jail duration in minutes (default 2880 = 2 days)
	autoJailFine: number; // JUNO fine amount to unjail
	fineAmount?: number; // Optional fine for this specific restriction
	customMessage?: string; // Optional custom violation message
	createdAt: number;
}

export type RestrictionType =
	| "no_stickers"
	| "no_urls"
	| "regex_block"
	| "random_delete"
	| "no_media"
	| "no_photos"
	| "no_videos"
	| "no_documents"
	| "no_gifs"
	| "no_specific_gif"
	| "no_voice"
	| "no_forwarding"
	| "muted";

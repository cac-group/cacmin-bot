/**
 * Human-readable labels for restriction types.
 *
 * Stored identifiers stay stable (DB rows, command parsing); only what users
 * see is translated, so `no_specific_gif` renders as "banned gif".
 *
 * @module utils/restrictionLabels
 */

const RESTRICTION_LABELS: Record<string, string> = {
	no_stickers: "no stickers",
	no_urls: "no links",
	no_media: "no media",
	no_photos: "no photos",
	no_videos: "no videos",
	no_documents: "no documents",
	no_gifs: "no GIFs",
	no_specific_gif: "banned gif",
	no_voice: "no voice messages",
	no_forwarding: "no forwarding",
	regex_block: "blocked text pattern",
	random_delete: "random deletion",
	muted: "muted",
};

/**
 * Translate a restriction identifier into a user-facing label.
 *
 * @param restriction - Stored restriction identifier
 * @returns Friendly label, falling back to the identifier with underscores spaced
 */
export function restrictionLabel(restriction: string): string {
	return RESTRICTION_LABELS[restriction] ?? restriction.replace(/_/g, " ");
}

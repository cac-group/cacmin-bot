/**
 * Logger utility module for the CAC Admin Bot.
 *
 * Structured console logging with levels. The service manager (systemd/journald)
 * captures stdout/stderr and owns rotation, so there are no file transports and
 * no logging dependency.
 *
 * @module utils/logger
 */

/**
 * Context metadata for structured logging.
 */
export interface LogContext {
	/** Telegram user ID */
	userId?: number;
	/** Username */
	username?: string;
	/** Transaction ID */
	txId?: string;
	/** Transaction hash */
	txHash?: string;
	/** Amount involved */
	amount?: string | number;
	/** Operation type */
	operation?: string;
	/** Primary log category, rendered as [TAG] (e.g. admin, user, security, transaction, config, moderation, system). */
	tag?: string;
	/** Specific action type, rendered as [SUBTAG] after the tag (e.g. setratelimit, deposit, jail). */
	subtag?: string;
	/** Additional metadata */
	[key: string]: unknown;
}

type Level = "error" | "warn" | "info" | "debug";

const LEVELS: Record<Level, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Gets the log level from the environment (error, warn, info, debug). */
const currentLevel = (): number => {
	const configured = (process.env.LOG_LEVEL || "info").toLowerCase() as Level;
	return LEVELS[configured] ?? LEVELS.info;
};

/** Serialize Error values inside metadata instead of collapsing them to `{}`. */
const errorReplacer = (_key: string, value: unknown): unknown =>
	value instanceof Error
		? { message: value.message, stack: value.stack }
		: value;

/** `YYYY-MM-DD HH:MM:SS` in local time. */
const timestamp = (): string => {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const formatMeta = (meta: Record<string, unknown>): string => {
	if (Object.keys(meta).length === 0) return "";
	if (meta.stack) return `\n${meta.stack}`;
	return ` ${JSON.stringify(meta, errorReplacer)}`;
};

const emit = (level: Level, message: string, meta?: unknown): void => {
	if (LEVELS[level] > currentLevel()) return;

	// winston parity: a bare Error second arg contributes its message to the
	// line and its stack to the metadata (Errors have no enumerable props).
	let lineMessage = message;
	let record: Record<string, unknown> = {};
	if (meta instanceof Error) {
		lineMessage = `${message} ${meta.message}`;
		record = { stack: meta.stack };
	} else if (meta && typeof meta === "object") {
		record = meta as Record<string, unknown>;
	}

	const { tag, subtag, ...rest } = record;
	let line = `[${timestamp()}] [${level.toUpperCase()}]`;
	if (tag) line += ` [${String(tag).toUpperCase()}]`;
	if (subtag) line += `[${String(subtag).toUpperCase()}]`;
	line += ` ${lineMessage}${formatMeta(rest)}`;

	const stream = level === "error" ? process.stderr : process.stdout;
	stream.write(`${line}\n`);
};

/**
 * Main logger instance.
 *
 * @example
 * ```typescript
 * logger.info('User action', { userId: 123, action: 'deposit' });
 * logger.error('Transaction failed', { error, txId: '123' });
 * logger.debug('Validation check', { field: 'amount', value: 100 });
 * ```
 */
export const logger = {
	info: (message: string, meta?: unknown) => emit("info", message, meta),
	warn: (message: string, meta?: unknown) => emit("warn", message, meta),
	error: (message: string, meta?: unknown) => emit("error", message, meta),
	debug: (message: string, meta?: unknown) => emit("debug", message, meta),
};

/**
 * Helper class for structured logging with consistent context.
 * Provides domain-specific logging methods for common operations.
 */
export class StructuredLogger {
	/**
	 * Logs a user action with context.
	 */
	static logUserAction(action: string, context: LogContext): void {
		logger.info(
			action,
			StructuredLogger.sanitizeContext({ tag: "user", ...context }),
		);
	}

	/**
	 * Logs a transaction event with context.
	 */
	static logTransaction(event: string, context: LogContext): void {
		logger.info(
			event,
			StructuredLogger.sanitizeContext({ tag: "transaction", ...context }),
		);
	}

	/**
	 * Logs a security event (violations, restrictions, bans).
	 */
	static logSecurityEvent(event: string, context: LogContext): void {
		logger.warn(
			event,
			StructuredLogger.sanitizeContext({ tag: "security", ...context }),
		);
	}

	/**
	 * Logs an error with full context and stack trace.
	 */
	static logError(error: Error | string, context: LogContext = {}): void {
		if (error instanceof Error) {
			logger.error(error.message, {
				...StructuredLogger.sanitizeContext(context),
				stack: error.stack,
			});
		} else {
			logger.error(error, StructuredLogger.sanitizeContext(context));
		}
	}

	/**
	 * Logs a debug message (only in debug log level).
	 */
	static logDebug(message: string, context: LogContext = {}): void {
		logger.debug(message, StructuredLogger.sanitizeContext(context));
	}

	/**
	 * Sanitizes context to prevent logging sensitive data.
	 * Removes or masks sensitive fields like mnemonics, private keys, etc.
	 */
	private static sanitizeContext(context: LogContext): LogContext {
		const sanitized = { ...context };

		// List of sensitive keys to redact
		const sensitiveKeys = [
			"mnemonic",
			"privateKey",
			"password",
			"token",
			"secret",
		];

		for (const key of sensitiveKeys) {
			if (key in sanitized) {
				sanitized[key] = "[REDACTED]";
			}
		}

		return sanitized;
	}
}

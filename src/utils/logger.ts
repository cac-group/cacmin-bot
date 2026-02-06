/**
 * Logger utility module for the CAC Admin Bot.
 * Provides structured logging with Winston, including file rotation,
 * console output, and specialized handlers for errors and rejections.
 *
 * @module utils/logger
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as winston from "winston";

/**
 * Directory path for log files.
 * Logs are stored in the 'logs' directory at the project root.
 */
const logDir = path.join(__dirname, "../../logs");

// Ensure log directory exists
if (!fs.existsSync(logDir)) {
	fs.mkdirSync(logDir, { recursive: true });
}

/**
 * Custom format for log entries.
 * Combines timestamp, error stack traces, and metadata into a readable format.
 */
const logFormat = winston.format.combine(
	winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
	winston.format.errors({ stack: true }),
	winston.format.printf(({ timestamp, level, message, ...meta }) => {
		let msg = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
		if (Object.keys(meta).length > 0 && meta.stack) {
			msg += `\n${meta.stack}`;
		} else if (Object.keys(meta).length > 0) {
			msg += ` ${JSON.stringify(meta)}`;
		}
		return msg;
	}),
);

/**
 * Gets the log level from environment variables.
 * Reads directly from process.env to avoid circular dependency with config module.
 *
 * @returns The log level (error, warn, info, debug) - defaults to 'info'
 */
const getLogLevel = (): string => {
	return process.env.LOG_LEVEL || "info";
};

/**
 * Main Winston logger instance with multiple transports.
 *
 * Features:
 * - Console output with color coding
 * - Combined log file (all levels) with 10MB rotation, 5 files max
 * - Error log file (errors only) with 10MB rotation, 5 files max
 * - Exception handler for uncaught exceptions
 * - Rejection handler for unhandled promise rejections
 *
 * @example
 * ```typescript
 * logger.info('User action', { userId: 123, action: 'deposit' });
 * logger.error('Transaction failed', { error, txId: '123' });
 * logger.debug('Validation check', { field: 'amount', value: 100 });
 * ```
 */
export const logger = winston.createLogger({
	level: getLogLevel(),
	format: logFormat,
	transports: [
		// Console output (no colors when running under systemd/piped)
		new winston.transports.Console({
			format: process.stdout.isTTY
				? winston.format.combine(winston.format.colorize(), logFormat)
				: logFormat,
		}),
		// Combined log file with rotation
		new winston.transports.File({
			filename: path.join(logDir, "combined.log"),
			maxsize: 10485760, // 10MB
			maxFiles: 5,
			tailable: true,
		}),
		// Error log file with rotation
		new winston.transports.File({
			filename: path.join(logDir, "error.log"),
			level: "error",
			maxsize: 10485760, // 10MB
			maxFiles: 5,
			tailable: true,
		}),
	],
	exceptionHandlers: [
		new winston.transports.File({
			filename: path.join(logDir, "exceptions.log"),
			maxsize: 10485760, // 10MB
			maxFiles: 3,
		}),
	],
	rejectionHandlers: [
		new winston.transports.File({
			filename: path.join(logDir, "rejections.log"),
			maxsize: 10485760, // 10MB
			maxFiles: 3,
		}),
	],
});

/**
 * Updates the logger's level at runtime.
 * Useful for changing verbosity after initial configuration.
 *
 * @param level - The new log level (error, warn, info, debug)
 *
 * @example
 * ```typescript
 * updateLogLevel('debug'); // Enable debug logging
 * ```
 */
export const updateLogLevel = (level: string): void => {
	logger.level = level;
};

/**
 * Stream interface for Morgan or other middleware.
 * Redirects HTTP middleware logs to Winston.
 */
export const logStream = {
	write: (message: string) => {
		logger.info(message.trim());
	},
};

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
	amount?: string;
	/** Operation type */
	operation?: string;
	/** Additional metadata */
	[key: string]: unknown;
}

/**
 * Helper class for structured logging with consistent context.
 * Provides domain-specific logging methods for common operations.
 */
export class StructuredLogger {
	/**
	 * Logs a user action with context.
	 *
	 * @param action - Description of the action
	 * @param context - User and operation context
	 *
	 * @example
	 * ```typescript
	 * StructuredLogger.logUserAction('Wallet deposit initiated', {
	 *   userId: 12345,
	 *   username: 'alice',
	 *   amount: '100',
	 *   operation: 'deposit'
	 * });
	 * ```
	 */
	static logUserAction(action: string, context: LogContext): void {
		logger.info(action, StructuredLogger.sanitizeContext(context));
	}

	/**
	 * Logs a transaction event with context.
	 *
	 * @param event - Transaction event description
	 * @param context - Transaction context including txId, amount, etc.
	 *
	 * @example
	 * ```typescript
	 * StructuredLogger.logTransaction('Deposit confirmed', {
	 *   txId: 'tx123',
	 *   txHash: '0xabc...',
	 *   amount: '50',
	 *   userId: 12345
	 * });
	 * ```
	 */
	static logTransaction(event: string, context: LogContext): void {
		logger.info(
			`[TRANSACTION] ${event}`,
			StructuredLogger.sanitizeContext(context),
		);
	}

	/**
	 * Logs a security event (violations, restrictions, bans).
	 *
	 * @param event - Security event description
	 * @param context - Security context
	 *
	 * @example
	 * ```typescript
	 * StructuredLogger.logSecurityEvent('User restricted', {
	 *   userId: 12345,
	 *   username: 'badactor',
	 *   operation: 'add_restriction',
	 *   reason: 'spam'
	 * });
	 * ```
	 */
	static logSecurityEvent(event: string, context: LogContext): void {
		logger.warn(
			`[SECURITY] ${event}`,
			StructuredLogger.sanitizeContext(context),
		);
	}

	/**
	 * Logs an error with full context and stack trace.
	 *
	 * @param error - Error object or message
	 * @param context - Error context
	 *
	 * @example
	 * ```typescript
	 * StructuredLogger.logError(error, {
	 *   userId: 12345,
	 *   operation: 'withdrawal',
	 *   txId: 'tx456'
	 * });
	 * ```
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
	 *
	 * @param message - Debug message
	 * @param context - Debug context
	 */
	static logDebug(message: string, context: LogContext = {}): void {
		logger.debug(message, StructuredLogger.sanitizeContext(context));
	}

	/**
	 * Sanitizes context to prevent logging sensitive data.
	 * Removes or masks sensitive fields like mnemonics, private keys, etc.
	 *
	 * @param context - Raw context object
	 * @returns Sanitized context safe for logging
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

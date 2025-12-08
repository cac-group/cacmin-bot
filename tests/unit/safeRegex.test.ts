/**
 * Security and functionality tests for safe regex utilities
 * Tests pattern validation, compilation, and ReDoS protection
 */

import {
	validatePattern,
	compileSafeRegex,
	testPatternSafely,
	matchesPattern,
	createPatternObject
} from '../../src/utils/safeRegex';

describe('Safe Regex Utilities', () => {
	describe('Pattern Validation', () => {
		it.each([
			['simple text', 'test', true],
			['wildcard pattern', 'test*pattern', true],
			['regex pattern', '/test.*pattern/gi', true],
			['unicode', 'testé', true],
			['whitespace', 'test pattern', true],
		])('validates %s patterns correctly', (_, pattern, expected) => {
			const result = validatePattern(pattern);
			expect(result.isValid).toBe(expected);
		});

		it.each([
			['empty', '', 'empty'],
			['too long', 'a'.repeat(501), 'maximum length'],
			['invalid flags', '/test/xyz', 'Invalid regex flag'],
			['missing closing slash', '/test', 'missing closing'],
			['invalid syntax', '/test(/gi', 'Invalid regex syntax'],
		])('rejects %s patterns', (_, pattern, errorText) => {
			const result = validatePattern(pattern);
			expect(result.isValid).toBe(false);
			expect(result.error).toContain(errorText);
		});

		it('sanitizes control characters', () => {
			const result = validatePattern('test\x00pattern\x1F');
			expect(result.isValid).toBe(true);
			expect(result.sanitized).toBe('testpattern');
		});

		it('allows valid regex flags', () => {
			for (const flag of ['g', 'i', 'm', 's', 'u']) {
				const result = validatePattern(`/test/${flag}`);
				expect(result.isValid).toBe(true);
			}
		});
	});

	describe('Pattern Compilation', () => {
		it.each([
			['simple text', 'test', 'simple', 'this is a test', true],
			['simple text (case insensitive)', 'test', 'simple', 'this is a TEST', true],
			['simple text (no match)', 'test', 'simple', 'nothing here', false],
			['wildcard *', 'test*pattern', 'wildcard', 'test123pattern', true],
			['wildcard * (empty)', 'test*pattern', 'wildcard', 'testpattern', true],
			['wildcard ?', 'test?pattern', 'wildcard', 'testapattern', true],
			['wildcard ? (no char)', 'test?pattern', 'wildcard', 'testpattern', false],
		])('compiles %s correctly', (_, pattern, expectedType, testStr, expectedMatch) => {
			const compiled = compileSafeRegex(pattern);
			expect(compiled.type).toBe(expectedType);
			compiled.regex.lastIndex = 0;
			expect(compiled.regex.test(testStr)).toBe(expectedMatch);
		});

		it('compiles full regex patterns', () => {
			const pattern = compileSafeRegex('/test.*pattern/gi');
			expect(pattern.type).toBe('regex');
			pattern.regex.lastIndex = 0;
			expect(pattern.regex.test('TEST456PATTERN')).toBe(true);
		});

		it('escapes special regex chars in simple patterns', () => {
			const pattern = compileSafeRegex('test.pattern');
			expect(pattern.regex.test('test.pattern')).toBe(true);
			expect(pattern.regex.test('testapattern')).toBe(false);
		});

		it('preserves raw pattern string', () => {
			const pattern = compileSafeRegex('test*pattern');
			expect(pattern.raw).toBe('test*pattern');
		});
	});

	describe('Safe Pattern Matching with ReDoS Protection', () => {
		it('matches patterns with timeout protection', async () => {
			const regex = /test.*pattern/i;
			expect(await testPatternSafely(regex, 'test123pattern', 100)).toBe(true);
			expect(await testPatternSafely(regex, 'nothing here', 100)).toBe(false);
		});

		it.each([
			['nested quantifiers', /(a+)+b/, 'a'.repeat(20) + 'c'],
			['alternation', /(a|a)*b/, 'a'.repeat(25) + 'c'],
			['grouping', /(a|ab)*c/, 'ab'.repeat(15) + 'd'],
		])('protects against %s ReDoS attack', async (_, regex, attackStr) => {
			const result = await testPatternSafely(regex, attackStr, 100);
			expect(result).toBe(false);
		}, 10000);

		it('handles normal patterns quickly', async () => {
			const pattern = createPatternObject('/test.*pattern/');
			const startTime = Date.now();
			const result = await testPatternSafely(pattern!.regex, 'test some normal pattern', 100);
			expect(result).toBe(true);
			expect(Date.now() - startTime).toBeLessThan(50);
		});

		it('handles regex errors gracefully', async () => {
			expect(await testPatternSafely(/test/i, null as any, 100)).toBe(false);
		});

		it('uses default timeout if not specified', async () => {
			expect(await testPatternSafely(/test/i, 'test')).toBe(true);
		});
	});

	describe('Synchronous Pattern Matching', () => {
		it('matches patterns synchronously', () => {
			const regex = /test.*pattern/i;
			expect(matchesPattern(regex, 'test123pattern')).toBe(true);
			expect(matchesPattern(regex, 'nothing')).toBe(false);
		});

		it('handles errors gracefully', () => {
			expect(matchesPattern(/test/i, null as any)).toBe(false);
		});
	});

	describe('Pattern Object Creation', () => {
		it.each([
			['simple text', 'test', 'simple'],
			['wildcard', 'test*', 'wildcard'],
			['regex', '/test.*/gi', 'regex'],
		])('creates valid %s pattern object', (_, pattern, expectedType) => {
			const obj = createPatternObject(pattern);
			expect(obj).not.toBeNull();
			expect(obj?.type).toBe(expectedType);
		});

		it.each([
			['empty', ''],
			['too long', 'a'.repeat(501)],
			['invalid regex', '/test(/gi'],
		])('returns null for %s patterns', (_, pattern) => {
			expect(createPatternObject(pattern)).toBeNull();
		});
	});

	describe('Real-World Usage', () => {
		it('blocks spam patterns', async () => {
			const pattern = createPatternObject('/buy.*now|click.*here|limited.*offer/i');
			expect(await testPatternSafely(pattern!.regex, 'Buy this now!', 100)).toBe(true);
			expect(await testPatternSafely(pattern!.regex, 'Click here for more', 100)).toBe(true);
			expect(await testPatternSafely(pattern!.regex, 'Normal message', 100)).toBe(false);
		});

		it('blocks specific domains with wildcard', () => {
			const pattern = createPatternObject('*scam-site.com*');
			expect(matchesPattern(pattern!.regex, 'Visit scam-site.com')).toBe(true);
			expect(matchesPattern(pattern!.regex, 'http://scam-site.com/page')).toBe(true);
			expect(matchesPattern(pattern!.regex, 'Visit legitimate-site.com')).toBe(false);
		});

		it('handles multiline strings', () => {
			const pattern = createPatternObject('/test[\\s\\S]*pattern/im');
			pattern!.regex.lastIndex = 0;
			expect(pattern?.regex.test('test\nsome\npattern')).toBe(true);
		});
	});
});

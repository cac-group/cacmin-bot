import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		globals: true,
		environment: 'node',
		include: ['tests/**/*.{test,spec}.ts', 'src/**/*.{test,spec}.ts'],
		setupFiles: ['./tests/setup.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'lcov', 'html'],
			include: ['src/**/*.ts'],
			exclude: [
				'src/**/*.d.ts',
				'src/**/*.test.ts',
				'src/**/*.spec.ts',
				'src/bot.ts'
			],
			thresholds: {
				branches: 3,
				functions: 14,
				lines: 5,
				statements: 5
			}
		},
		// Run tests serially to avoid database conflicts
		pool: 'forks',
		poolOptions: {
			forks: {
				singleFork: true
			}
		}
	}
});

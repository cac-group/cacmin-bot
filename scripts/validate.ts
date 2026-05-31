import { config, validateConfig } from '../src/config';
import * as fs from 'fs';
import * as path from 'path';

console.log(' Validating CAC Admin Bot Configuration...\n');

let hasErrors = false;

// Check environment variables
console.log(' Checking environment variables...');
try {
  validateConfig();
  console.log(' BOT_TOKEN: configured');
  console.log(' OWNER_ID: configured');
} catch (error: any) {
  console.error(' Configuration error:', error.message);
  hasErrors = true;
}

// Check ledger system configuration
if (config.botTreasuryAddress) {
  console.log(' BOT_TREASURY_ADDRESS: configured');
} else {
  console.log('  BOT_TREASURY_ADDRESS: not configured (payment verification disabled)');
}

if (config.userFundsAddress) {
  console.log(' USER_FUNDS_ADDRESS: configured');
} else {
  console.log('  USER_FUNDS_ADDRESS: not configured (deposits disabled)');
}

if (config.userFundsMnemonic) {
  console.log(' USER_FUNDS_MNEMONIC: configured');
} else {
  console.log('  USER_FUNDS_MNEMONIC: not configured (withdrawals disabled)');
}

if (config.adminChatId) {
  console.log(' ADMIN_CHAT_ID: configured');
} else {
  console.log('  ADMIN_CHAT_ID: not configured (admin notifications disabled)');
}

// Check directories
console.log('\n Checking directories...');
const requiredDirs = [
  { path: './data', name: 'Database directory' },
  { path: './logs', name: 'Logs directory' },
  { path: './dist', name: 'Build directory' },
];

for (const dir of requiredDirs) {
  if (fs.existsSync(dir.path)) {
    console.log(` ${dir.name}: exists`);
  } else {
    console.log(`  ${dir.name}: missing (will be created)`);
    try {
      fs.mkdirSync(dir.path, { recursive: true });
      console.log(`   Created ${dir.path}`);
    } catch (error) {
      console.error(`   Failed to create ${dir.path}`);
      hasErrors = true;
    }
  }
}

// Check database
console.log('\n  Checking database...');
const dbPath = config.databasePath || './data/bot.db';
if (fs.existsSync(dbPath)) {
  console.log(' Database file: exists');
  const stats = fs.statSync(dbPath);
  console.log(`   Size: ${(stats.size / 1024).toFixed(2)} KB`);
  console.log(`   Last modified: ${stats.mtime.toISOString()}`);
} else {
  console.log('  Database file: missing');
  console.log('   Run: bun run setup-db');
}

// Check build files (skip if this is a post-build validation)
const isPostBuildValidation = process.env.BUILD_VALIDATION === 'true';
if (!isPostBuildValidation) {
  console.log('\n Checking build files...');
  if (fs.existsSync('./dist/bot.js')) {
    console.log(' Bot build: exists');
  } else {
    console.log(' Bot build: missing');
    console.log('   Run: bun run build');
    hasErrors = true;
  }
} else {
  console.log('\n Checking build files...');
  if (fs.existsSync('./dist/bot.js')) {
    console.log(' Bot build: exists (fresh build)');
  } else {
    console.log(' Bot build: FAILED - TypeScript compilation did not produce dist/bot.js');
    hasErrors = true;
  }
}

// Check dependencies
console.log('\n Checking dependencies...');
if (fs.existsSync('./node_modules')) {
  console.log(' Dependencies: installed');

  const packageJson = JSON.parse(fs.readFileSync('./package.json', 'utf8'));
  const requiredDeps = ['telegraf', 'dotenv'];

  for (const dep of requiredDeps) {
    const depPath = path.join('./node_modules', dep);
    if (fs.existsSync(depPath)) {
      console.log(`    ${dep}`);
    } else {
      console.log(`    ${dep}: missing`);
      hasErrors = true;
    }
  }
} else {
  console.log(' Dependencies: not installed');
  console.log('   Run: bun install');
  hasErrors = true;
}

// Configuration summary
console.log('\n  Configuration Summary:');
console.log(`   Log Level: ${config.logLevel}`);
console.log(`   Database Path: ${config.databasePath}`);
console.log(`   JUNO RPC: ${config.junoRpcUrl}`);

// Fine amounts
console.log('\n Fine Configuration:');
console.log(`   Stickers: ${config.fineAmounts.sticker} JUNO`);
console.log(`   URLs: ${config.fineAmounts.url} JUNO`);
console.log(`   Regex: ${config.fineAmounts.regex} JUNO`);
console.log(`   Blacklist: ${config.fineAmounts.blacklist} JUNO`);

// Final result
console.log('\n' + '='.repeat(50));
if (hasErrors) {
  console.log(' Validation FAILED - Fix errors above before starting');
  process.exit(1);
} else {
  console.log(' Validation PASSED - Ready to start!');
  console.log('\nStart the bot with:');
  console.log('  bun run dev     (development mode)');
  console.log('  bun run start   (production mode)');
  process.exit(0);
}

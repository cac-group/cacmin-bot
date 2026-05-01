# Regex Pattern Guide for Content Restrictions

This guide provides practical examples for using regex patterns with the `/addrestriction` command to filter messages in your Telegram group.

## Pattern Types

The bot supports three types of patterns:

### 1. Simple Text (Exact Substring)
Matches the exact text anywhere in the message (case-insensitive).

```
forbidden word
spam phrase
```

**Example:**
```
/addrestriction 123456 regex_block "buy now"
```
Blocks any message containing "buy now", "BUY NOW", "Buy Now", etc.

### 2. Wildcard Patterns
Use `*` (matches any characters) and `?` (matches single character).

```
test*pattern  → matches "testpattern", "test123pattern", "test any pattern"
test?pattern  → matches "testapattern", "test1pattern" but NOT "testpattern"
```

**Example:**
```
/addrestriction 123456 regex_block "*crypto scam*"
```
Blocks messages with "crypto scam" anywhere in the text.

### 3. Full Regex (Advanced)
Use full regular expression syntax with `/pattern/flags` format.

```
/test.*pattern/i     → Case insensitive
/test.*pattern/im    → Case insensitive + multiline
```

## Common Use Cases

### Blocking Spam Phrases

**Multiple spam keywords:**
```
/addrestriction 123456 regex_block "/buy.*now|click.*here|limited.*offer|act.*fast/i"
```
Blocks: "Buy it now!", "Click here for more", "Limited time offer", "Act fast!"

**Investment scams:**
```
/addrestriction 123456 regex_block "/guaranteed.*profit|double.*your.*money|investment.*opportunity/i"
```

### Blocking URLs and Links

**All URLs:**
```
/addrestriction 123456 no_urls
```
(Use the built-in no_urls restriction instead of regex)

**Specific domains:**
```
/addrestriction 123456 no_urls scam-site.com
```

**Shortened URLs:**
```
/addrestriction 123456 regex_block "/bit\\.ly|tinyurl|t\\.co|goo\\.gl/i"
```

### Blocking Phone Numbers

**Various phone formats:**
```
/addrestriction 123456 regex_block "/\\+?[0-9]{10,15}|\\([0-9]{3}\\).*[0-9]{3}.*[0-9]{4}/i"
```
Blocks: "+1234567890", "(555) 123-4567", "555-123-4567"

**Telegram contact sharing:**
```
/addrestriction 123456 regex_block "t\\.me/\\+[0-9]+"
```

### Blocking Crypto Wallet Addresses

**Bitcoin addresses:**
```
/addrestriction 123456 regex_block "/[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{39,59}/i"
```

**Ethereum addresses:**
```
/addrestriction 123456 regex_block "/0x[a-fA-F0-9]{40}/"
```

**Cosmos/Juno addresses:**
```
/addrestriction 123456 regex_block "/(cosmos|juno|osmo)[a-z0-9]{39}/"
```

### Blocking Excessive Caps

**Messages with mostly uppercase:**
```
/addrestriction 123456 regex_block "/^[A-Z\\s!?.,]{20,}$/"
```
Blocks messages that are 20+ characters and mostly caps.

### Blocking Repeated Characters

**Spammy repeated characters:**
```
/addrestriction 123456 regex_block "/(.)\1{4,}/"
```
Blocks: "aaaaa", "!!!!!", "😂😂😂😂😂"

### Blocking Specific Emojis or Patterns

**Fire emoji spam:**
```
/addrestriction 123456 regex_block "🔥{3,}"
```
Blocks 3 or more fire emojis in a row.

**Any emoji spam:**
```
/addrestriction 123456 regex_block "/[\u{1F300}-\u{1F9FF}]{5,}/u"
```
Blocks 5+ emojis in a row.

### Blocking Profanity

**Simple word list:**
```
/addrestriction 123456 regex_block "/\\b(word1|word2|word3)\\b/i"
```
The `\\b` ensures whole word matching.

**With common character substitutions:**
```
/addrestriction 123456 regex_block "/\\bs[h@]!t|f[u*]ck|d[a@]mn\\b/i"
```
Catches: "sh!t", "sh@t", "f*ck", "fuck", "d@mn", etc.

### Blocking Social Media Handles

**Twitter/X handles:**
```
/addrestriction 123456 regex_block "@[A-Za-z0-9_]{1,15}"
```

**Instagram promotion:**
```
/addrestriction 123456 regex_block "/follow.*instagram|insta.*follow|check.*my.*ig/i"
```

### Blocking Referral/Promo Codes

**Promo codes:**
```
/addrestriction 123456 regex_block "/\\b[A-Z0-9]{6,10}\\b.*discount|promo.*code|use.*code/i"
```

**Referral links:**
```
/addrestriction 123456 regex_block "/ref=|referral|invite.*code/i"
```

### Blocking Specific Languages

**Cyrillic characters (Russian, etc.):**
```
/addrestriction 123456 regex_block "/[А-Яа-яЁё]/"
```

**Chinese characters:**
```
/addrestriction 123456 regex_block "/[\u4e00-\u9fff]/"
```

**Arabic characters:**
```
/addrestriction 123456 regex_block "/[\u0600-\u06ff]/"
```

### Blocking @everyone Mentions

**Mass mention patterns:**
```
/addrestriction 123456 regex_block "/@everyone|@here|@all|@channel/i"
```

## Pattern Testing

Before applying a restriction, you can test patterns:

1. **Test in a separate chat:** Create a test group and try the restriction there first
2. **Use temporary restrictions:** Add an expiration time to test before making permanent
3. **Start specific, then broaden:** Begin with exact phrases, then expand if needed

### Testing Examples

**Temporary restriction (1 hour):**
```
/addrestriction 123456 regex_block "spam phrase" 3600
```
(3600 = 1 hour in seconds)

**Permanent restriction:**
```
/addrestriction 123456 regex_block "spam phrase"
```

## Advanced Tips

### Case Sensitivity
- Simple text and wildcards are always case-insensitive
- Full regex defaults to case-insensitive (`/pattern/i`)
- Remove `i` flag for case-sensitive: `/pattern/`

### Word Boundaries
Use `\\b` to match whole words only:
```
/\\btest\\b/i   → matches "test" but not "testing" or "attest"
```

### Negation (NOT matching)
Regex doesn't support "block everything except X" easily. Instead:
1. Use multiple specific restrictions
2. Combine with other restriction types (no_media, no_stickers, etc.)

### Multiple Patterns
To block multiple things, add multiple restrictions:
```
/addrestriction 123456 regex_block "spam word 1"
/addrestriction 123456 regex_block "spam word 2"
/addrestriction 123456 regex_block "spam word 3"
```

### Performance Considerations
- Simple patterns are fastest
- Wildcards are fast
- Complex regex can be slower but timeout-protected (100ms)
- Very complex regex patterns may timeout (this is a security feature)

## Pattern Syntax Reference

### Special Characters (must be escaped with \\)
```
. * + ? ^ $ { } [ ] ( ) | \
```

**Example:** To match "example.com" literally:
```
example\\.com
```

### Common Regex Elements
```
.        → Any character
*        → 0 or more of previous
+        → 1 or more of previous
?        → 0 or 1 of previous
{n}      → Exactly n of previous
{n,}     → n or more of previous
{n,m}    → Between n and m of previous
[abc]    → Any of a, b, or c
[a-z]    → Any lowercase letter
[A-Z]    → Any uppercase letter
[0-9]    → Any digit
\\d      → Any digit (same as [0-9])
\\w      → Word character [A-Za-z0-9_]
\\s      → Whitespace
\\b      → Word boundary
^        → Start of string
$        → End of string
|        → OR operator
```

### Flags
```
i        → Case insensitive
m        → Multiline mode
s        → Dot matches newlines
```

**Usage:**
```
/pattern/i    → Case insensitive
/pattern/im   → Case insensitive + multiline
```

## Getting Help

If you're unsure about a pattern:
1. Test with a temporary restriction first
2. Check `/listrestrictions <userId>` to see active restrictions
3. Use `/removerestriction <userId> regex_block` to remove if needed
4. Use `/clearrestrictions <userId>` or omit the type in `/removerestriction <userId>` if you need to wipe every restriction from that user
5. Start simple (use wildcards) before trying complex regex

## Security Notes

⚠️ **Important:**
- All regex patterns have a 100ms timeout to prevent abuse
- Very complex patterns will timeout and fail to match (this is intentional)
- Patterns are limited to 500 characters
- Control characters are automatically filtered for security

✅ **Best Practices:**
- Test patterns before deploying to production
- Keep patterns as simple as possible
- Document why you added each restriction
- Review and clean up old restrictions regularly
- Use built-in restrictions (no_urls, no_stickers) when possible

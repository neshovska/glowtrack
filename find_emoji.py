import re

with open('index.html', encoding='utf-8') as f:
    lines = f.readlines()

emoji_pattern = re.compile(
    '[\U0001F300-\U0001FAFF\U00002600-\U000027BF\U0001F000-\U0001F0FF\U00002190-\U000021FF\U00002B00-\U00002BFF]+'
)

seen = {}
for i, line in enumerate(lines, 1):
    matches = emoji_pattern.findall(line)
    if matches:
        for m in matches:
            seen.setdefault(m, []).append(i)

for emoji, linenums in sorted(seen.items(), key=lambda x: -len(x[1])):
    tail = "..." if len(linenums) > 5 else ""
    print(repr(emoji) + "  (" + str(len(linenums)) + "x)  редове: " + str(linenums[:5]) + tail)

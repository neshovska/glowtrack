import re

with open('index.html', encoding='utf-8') as f:
    content = f.read()

for i, line in enumerate(content.split('\n'), 1):
    if 'showToast' in line or re.search(r'toast[A-Z]\w*\s*:', line):
        print(i, ':', line.strip()[:180])

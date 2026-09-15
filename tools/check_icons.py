# -*- coding: utf-8 -*-
import re, os
src = open(r'C:\Users\qxl\web-fishing-game\frontend\js\data.js', encoding='utf-8').read()
ids = re.findall(r"id:\s*'([^']+)'", src.split('MATERIALS')[0])
have = set(f[:-4] for f in os.listdir(r'C:\Users\qxl\web-fishing-game\frontend\assets\fish'))
print('data.js 鱼数:', len(ids))
print('缺图:', [i for i in ids if i not in have])
print('多出:', [h for h in have if h not in ids])

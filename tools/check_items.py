# -*- coding: utf-8 -*-
import os, re
src = open(r'C:\Users\qxl\web-fishing-game\frontend\js\data.js', encoding='utf-8').read()
# 材料 id（MATERIALS 段）
mats = re.findall(r"id: '([a-z_]+)'", src.split('const ROD_PARTS')[0].split('MATERIALS = [')[1])
# 组件底材 id + 遗留 comp_generic
comps = re.findall(r"id: '([a-z_]+)'", src.split('const BASE_MAP')[0].split('COMPONENT_BASES = [')[1])
if 'comp_generic' in src:
    comps.append('comp_generic')
need = set(mats) | set(comps)
have = set(f[:-4] for f in os.listdir(r'C:\Users\qxl\web-fishing-game\frontend\assets\item'))
print('需要:', len(need), '已有:', len(have))
print('缺:', sorted(need - have))
print('多:', sorted(have - need))
# 钓点
spots = re.findall(r"\{ id: '([a-z]+)', name: '[^']+', pool", src)
shave = set(f[:-4] for f in os.listdir(r'C:\Users\qxl\web-fishing-game\frontend\assets\spot'))
print('钓点 需要:', len(spots), '已有:', len(shave), '缺:', sorted(set(spots) - shave))

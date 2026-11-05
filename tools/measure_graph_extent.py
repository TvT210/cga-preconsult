"""测量知识库图谱截图里「节点+标签」的实际占位范围。

注意：画布自带 1px 边框（#e2e8f0），统计时必须从边框内侧开始，
否则边框会被误判成「图形铺满画布」。
"""
import sys
from PIL import Image

path = sys.argv[1] if len(sys.argv) > 1 else r"D:\ALLCODE\work\word2\output\staff-ui\staff-knowledge.png"
im = Image.open(path).convert("RGB")
W, H = im.size
px = im.load()

# 画布区域（与 CDP 实测一致：canvas 位于 (481,273)，尺寸 754x558）
X0, Y0 = 481, 273
X1, Y1 = X0 + 754, Y0 + 558
INSET = 3  # 跳过 1px 边框 + 圆角抗锯齿

minx, miny, maxx, maxy = W, H, 0, 0
count = 0
for y in range(Y0 + INSET, Y1 - INSET):
    for x in range(X0 + INSET, X1 - INSET):
        r, g, b = px[x, y]
        # 背景是白/近白，节点与连线是有色/深色像素
        if not (r > 240 and g > 240 and b > 240):
            count += 1
            if x < minx: minx = x
            if x > maxx: maxx = x
            if y < miny: miny = y
            if y > maxy: maxy = y

cw, ch = X1 - X0, Y1 - Y0
if count == 0:
    print("画布内没有图形像素")
    raise SystemExit(0)
print(f"画布尺寸        : {cw} x {ch}")
print(f"图形包围盒      : {maxx-minx} x {maxy-miny}  (占画布 {(maxx-minx)/cw*100:.0f}% x {(maxy-miny)/ch*100:.0f}%)")
print(f"四边留白        : 左 {minx-X0} / 上 {miny-Y0} / 右 {X1-maxx} / 下 {Y1-maxy}")
print(f"着色像素数      : {count}")

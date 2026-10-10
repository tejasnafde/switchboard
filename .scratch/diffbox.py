import subprocess, io, sys
from PIL import Image, ImageChops
files = subprocess.check_output(['git','diff','--name-only','--','e2e/snapshots']).decode().split()
for f in files:
    old = Image.open(io.BytesIO(subprocess.check_output(['git','show','HEAD:'+f]))).convert('RGB')
    new = Image.open(f).convert('RGB')
    if old.size != new.size:
        print(f.split('/')[-1], 'SIZE', old.size, new.size); continue
    d = ImageChops.difference(old, new).convert('L').point(lambda p: 255 if p>16 else 0)
    print(f.split('/')[-1], old.size, d.getbbox())

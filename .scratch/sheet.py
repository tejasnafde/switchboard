import subprocess, io, sys
from PIL import Image
# usage: sheet.py out.png file... ; before (HEAD) above after, side by side columns
out=sys.argv[1]; files=sys.argv[2:]
cols=[]
for f in files:
    try: old=Image.open(io.BytesIO(subprocess.check_output(['git','show','HEAD:'+f],stderr=subprocess.DEVNULL))).convert('RGB')
    except Exception: old=None
    new=Image.open(f).convert('RGB')
    w=new.width; h=new.height+(old.height+8 if old else 0)
    c=Image.new('RGB',(w,h),(255,0,255))
    y=0
    if old: c.paste(old,(0,0)); y=old.height+8
    c.paste(new,(0,y)); cols.append(c)
W=sum(c.width for c in cols)+8*len(cols); H=max(c.height for c in cols)
s=Image.new('RGB',(W,H),(255,0,255)); x=0
for c in cols: s.paste(c,(x,0)); x+=c.width+8
s.save(out)

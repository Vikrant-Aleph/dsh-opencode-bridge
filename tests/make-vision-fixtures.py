"""Create synthetic vision-only fixtures, not user images or AI-generated output."""
import hashlib
import json
from pathlib import Path
import secrets
import sys
from PIL import Image, ImageDraw, ImageFont

if len(sys.argv) != 2:
    raise SystemExit('Usage: make-vision-fixtures.py <new-output-directory>')
root = Path(sys.argv[1]).resolve()
if root.exists():
    raise SystemExit('Refusing to overwrite an existing fixture directory')
root.mkdir(parents=True)
records = []
for index in range(3):
    code = ''.join(secrets.choice('ACEFHJKLMNPRTVWXYZ234679') for _ in range(8))
    image = Image.new('RGB', (640, 220), 'white')
    draw = ImageDraw.Draw(image)
    title = ImageFont.load_default(size=20)
    font = ImageFont.load_default(size=72)
    draw.text((24, 18), 'VISION CHECK', fill='black', font=title)
    box = draw.textbbox((0, 0), code, font=font)
    draw.text(((640 - (box[2] - box[0])) / 2, 92 - box[1]), code, fill='black', font=font)
    file = root / f'fixture-{index}.png'
    image.save(file)
    data = file.read_bytes()
    records.append({'file': file.name, 'expected': code, 'attachmentId': 'sha256:' + hashlib.sha256(data).hexdigest(), 'mediaType': 'image/png', 'bytes': len(data), 'width': image.width, 'height': image.height, 'name': 'vision-fixture.png'})
(root / 'fixtures.json').write_text(json.dumps(records, indent=2) + '\n', encoding='utf-8')
print(f'Created {len(records)} synthetic fixture images in {root}; expected codes stay in local metadata, not prompts.')

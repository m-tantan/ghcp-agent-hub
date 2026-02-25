"""Generate all icon sizes for the electron app from source image."""
from PIL import Image
import os

src = r'C:\Users\yomanor\Downloads\Design 2.png'
out_dir = r'C:\SOC\ghcp-agent-hub\electron-app\assets'

img = Image.open(src).convert('RGBA')
print(f'Source size: {img.size}')

# Find the bounding box of non-transparent pixels to crop whitespace
bbox = img.getbbox()
if bbox:
    cropped = img.crop(bbox)
    print(f'Cropped to: {cropped.size} (bbox: {bbox})')
else:
    cropped = img

# Icon sizes needed for electron
sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]

generated = {}
for size in sizes:
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    
    # Scale cropped image to fit within the canvas with padding (90% of canvas)
    max_dim = int(size * 0.9)
    ratio = min(max_dim / cropped.width, max_dim / cropped.height)
    new_w = int(cropped.width * ratio)
    new_h = int(cropped.height * ratio)
    
    resized = cropped.resize((new_w, new_h), Image.LANCZOS)
    
    # Center on canvas
    x = (size - new_w) // 2
    y = (size - new_h) // 2
    canvas.paste(resized, (x, y), resized)
    
    fname = f'icon_{size}.png'
    fpath = os.path.join(out_dir, fname)
    canvas.save(fpath, 'PNG')
    generated[size] = fpath
    print(f'Generated: {fname} ({size}x{size})')

# Generate ICO file with multiple sizes (16, 24, 32, 48, 64, 128, 256)
ico_sizes = [16, 24, 32, 48, 64, 128, 256]
ico_images = []
for s in ico_sizes:
    ico_images.append(Image.open(generated[s]))

ico_path = os.path.join(out_dir, 'icon.ico')
ico_images[0].save(ico_path, format='ICO', sizes=[(s, s) for s in ico_sizes], append_images=ico_images[1:])
print(f'Generated: icon.ico with sizes {ico_sizes}')

# Verify transparency
for s in [16, 32, 512]:
    test = Image.open(generated[s])
    has_alpha = (test.mode == "RGBA")
    print(f'icon_{s}.png mode={test.mode}, has_alpha={has_alpha}')

print('Done!')

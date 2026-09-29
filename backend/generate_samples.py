import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import os

sample_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sample_images")
os.makedirs(sample_dir, exist_ok=True)

def generate_lunar_crater():
    """Chandrayaan-2 lunar crater surface with central peaks and rim shadows."""
    w, h = 512, 512
    y, x = np.ogrid[:h, :w]
    cx, cy = 256, 256
    r = np.sqrt((x - cx)**2 + (y - cy)**2)
    
    # Crater elevation profile: rim at r=180, floor at r<120, central peak at r<30
    rim = np.exp(-((r - 170)**2) / 600.0) * 120
    floor = np.clip(160 - (r / 170)**2 * 90, 40, 160)
    peak = np.exp(-(r**2) / 400.0) * 80
    elevation = rim + floor + peak
    
    # Add terrain noise
    noise = np.random.normal(0, 12, (h, w))
    elevation = np.clip(elevation + noise, 0, 255).astype(np.uint8)
    
    # Sun lighting from top-left (azimuth 315°, elevation 40°)
    gy, gx = np.gradient(elevation.astype(np.float32))
    light = (gx * -0.7 - gy * 0.7) * 0.9 + elevation * 0.4
    light = np.clip(light + 60, 20, 240).astype(np.uint8)
    
    img = Image.fromarray(light).convert("RGB")
    # Add subtle lunar monochrome warm tint
    img_np = np.array(img, dtype=np.float32)
    img_np[:, :, 0] *= 1.02  # subtle warm
    img_np[:, :, 2] *= 0.98
    img = Image.fromarray(np.clip(img_np, 0, 255).astype(np.uint8))
    img.save(os.path.join(sample_dir, "chandrayaan_lunar_surface.png"))
    print("Created chandrayaan_lunar_surface.png")

def generate_disaster_area():
    """Himalayan landslide and debris disaster zone."""
    w, h = 512, 512
    y, x = np.ogrid[:h, :w]
    
    # Steep valley V-shape
    valley = np.abs(x - 256) * 0.7 + y * 0.3
    # Landslide scar on left slope
    scar_mask = (x > 100) & (x < 260) & (y > 80) & (y < 420)
    scar = np.where(scar_mask, -40 + np.sin(y/15.0)*15, 0)
    terrain = np.clip(valley + scar + np.random.normal(0, 8, (h, w)), 0, 255).astype(np.uint8)
    
    # Colorize: rocky browns and green vegetation patches
    r_ch = np.clip(terrain * 0.9 + 50, 40, 220).astype(np.uint8)
    g_ch = np.clip(terrain * 0.8 + 40, 30, 190).astype(np.uint8)
    b_ch = np.clip(terrain * 0.6 + 20, 20, 150).astype(np.uint8)
    
    # Forest on intact slopes
    forest_mask = (terrain > 120) & (~scar_mask)
    g_ch[forest_mask] = np.clip(g_ch[forest_mask] + 35, 0, 255)
    r_ch[forest_mask] = np.clip(r_ch[forest_mask] - 20, 0, 255)
    
    img = Image.fromarray(np.stack([r_ch, g_ch, b_ch], axis=-1))
    img.save(os.path.join(sample_dir, "disaster_area.png"))
    print("Created disaster_area.png")

def generate_mountain_terrain():
    """Himalayan mountain ridgeline."""
    w, h = 512, 512
    y, x = np.ogrid[:h, :w]
    
    # High ridgeline diagonal
    ridge = 220 - np.abs((x - y * 0.8) - 50) * 0.6
    ridge += np.sin(x / 40.0) * 30 + np.cos(y / 30.0) * 25
    noise = np.random.normal(0, 10, (h, w))
    elev = np.clip(ridge + noise, 20, 255).astype(np.uint8)
    
    # Snow peaks at top, rocky gray below
    r_ch = np.clip(elev * 1.1, 40, 255).astype(np.uint8)
    g_ch = np.clip(elev * 1.1 + 5, 40, 255).astype(np.uint8)
    b_ch = np.clip(elev * 1.15 + 15, 50, 255).astype(np.uint8)
    
    img = Image.fromarray(np.stack([r_ch, g_ch, b_ch], axis=-1))
    img.save(os.path.join(sample_dir, "mountain_terrain.png"))
    print("Created mountain_terrain.png")

def generate_drone_cityscape():
    """Indian urban drone survey with building rooftops and streets."""
    w, h = 512, 512
    img = Image.new("RGB", (w, h), (45, 48, 52))
    draw = ImageDraw.Draw(img)
    
    # Draw road grid
    draw.rectangle([0, 230, w, 280], fill=(30, 32, 35))
    draw.rectangle([230, 0, 280, h], fill=(30, 32, 35))
    
    # Draw building blocks with distinct roof colors and shadows
    buildings = [
        ([30, 30, 190, 190], (180, 160, 140), (80, 70, 60)),
        ([310, 30, 470, 200], (160, 175, 190), (70, 80, 90)),
        ([40, 310, 200, 480], (200, 140, 120), (90, 60, 50)),
        ([300, 310, 480, 470], (170, 190, 160), (75, 90, 70)),
        ([70, 70, 150, 150], (220, 210, 190), (100, 95, 85)),
        ([340, 70, 440, 160], (190, 200, 220), (90, 95, 105)),
    ]
    
    for (x1, y1, x2, y2), roof_col, shadow_col in buildings:
        # Shadow to bottom-right
        draw.rectangle([x1 + 10, y1 + 10, x2 + 10, y2 + 10], fill=(20, 22, 24))
        # Building roof
        draw.rectangle([x1, y1, x2, y2], fill=roof_col)
        # Rooftop structures (HVAC, solar panels)
        draw.rectangle([x1 + 20, y1 + 20, x1 + 50, y1 + 45], fill=(70, 90, 120))
        draw.rectangle([x2 - 50, y2 - 40, x2 - 20, y2 - 20], fill=(120, 110, 100))
    
    img = img.filter(ImageFilter.GaussianBlur(radius=0.5))
    img.save(os.path.join(sample_dir, "indian_cityscape_drone.png"))
    print("Created indian_cityscape_drone.png")

if __name__ == "__main__":
    generate_lunar_crater()
    generate_disaster_area()
    generate_mountain_terrain()
    generate_drone_cityscape()
    print("All sample datasets generated successfully!")

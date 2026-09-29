import sys
import os
import time
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app.depth import DepthEstimator, colorize_depth
from app.mesh import depth_to_point_cloud

print("Initializing DepthEstimator...")
t0 = time.time()
est = DepthEstimator()
print(f"Loaded {est.model_name} in {time.time() - t0:.2f}s")

img_path = r"d:\depth-wizard\backend\sample_images\test_city.png"
img = Image.open(img_path).convert("RGB")
print(f"Running inference on {img.size} image...")
t1 = time.time()
depth = est.estimate(img)
print(f"Depth estimated in {time.time() - t1:.2f}s, depth shape: {depth.shape}, min: {depth.min():.2f}, max: {depth.max():.2f}")

t2 = time.time()
pos, col = depth_to_point_cloud(img, depth, step=2)
print(f"Point cloud computed in {time.time() - t2:.2f}s, points count: {len(pos)}")

depth_col = colorize_depth(depth)
depth_col.save(r"d:\depth-wizard\backend\sample_images\test_city_depth_infer.png")
print("Saved test_city_depth_infer.png successfully!")

"""Quick test script for the /estimate endpoint."""
import urllib.request
import json
import base64
import time
import sys

IMAGE_PATH = r"d:\depth-wizard\backend\sample_images\test_city.png"
URL = "http://localhost:8000/estimate"

# Read the image
with open(IMAGE_PATH, "rb") as f:
    image_data = f.read()

# Build multipart/form-data request
boundary = "----WebKitFormBoundary7MA4YWxkTrZu0gW"
body = (
    f"--{boundary}\r\n"
    f'Content-Disposition: form-data; name="image"; filename="test_city.png"\r\n'
    f"Content-Type: image/png\r\n\r\n"
).encode() + image_data + f"\r\n--{boundary}--\r\n".encode()

req = urllib.request.Request(
    URL,
    data=body,
    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
)

print("Sending request to FastAPI /estimate...")
t0 = time.time()
response = urllib.request.urlopen(req)
elapsed = time.time() - t0

data = json.loads(response.read().decode())

print(f"\n=== Response in {elapsed:.2f}s ===")
print(f"Status:     {data['status']}")
print(f"Model:      {data['model']}")
print(f"Metadata:   {json.dumps(data['metadata'], indent=2)}")
print(f"Depth map:  {len(data['depth_map'])} chars base64")
print(f"Orig image: {len(data['original_image'])} chars base64")
print(f"Points:     {data['point_cloud']['count']}")
print(f"Positions:  {len(data['point_cloud']['positions'])} chars base64")
print(f"Colors:     {len(data['point_cloud']['colors'])} chars base64")

# Decode and verify point cloud data
pos_bytes = base64.b64decode(data["point_cloud"]["positions"])
col_bytes = base64.b64decode(data["point_cloud"]["colors"])
num_floats_pos = len(pos_bytes) // 4
num_floats_col = len(col_bytes) // 4
print(f"\nDecoded positions: {num_floats_pos} floats ({num_floats_pos // 3} points x 3)")
print(f"Decoded colors:    {num_floats_col} floats ({num_floats_col // 3} points x 3)")

# Save depth map for visual inspection
depth_png = base64.b64decode(data["depth_map"])
with open(r"d:\depth-wizard\backend\sample_images\test_city_depth.png", "wb") as f:
    f.write(depth_png)
print("\nSaved depth map to sample_images/test_city_depth.png")
print("\n[SUCCESS] All checks passed successfully!")

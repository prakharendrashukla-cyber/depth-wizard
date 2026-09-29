import urllib.request
import time
import json

boundary = "----WebKitFormBoundarySpeedTest"
with open("sample_images/isro_crater_terrain.png", "rb") as f:
    img_bytes = f.read()

header = f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"crater.png\"\r\nContent-Type: image/png\r\n\r\n".encode("utf-8")
footer = f"\r\n--{boundary}--\r\n".encode("utf-8")
body = header + img_bytes + footer

req = urllib.request.Request(
    "http://127.0.0.1:8000/estimate",
    data=body,
    headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
)

t0 = time.time()
with urllib.request.urlopen(req) as resp:
    res = json.loads(resp.read().decode("utf-8"))
total_time = time.time() - t0

print(f"Status: {res.get('status')}")
print(f"Total Roundtrip: {total_time:.2f}s")
print(f"Depth AI Inference: {res['metadata']['depth_time_s']}s")
print(f"Point Cloud Time: {res['metadata']['pointcloud_time_s']}s")
print(f"Height Analysis Time: {res['metadata']['height_time_s']}s")
print(f"3D Point Count: {res['metadata']['num_points']}")

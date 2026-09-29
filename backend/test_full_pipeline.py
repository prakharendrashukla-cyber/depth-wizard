import json
import base64
import numpy as np
from app.height import analyze_height, generate_ply_file

print('=== Test 1: Height Analysis ===')
dummy_depth = np.random.uniform(10.0, 100.0, (200, 200)).astype(np.float32)
analysis = analyze_height(dummy_depth, scale_factor=50.0)
assert 'raw_stats' in analysis
assert 'relative_metrics' in analysis
assert 'calibrated_metrics' in analysis
assert 'transects' in analysis
assert len(analysis['transects']['horizontal']) == 100
assert analysis['calibrated_metrics']['scale_factor_meters'] == 50.0
print('  [PASS] Height Analysis metrics & transects OK')

print('=== Test 2: Binary PLY Generation ===')
positions = np.array([
    [0.0, 0.0, 0.0],
    [1.0, 1.0, 1.0],
    [2.0, 2.0, 2.0],
], dtype=np.float32)
colors = np.array([
    [1.0, 0.0, 0.0],
    [0.0, 1.0, 0.0],
    [0.0, 0.0, 1.0],
], dtype=np.float32)
ply_bytes = generate_ply_file(positions, colors)
assert ply_bytes.startswith(b'ply\nformat binary_little_endian 1.0\n')
assert b'element vertex 3\n' in ply_bytes
print(f'  [PASS] PLY generation OK ({len(ply_bytes)} bytes)')

print('\nALL BACKEND UNIT TESTS PASSED!')

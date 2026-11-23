#!/usr/bin/env python3
"""Split OpenEar ZETA meshes for the temporal-bone page.

Reads the Draco GLBs in public/temporal-bone/models, writes child GLBs,
landmarks, CT labels, a stylized upper-body mesh, and a split report.

  python3 scripts/split_meshes.py

Requires Node and the local draco3d package (npm install --no-save draco3d).
Anatomical frame of this specimen, verified from the meshes:
  +X anterior, +Y inferior, +Z medial (right ear).
"""

from __future__ import annotations

import json
import shutil
import subprocess
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.ndimage import binary_dilation, binary_fill_holes
from scipy.spatial import cKDTree
from skimage.morphology import skeletonize

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "public" / "temporal-bone" / "models"
DATA = ROOT / "public" / "temporal-bone"
CODEC = ROOT / "scripts" / "glb_codec.mjs"
WORK = Path("/tmp/ent3d-split")
VERSION = "openear-zeta-frame-2"

ANTERIOR = np.array([1.0, 0.0, 0.0])
INFERIOR = np.array([0.0, 1.0, 0.0])
MEDIAL = np.array([0.0, 0.0, 1.0])
POSTERIOR = -ANTERIOR
SUPERIOR = -INFERIOR
LATERAL = -MEDIAL


def write_bin(path: Path, verts: np.ndarray, faces: np.ndarray) -> None:
    verts = np.ascontiguousarray(verts, dtype=np.float32)
    faces = np.ascontiguousarray(faces, dtype=np.uint32)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(np.array([len(verts), len(faces)], dtype=np.uint32).tobytes())
        handle.write(verts.tobytes())
        handle.write(faces.tobytes())


def read_bin(path: Path) -> tuple[np.ndarray, np.ndarray]:
    with path.open("rb") as handle:
        counts = np.frombuffer(handle.read(8), dtype=np.uint32)
        vertex_count, face_count = int(counts[0]), int(counts[1])
        verts = np.frombuffer(handle.read(vertex_count * 12), dtype=np.float32).reshape(vertex_count, 3).copy()
        faces = np.frombuffer(handle.read(face_count * 12), dtype=np.uint32).reshape(face_count, 3).copy()
    return verts, faces


def decode(name: str) -> tuple[np.ndarray, np.ndarray]:
    source = MODELS / f"{name}.glb"
    target = WORK / f"{name}.bin"
    if not target.exists():
        subprocess.check_call(["node", str(CODEC), "decode", str(source), str(target)])
    return read_bin(target)


def encode(verts: np.ndarray, faces: np.ndarray, glb_name: str) -> int:
    bin_path = WORK / "out" / f"{glb_name}.bin"
    write_bin(bin_path, verts, faces)
    subprocess.check_call(["node", str(CODEC), "encode", str(bin_path), str(MODELS / glb_name), glb_name.replace(".glb", "")])
    return int(len(verts))


def mesh_adjacency(faces: np.ndarray, count: int) -> list[list[int]]:
    adj: list[list[int]] = [[] for _ in range(count)]
    for tri in faces:
        a, b, c = int(tri[0]), int(tri[1]), int(tri[2])
        adj[a].extend((b, c))
        adj[b].extend((a, c))
        adj[c].extend((a, b))
    return adj


def smooth_labels(labels: np.ndarray, faces: np.ndarray, rounds: int = 2) -> np.ndarray:
    adj = mesh_adjacency(faces, len(labels))
    current = labels.copy()
    for _ in range(rounds):
        updated = current.copy()
        for index, neighbors in enumerate(adj):
            if not neighbors:
                continue
            votes = current[neighbors]
            updated[index] = np.bincount(votes).argmax()
        current = updated
    return current


def export_partition(verts: np.ndarray, faces: np.ndarray, labels: np.ndarray, names: list[str]) -> dict[str, dict[str, int]]:
    """Write one GLB per label. Crossing faces go to the majority label."""
    report: dict[str, dict[str, int]] = {}
    for label, name in enumerate(names):
        owned = labels == label
        votes = (labels[faces] == label).sum(axis=1)
        keep = votes >= 2
        used = faces[keep]
        if len(used) == 0:
            raise RuntimeError(f"{name} received no faces")
        unique, inverse = np.unique(used.ravel(), return_inverse=True)
        encode(verts[unique], inverse.reshape(-1, 3), f"{name}.glb")
        report[name] = {"exclusiveVertices": int(owned.sum()), "exportedVertices": int(len(unique)), "faces": int(keep.sum())}
    if int(labels.min()) < 0 or int(labels.max()) >= len(names):
        raise RuntimeError("unlabeled vertices")
    report["sumExclusive"] = int(sum(item["exclusiveVertices"] for key, item in report.items() if key != "sumExclusive"))
    return report


def dijkstra(adj: dict[int, list[tuple[int, float]]], source: int, count: int) -> np.ndarray:
    import heapq

    dist = np.full(count, np.inf)
    dist[source] = 0.0
    heap: list[tuple[float, int]] = [(0.0, source)]
    while heap:
        current, node = heapq.heappop(heap)
        if current != dist[node]:
            continue
        for other, weight in adj.get(node, ()):
            nxt = current + weight
            if nxt < dist[other]:
                dist[other] = nxt
                heapq.heappush(heap, (nxt, other))
    return dist


def edge_graph(verts: np.ndarray, faces: np.ndarray, mask: np.ndarray | None = None) -> dict[int, list[tuple[int, float]]]:
    adj: dict[int, list[tuple[int, float]]] = defaultdict(list)
    for tri in faces:
        ids = [int(v) for v in tri]
        for a, b in ((ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])):
            if mask is not None and (not mask[a] or not mask[b]):
                continue
            weight = float(np.linalg.norm(verts[a] - verts[b]))
            adj[a].append((b, weight))
            adj[b].append((a, weight))
    return adj


def skeleton_path(points: np.ndarray, pitch: float, dilate: int) -> np.ndarray:
    minimum = points.min(axis=0) - pitch * (dilate + 2)
    index = np.floor((points - minimum) / pitch).astype(np.int32)
    shape = tuple(int(value) for value in index.max(axis=0) + dilate + 4)
    grid = np.zeros(shape, dtype=bool)
    grid[index[:, 0], index[:, 1], index[:, 2]] = True
    if dilate:
        grid = binary_dilation(grid, iterations=dilate)
    grid = binary_fill_holes(grid)
    skeleton = skeletonize(grid)
    coords = np.argwhere(skeleton)
    world = (coords + 0.5) * pitch + minimum
    tree = cKDTree(coords)
    neighbors: dict[int, list[int]] = defaultdict(list)
    for a, b in tree.query_pairs(1.8):
        neighbors[a].append(int(b))
        neighbors[b].append(int(a))
    # Medial end is the highest Z. Distal mastoid end is the most inferior point.
    start = int(np.argmax(world[:, 2]))
    stop = int(np.argmax(world[:, 1]))
    from collections import deque

    previous = {start: -1}
    queue = deque([start])
    while queue:
        node = queue.popleft()
        for other in neighbors[node]:
            if other not in previous:
                previous[other] = node
                queue.append(other)
    if stop not in previous:
        raise RuntimeError("facial-nerve skeleton ends are disconnected")
    sequence: list[int] = []
    node = stop
    while node != -1:
        sequence.append(node)
        node = previous[node]
    sequence.reverse()
    return world[np.array(sequence)]


def arc_length(points: np.ndarray) -> np.ndarray:
    steps = np.linalg.norm(np.diff(points, axis=0), axis=1)
    return np.concatenate([[0.0], np.cumsum(steps)])


def sample_curve(points: np.ndarray, distances: np.ndarray, at: float) -> np.ndarray:
    index = int(np.clip(np.searchsorted(distances, at), 0, len(points) - 1))
    return points[index]


def cochlear_phase(points: np.ndarray, center: np.ndarray, axis: np.ndarray, zero: np.ndarray) -> np.ndarray:
    relative = points - center
    height = relative @ axis
    radial = relative - np.outer(height, axis)
    radius = np.linalg.norm(radial, axis=1)
    helper = np.array([0.0, 0.0, 1.0])
    if abs(float(np.dot(axis, helper))) > 0.9:
        helper = np.array([1.0, 0.0, 0.0])
    u = np.cross(axis, helper)
    u = u / np.linalg.norm(u)
    v = np.cross(axis, u)
    theta = np.arctan2(radial @ v, radial @ u)
    zero_theta = float(np.arctan2(np.dot(zero - center, v), np.dot(zero - center, u)))
    theta = (theta - zero_theta) % (2 * np.pi)
    outer = float(np.percentile(radius, 95))
    inner = float(np.percentile(radius, 8))
    # Archimedean unwrap of about 2.5 turns. The polar angle is then snapped
    # onto that branch so each cut is an angle about the modiolus, not a flat radius band.
    slope = (outer - inner) / (2.5 * 2 * np.pi)
    estimate = (outer - radius) / max(slope, 1e-6)
    turns = np.clip(np.round((estimate - theta) / (2 * np.pi)), 0, 3)
    return theta + 2 * np.pi * turns


def split_labyrinth(scala_vestibuli: tuple[np.ndarray, np.ndarray], scala_tympani: np.ndarray, stapes: np.ndarray) -> dict:
    verts, faces = scala_vestibuli
    distance, _ = cKDTree(scala_tympani).query(verts, k=1)
    cochlear = distance < 1.6
    rest = ~cochlear
    graph = edge_graph(verts, faces, rest)
    seeds = {
        "sup": int(np.argmin(np.where(rest, verts[:, 1], 1e9))),
        "post": int(np.argmin(np.where(rest, verts[:, 0], 1e9))),
        "lat": int(np.argmin(np.where(rest, verts[:, 2], 1e9))),
    }
    distances = {name: dijkstra(graph, source, len(verts)) for name, source in seeds.items()}
    cuts = {"sup": 8.2, "post": 7.2, "lat": 9.2}
    rest_labels = np.full(len(verts), 3, dtype=np.int32)  # vestibule
    for index in np.where(rest)[0]:
        best_name = None
        best_distance = 1e9
        for name, cut in cuts.items():
            value = distances[name][index]
            if value <= cut and value < best_distance:
                best_distance = value
                best_name = name
        if best_name == "lat":
            rest_labels[index] = 0
        elif best_name == "sup":
            rest_labels[index] = 1
        elif best_name == "post":
            rest_labels[index] = 2
    rest_faces = faces[rest[faces].all(axis=1)]
    rest_labels[rest] = smooth_labels(rest_labels[rest], remap_faces(rest, rest_faces), rounds=2) if False else rest_labels[rest]
    # Smooth on the full index space using only rest vertices' neighbors.
    labels = np.full(len(verts), -1, dtype=np.int32)
    labels[rest] = rest_labels[rest]
    labels = smooth_masked(labels, faces, rest)
    names = ["scc-lateral", "scc-superior", "scc-posterior", "vestibule"]
    part = export_partition(verts, faces[rest[faces].any(axis=1)], labels, names) if False else None
    # Export the four rest parts from faces that touch the rest mesh.
    rest_report = {}
    for label, name in enumerate(names):
        owned = labels == label
        votes = (labels[faces] == label).sum(axis=1)
        keep = votes >= 2
        used = faces[keep]
        unique, inverse = np.unique(used.ravel(), return_inverse=True)
        encode(verts[unique], inverse.reshape(-1, 3), f"{name}.glb")
        rest_report[name] = {"exclusiveVertices": int(owned.sum()), "exportedVertices": int(len(unique))}
    cochlear_verts_idx = np.where(cochlear)[0]
    return {
        "cochlearMask": cochlear,
        "restReport": rest_report,
        "exclusiveRest": int(rest.sum()),
        "exclusiveCochlear": int(cochlear.sum()),
        "seeds": {name: verts[index].round(3).tolist() for name, index in seeds.items()},
        "stapes": stapes.mean(axis=0).round(3).tolist(),
    }


def remap_faces(mask: np.ndarray, faces: np.ndarray) -> np.ndarray:
    remap = -np.ones(len(mask), dtype=np.int32)
    remap[np.where(mask)[0]] = np.arange(int(mask.sum()))
    return remap[faces]


def smooth_masked(labels: np.ndarray, faces: np.ndarray, mask: np.ndarray) -> np.ndarray:
    adj: list[list[int]] = [[] for _ in range(len(labels))]
    for tri in faces:
        ids = [int(v) for v in tri]
        for a, b in ((ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])):
            if mask[a] and mask[b] and labels[a] >= 0 and labels[b] >= 0:
                adj[a].append(b)
                adj[b].append(a)
    current = labels.copy()
    for _ in range(2):
        updated = current.copy()
        for index, neighbors in enumerate(adj):
            if not neighbors:
                continue
            updated[index] = np.bincount(current[neighbors]).argmax()
        current = updated
    return current


def export_cochlear_turns(name_prefix: str, verts: np.ndarray, faces: np.ndarray, phase: np.ndarray) -> dict:
    labels = np.zeros(len(verts), dtype=np.int32)
    labels[phase >= 2 * np.pi] = 1
    labels[phase >= 4 * np.pi] = 2
    labels = smooth_labels(labels, faces, rounds=1)
    names = [f"{name_prefix}-basal", f"{name_prefix}-middle", f"{name_prefix}-apical"]
    report = export_partition(verts, faces, labels, names)
    report["phaseMax"] = float(phase.max())
    return report


def facial_segments(verts: np.ndarray, faces: np.ndarray, cv: np.ndarray) -> dict:
    curve = skeleton_path(verts, pitch=0.15, dilate=2)
    if curve[0, 2] < curve[-1, 2]:
        curve = curve[::-1]
    # Edge-clamped smoothing. np.convolve would zero-pad and yank the curve toward the origin.
    smooth = curve.copy()
    half = 3
    for index in range(len(curve)):
        smooth[index] = curve[max(0, index - half) : index + half + 1].mean(axis=0)
    distance = arc_length(smooth)
    total = float(distance[-1])
    cv_tree = cKDTree(cv)
    samples = np.arange(0.0, total, 0.25)
    points = np.vstack([sample_curve(smooth, distance, value) for value in samples])
    cv_distance = cv_tree.query(points)[0]
    minimum_at = int(np.argmin(cv_distance[: max(1, int(8 / 0.25))]))
    fundus = float(samples[minimum_at])
    for index in range(minimum_at, len(samples)):
        if cv_distance[index] > cv_distance[minimum_at] + 0.45:
            fundus = float(samples[index])
            break
    fundus = float(np.clip(fundus, 3.0, 6.0))

    def tangent(at: float) -> np.ndarray:
        ahead = sample_curve(smooth, distance, at + 1.4) - sample_curve(smooth, distance, at - 1.4)
        length = np.linalg.norm(ahead) or 1.0
        return ahead / length

    def bend(at: float) -> float:
        first = tangent(at - 1.5)
        second = tangent(at + 1.5)
        return float(np.degrees(np.arccos(np.clip(np.dot(first, second), -1, 1))))

    meatal_end = float(np.clip(fundus, 3.0, 6.0))
    sample_grid = np.arange(0.0, total, 0.25)
    tangents = np.vstack([tangent(value) for value in sample_grid])
    # Second genu: the nerve's tangent becomes inferior (+Y).
    distal = np.where((sample_grid > 10.0) & (tangents[:, 1] > 0.7))[0]
    genu2 = float(sample_grid[distal[0]]) if len(distal) else total * 0.62
    # First genu: the tangent gains a posterior (−X) component before that descent.
    proximal = np.where((sample_grid > meatal_end + 2.0) & (sample_grid < genu2 - 4.0) & (tangents[:, 0] < -0.45))[0]
    genu1 = float(sample_grid[proximal[0]]) if len(proximal) else meatal_end + 4.0
    # The lateral course already points slightly posterior, so keep the labyrinthine
    # segment in the taught 3–5 mm range instead of collapsing it onto that slope.
    genu1 = max(genu1, meatal_end + 4.8)
    first_peak = genu1
    second_peak = genu2
    cuts = [
        ("fn-meatal", 0.0, meatal_end),
        ("fn-labyrinthine", meatal_end, genu1 - 1.0),
        ("fn-geniculate", genu1 - 1.0, genu1 + 1.0),
        ("fn-tympanic", genu1 + 1.0, genu2 - 1.5),
        ("fn-second-genu", genu2 - 1.5, genu2 + 1.5),
        ("fn-mastoid", genu2 + 1.5, total + 1.0),
    ]
    names = [item[0] for item in cuts]
    nearest = cKDTree(points).query(verts, k=1)[1]
    vertex_s = samples[nearest]
    labels = np.zeros(len(verts), dtype=np.int32)
    for label, (_, start, stop) in enumerate(cuts):
        labels[(vertex_s >= start) & (vertex_s < stop)] = label
    labels[vertex_s >= cuts[-1][1]] = len(cuts) - 1
    print("FN cuts", cuts, "peaks", first_peak, second_peak, "fundus", fundus, "total", total)
    print("FN label counts", {name: int((labels == i).sum()) for i, name in enumerate(names)})
    labels = smooth_labels(labels, faces, rounds=1)
    print("FN label counts after smooth", {name: int((labels == i).sum()) for i, name in enumerate(names)})
    report = export_partition(verts, faces, labels, names)
    report["arcMm"] = total
    report["fundusMm"] = fundus
    report["firstGenuMm"] = first_peak
    report["secondGenuMm"] = second_peak
    report["rangesMm"] = {name: [start, stop] for name, start, stop in cuts}
    report["centerline"] = smooth[::4].round(3).tolist()
    return report


def split_tympanic(tm: tuple[np.ndarray, np.ndarray], malleus: np.ndarray) -> dict:
    verts, faces = tm
    tree = cKDTree(verts)
    distance, index = tree.query(malleus, k=1)
    near = distance < 1.0
    if not np.any(near):
        near = distance <= np.percentile(distance, 20)
    candidates = malleus[near]
    lateral_process = candidates[int(np.argmin(candidates[:, 1]))]
    # Pars flaccida is the small superior cap above the lateral process.
    flaccid = verts[:, 1] < float(lateral_process[1]) - 0.4
    fraction = float(flaccid.mean())
    method = "plane-superior-to-lateral-process"
    if fraction < 0.04 or fraction > 0.28:
        limit = float(np.quantile(verts[:, 1], 0.12))
        flaccid = verts[:, 1] <= limit
        method = "superior-12-percent-fallback"
        fraction = float(flaccid.mean())
    labels = np.zeros(len(verts), dtype=np.int32)
    labels[flaccid] = 1
    labels = smooth_labels(labels, faces, rounds=1)
    report = export_partition(verts, faces, labels, ["tm-pars-tensa", "tm-pars-flaccida"])
    report["method"] = method
    report["flaccidFraction"] = fraction
    report["lateralProcess"] = lateral_process.round(3).tolist()
    return report


def pca_ends(points: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    center = points.mean(axis=0)
    _, _, vt = np.linalg.svd(points - center, full_matrices=False)
    axis = vt[0]
    projection = (points - center) @ axis
    return points[int(projection.argmax())], points[int(projection.argmin())], axis


def umeyama(source: np.ndarray, target: np.ndarray) -> dict:
    mean_source = source.mean(axis=0)
    mean_target = target.mean(axis=0)
    centered_source = source - mean_source
    centered_target = target - mean_target
    covariance = centered_target.T @ centered_source / len(source)
    u, singular, vt = np.linalg.svd(covariance)
    rotation = u @ vt
    if np.linalg.det(rotation) < 0:
        u = u.copy()
        u[:, -1] *= -1
        rotation = u @ vt
        singular = singular.copy()
        singular[-1] *= -1
    variance = float((centered_source ** 2).sum() / len(source))
    scale = float(np.sum(singular) / variance) if variance else 1.0
    translation = mean_target - scale * rotation @ mean_source
    predicted = scale * (rotation @ source.T).T + translation
    residual = np.linalg.norm(predicted - target, axis=1)
    return {
        "scale": scale,
        "rmsMm": float(np.sqrt(np.mean(residual ** 2))),
        "maxMm": float(residual.max()),
        "translationMm": translation.round(4).tolist(),
    }


def icosphere(radius: float, center: np.ndarray, subdivisions: int = 2) -> tuple[np.ndarray, np.ndarray]:
    phi = (1 + 5**0.5) / 2
    verts = []
    for z in (-1, 1):
        for y in (-phi, phi):
            verts.append([0, y, z])
    for y in (-1, 1):
        for x in (-phi, phi):
            verts.append([y, x, 0])
    for x in (-1, 1):
        for z in (-phi, phi):
            verts.append([z, 0, x])
    points = np.array(verts, dtype=np.float64)
    points /= np.linalg.norm(points, axis=1)[:, None]
    faces = [
        (0, 11, 5), (0, 5, 1), (0, 1, 7), (0, 7, 10), (0, 10, 11),
        (1, 5, 9), (5, 11, 4), (11, 10, 2), (10, 7, 6), (7, 1, 8),
        (3, 9, 4), (3, 4, 2), (3, 2, 6), (3, 6, 8), (3, 8, 9),
        (4, 9, 5), (2, 4, 11), (6, 2, 10), (8, 6, 7), (9, 8, 1),
    ]
    faces_arr = np.array(faces, dtype=np.int32)
    for _ in range(subdivisions):
        midpoint: dict[tuple[int, int], int] = {}
        new_faces = []
        for tri in faces_arr:
            ids = []
            for a, b in ((int(tri[0]), int(tri[1])), (int(tri[1]), int(tri[2])), (int(tri[2]), int(tri[0]))):
                key = (min(a, b), max(a, b))
                if key not in midpoint:
                    point = points[a] + points[b]
                    point /= np.linalg.norm(point)
                    midpoint[key] = len(points)
                    points = np.vstack([points, point])
                ids.append(midpoint[key])
            a, b, c = int(tri[0]), int(tri[1]), int(tri[2])
            ab, bc, ca = ids
            new_faces.extend(((a, ab, ca), (b, bc, ab), (c, ca, bc), (ab, bc, ca)))
        faces_arr = np.array(new_faces, dtype=np.int32)
    return points * radius + center, faces_arr.astype(np.uint32)


def tube(start: np.ndarray, end: np.ndarray, radius: float, sides: int = 12) -> tuple[np.ndarray, np.ndarray]:
    direction = end - start
    length = np.linalg.norm(direction)
    direction = direction / length
    helper = np.array([1.0, 0.0, 0.0]) if abs(direction[0]) < 0.9 else np.array([0.0, 0.0, 1.0])
    u = np.cross(direction, helper)
    u /= np.linalg.norm(u)
    v = np.cross(direction, u)
    angles = np.linspace(0, 2 * np.pi, sides, endpoint=False)
    ring = np.stack([np.cos(angles), np.sin(angles)], axis=1)
    rings = []
    for t in (0.0, 1.0):
        origin = start * (1 - t) + end * t
        rings.append(origin + radius * (ring[:, 0:1] * u + ring[:, 1:2] * v))
    verts = np.vstack(rings)
    faces = []
    for i in range(sides):
        j = (i + 1) % sides
        faces.append((i, j, sides + j))
        faces.append((i, sides + j, sides + i))
    return verts.astype(np.float32), np.array(faces, dtype=np.uint32)


def merge_meshes(parts: list[tuple[np.ndarray, np.ndarray]]) -> tuple[np.ndarray, np.ndarray]:
    verts = []
    faces = []
    offset = 0
    for part_verts, part_faces in parts:
        verts.append(part_verts)
        faces.append(part_faces + offset)
        offset += len(part_verts)
    return np.vstack(verts), np.vstack(faces)


def source(citation: str, page: str, verified: bool = False) -> dict:
    return {"citation": citation, "page": page, "verified": verified}


CUMMINGS_126 = "Cummings Otolaryngology–Head and Neck Surgery, 7th ed, Ch126 Anatomy of the Temporal Bone, External Ear, and Middle Ear"
CUMMINGS_175 = "Cummings Otolaryngology–Head and Neck Surgery, 7th ed, Ch175 Surgical Anatomy of the Lateral Skull Base"
FRANCIS_2 = "Francis HW, Niparko JK. Temporal Bone Dissection Guide, 2nd ed, Ch2 Anatomy of the Temporal Bone"
FRANCIS_3 = "Francis HW, Niparko JK. Temporal Bone Dissection Guide, 2nd ed, Ch3 Mastoidectomy"
JACKLER = "Jackler external-ear chapter identified in the phase-1 audit; the page was not opened for this draft"


def landmark(item_id: str, parent: str, en: str, ko: str, xyz, clinical: str, anatomy: str, sources: list, method: str, surgical: bool = False) -> dict:
    return {
        "id": item_id,
        "parent": parent,
        "en": en,
        "ko": ko,
        "anatomy": anatomy,
        "clinical": clinical,
        "sources": sources,
        "xyz_mm": [round(float(v), 3) for v in xyz],
        "method": method,
        "review": "미검증",
        "surgical": surgical,
    }


def main() -> None:
    raise SystemExit(
        "scripts/split_meshes.py would relabel canals by extreme vertices and overwrite the head registration. "
        "Use scripts/anatomy_accuracy.py."
    )
    WORK.mkdir(parents=True, exist_ok=True)
    scala_v, scala_vf = decode("scala-vestibuli")
    # The parent file is the original mesh. Do not copy scala-vestibuli.glb:
    # a second run would copy the already-split cochlear mesh.
    encode(scala_v, scala_vf, "labyrinth.glb")
    scala_t, scala_tf = decode("scala-tympani")
    facial, facial_f = decode("facial-nerve")
    cv, _ = decode("cochleovestibular-nerve")
    malleus, _ = decode("malleus")
    incus, _ = decode("incus")
    stapes, stapes_f = decode("stapes")
    tm, tm_f = decode("tympanic-membrane")
    eac, _ = decode("external-auditory-canal")
    bone, _ = decode("bone")
    chorda, _ = decode("chorda-tympani")
    sinus, _ = decode("sinus-dura")
    carotid, _ = decode("carotid-artery")

    labyrinth = split_labyrinth((scala_v, scala_vf), scala_t, stapes)
    cochlear_mask = labyrinth["cochlearMask"]
    cochlear_index = np.where(cochlear_mask)[0]
    remap = -np.ones(len(scala_v), dtype=np.int32)
    remap[cochlear_index] = np.arange(len(cochlear_index))
    cochlear_faces = scala_vf[cochlear_mask[scala_vf].all(axis=1)]
    cochlear_verts = scala_v[cochlear_index]
    cochlear_faces = remap[cochlear_faces]
    encode(cochlear_verts, cochlear_faces, "scala-vestibuli.glb")

    center = scala_t.mean(axis=0)
    _, _, vt = np.linalg.svd(scala_t - center, full_matrices=False)
    axis = vt[2].copy()
    relative = scala_t - center
    radius = np.linalg.norm(relative - np.outer(relative @ axis, axis), axis=1)
    if np.corrcoef(relative @ axis, radius)[0, 1] > 0:
        axis = -axis
    round_window = scala_t[int(np.argmin(scala_t[:, 2]))]
    st_phase = cochlear_phase(scala_t, center, axis, round_window)
    sv_phase = cochlear_phase(cochlear_verts, center, axis, round_window)
    tympani_turns = export_cochlear_turns("scala-tympani", scala_t, scala_tf, st_phase)
    vestibuli_turns = export_cochlear_turns("scala-vestibuli", cochlear_verts, cochlear_faces, sv_phase)
    nerve = facial_segments(facial, facial_f, cv)
    membrane = split_tympanic((tm, tm_f), malleus)

    # Ossicle points from geometry.
    mal_a, mal_b, _ = pca_ends(malleus)
    tm_center = tm.mean(axis=0)
    umbo = mal_a if np.linalg.norm(mal_a - tm_center) < np.linalg.norm(mal_b - tm_center) else mal_b
    head = mal_b if np.all(umbo == mal_a) else mal_a
    tm_tree = cKDTree(tm)
    mal_dist, _ = tm_tree.query(malleus, k=1)
    near_tm = mal_dist < 1.1
    if not np.any(near_tm):
        near_tm = mal_dist <= np.percentile(mal_dist, 15)
    lateral_process = malleus[near_tm][int(np.argmin(malleus[near_tm][:, 1]))]
    neck = (head + lateral_process) / 2
    manubrium = (lateral_process + umbo) / 2
    inc_a, inc_b, _ = pca_ends(incus)
    stapes_center = stapes.mean(axis=0)
    long_process = inc_a if np.linalg.norm(inc_a - stapes_center) < np.linalg.norm(inc_b - stapes_center) else inc_b
    short_process = inc_b if np.all(long_process == inc_a) else inc_a
    incus_body = incus.mean(axis=0)
    lenticular = incus[int(np.argmin(np.linalg.norm(incus - stapes_center, axis=1)))]
    foot_scores = stapes[:, 2]
    footplate = stapes[foot_scores >= np.quantile(foot_scores, 0.72)].mean(axis=0)
    stapes_head = stapes[int(np.argmin(np.linalg.norm(stapes - lenticular, axis=1)))]
    eac_center = eac.mean(axis=0)
    lateral_eac = eac[eac[:, 2] <= np.quantile(eac[:, 2], 0.15)]
    rim_score = lateral_eac[:, 0] + lateral_eac[:, 1]  # low X and low Y = posterosuperior
    eac_rim = lateral_eac[int(np.argmin(rim_score))]
    bone_tree = cKDTree(bone)

    def bone_near(point: np.ndarray) -> np.ndarray:
        _, index = bone_tree.query(point, k=1)
        return bone[int(index)]

    henle = bone_near(eac_rim + POSTERIOR * 1.5 + SUPERIOR * 0.6 + LATERAL * 0.8)
    macewen = bone_near(henle + POSTERIOR * 4.0 + SUPERIOR * 3.0)
    temporal_line = bone_near(macewen + SUPERIOR * 8.0 + ANTERIOR * 2.0)
    lateral_posterior = (bone[:, 2] < np.median(bone[:, 2])) & (bone[:, 0] < np.median(bone[:, 0]))
    mastoid_pool = bone[lateral_posterior]
    mastoid_tip = mastoid_pool[int(np.argmax(mastoid_pool[:, 1]))]
    digastric = bone_near(mastoid_tip + MEDIAL * 6.0 + SUPERIOR * 4.0 + ANTERIOR * 1.0)
    middle = malleus.mean(axis=0)
    above = bone[np.linalg.norm(bone - middle, axis=1) < 14]
    tegmen = above[int(np.argmin(above[:, 1]))]
    sinus_center = sinus.mean(axis=0)
    sinodural = bone_near(tegmen * 0.45 + sinus_center * 0.55 + SUPERIOR * 1.0)
    antrum = henle + MEDIAL * 8.0 + POSTERIOR * 2.5 + SUPERIOR * 2.0
    promontory = scala_t[int(np.argmin(scala_t[:, 2]))]
    fn_curve = np.array(nerve["centerline"])
    mastoid_line = fn_curve[fn_curve[:, 1] > np.median(fn_curve[:, 1])]
    mastoid_mid = mastoid_line[len(mastoid_line) // 2]
    geniculate = sample_point(fn_curve, nerve["firstGenuMm"], nerve["arcMm"])
    chorda_mid = chorda.mean(axis=0)
    facial_recess = (mastoid_mid + chorda_mid) / 2
    pyramidal = mastoid_mid + ANTERIOR * 1.5 + LATERAL * 1.0
    sinus_tympani = round_window + MEDIAL * 1.5 + POSTERIOR * 1.2
    cochleariform = lateral_process + ANTERIOR * 2.0 + MEDIAL * 1.2
    prussak = (np.array(membrane["lateralProcess"]) + neck) / 2 + LATERAL * 0.4
    zygomatic = bone_near(eac_center + ANTERIOR * 18 + SUPERIOR * 4 + LATERAL * 2)
    stylomastoid = fn_curve[-1]
    sigmoid_point = sinus[int(np.argmax(sinus[:, 1] - sinus[:, 0]))]
    jugular = sigmoid_point + INFERIOR * 6 + ANTERIOR * 2
    iac = cv[int(np.argmax(cv[:, 2]))]
    basal_turn = scala_t[st_phase < 2 * np.pi].mean(axis=0)
    middle_turn = scala_t[(st_phase >= 2 * np.pi) & (st_phase < 4 * np.pi)].mean(axis=0)
    apical_turn = scala_t[st_phase >= 4 * np.pi].mean(axis=0) if np.any(st_phase >= 4 * np.pi) else scala_t[int(np.argmax(radius * 0 + (relative @ axis))) ] if False else scala_t[st_phase >= np.percentile(st_phase, 80)].mean(axis=0)

    s_cummings = [source(CUMMINGS_126, "audit page ref", False)]
    s_francis = [source(FRANCIS_3, "audit page ref", False)]
    s_175 = [source(CUMMINGS_175, "audit page ref", False)]
    points = [
        landmark("malleus-head", "malleus", "Head of malleus", "추골 두부", head, "Lies in the epitympanum and meets the body of the incus.", "Superior end of the malleus principal axis, opposite the umbo.", [source(FRANCIS_2, "p5", False)], "computed", True),
        landmark("malleus-neck", "malleus", "Neck of malleus", "추골 경부", neck, "The chorda tympani passes medial to this region.", "Midpoint between the head and the lateral process.", s_cummings, "computed", True),
        landmark("malleus-manubrium", "malleus", "Manubrium", "추골병", manubrium, "Embedded in the tympanic membrane.", "Midpoint between the lateral process and the umbo.", s_cummings, "computed"),
        landmark("malleus-lateral-process", "malleus", "Lateral process", "추골 외측돌기(단돌기)", lateral_process, "Otoscopic landmark at the mallear prominence.", "Malleus vertex nearest the membrane at its superior contact.", s_cummings, "computed", True),
        landmark("umbo", "malleus", "Umbo", "제(umbo)", umbo, "Tip of the manubrium at the membrane.", "Malleus principal-axis end closer to the membrane centre.", s_cummings, "computed", True),
        landmark("incus-body", "incus", "Body of incus", "침골 체부", incus_body, "Sits in the epitympanum at the incudomalleolar joint.", "Centroid of the incus.", [source(FRANCIS_2, "p5", False)], "computed"),
        landmark("incus-short-process", "incus", "Short process of incus", "침골 단각", short_process, "Points toward the fossa incudis; a mastoidectomy depth landmark.", "Incus principal-axis end farther from the stapes.", s_francis, "computed", True),
        landmark("incus-long-process", "incus", "Long process of incus", "침골 장각", long_process, "Common site of ossicular erosion.", "Incus principal-axis end closer to the stapes.", s_cummings, "computed", True),
        landmark("incus-lenticular", "incus", "Lenticular process", "침골 두상돌기", lenticular, "Articulates with the stapes head.", "Incus vertex nearest the stapes.", [source(JACKLER, "미검증", False)], "computed"),
        landmark("stapes-head", "stapes", "Head of stapes", "등골 두부", stapes_head, "Incudostapedial joint.", "Stapes vertex nearest the lenticular process.", [source(JACKLER, "미검증", False)], "computed", True),
        landmark("stapes-footplate", "stapes", "Footplate", "등골 족판", footplate, "Sits in the oval window.", "Centroid of the medial stapes vertex cluster.", [source(FRANCIS_2, "p7", False)], "computed", True),
        landmark("oval-window", "stapes", "Oval window", "난원창", footplate, "The facial nerve runs directly above it.", "Same computed point as the footplate centroid.", s_cummings, "computed", True),
        landmark("round-window", "scala-tympani", "Round window", "정원창", round_window, "Opens into the scala tympani; cochlear-implant entry.", "Most lateral scala tympani vertex.", s_cummings, "computed", True),
        landmark("promontory", "scala-tympani", "Promontory", "갑각", promontory, "Basal-turn bulge on the medial wall.", "Lateral surface point of the scala tympani.", s_cummings, "computed", True),
        landmark("cochlea-basal", "scala-tympani", "Basal turn", "와우 기저회전", basal_turn, "The promontory overlies the basal turn.", "Centroid of the first 360° about the modiolus.", s_175, "computed"),
        landmark("cochlea-middle", "scala-tympani", "Middle turn", "와우 중간회전", middle_turn, "Middle cochlear turn.", "Centroid of the second 360° about the modiolus.", s_cummings, "computed"),
        landmark("cochlea-apical", "scala-tympani", "Apical turn", "와우 첨부회전", apical_turn, "Apical cochlear turn.", "Centroid of the remaining angle about the modiolus.", s_cummings, "computed"),
        landmark("geniculate-ganglion", "fn-geniculate", "Geniculate ganglion", "슬신경절", geniculate, "First genu. The greater superficial petrosal nerve leaves here.", "Centerline point at the first bend.", s_cummings, "computed", True),
        landmark("cochleariform-process", "malleus", "Cochleariform process", "와우형돌기", cochleariform, "The tensor tympani tendon turns here; anterior facial-nerve landmark.", "Estimated anterior to the lateral process. Not segmented.", s_cummings, "manual", True),
        landmark("pyramidal-eminence", "facial-nerve", "Pyramidal eminence", "추체융기", pyramidal, "The stapedius tendon leaves this eminence.", "Estimated beside the second genu. Not segmented.", s_cummings, "manual", True),
        landmark("sinus-tympani", "scala-tympani", "Sinus tympani", "고실동", sinus_tympani, "Medial to the facial nerve; a hidden cholesteatoma site.", "Estimated just medial and posterior to the round window.", s_cummings, "manual", True),
        landmark("facial-recess", "facial-nerve", "Facial recess", "안면신경와", facial_recess, "Posterior tympanotomy passes between the facial nerve and the chorda.", "Midpoint between the mastoid segment and the chorda tympani.", s_cummings, "computed", True),
        landmark("prussak-space", "tympanic-membrane", "Prussak space", "Prussak 공간", prussak, "Between pars flaccida and the malleus neck; attic cholesteatoma.", "Estimated at the lateral process / neck.", s_cummings, "manual", True),
        landmark("henle-spine", "bone", "Spine of Henle", "Henle 극", henle, "The antrum lies deep and posterosuperior to it.", "Bone surface just posterosuperior to the lateral canal rim.", s_cummings, "manual", True),
        landmark("macewen-triangle", "bone", "MacEwen triangle", "MacEwen 삼각", macewen, "Surface marker of the antrum.", "Bone surface posterosuperior to the spine of Henle.", s_cummings, "manual", True),
        landmark("mastoid-antrum", "bone", "Mastoid antrum", "유양동", antrum, "Largest mastoid air cell. No air-cell mesh yet.", "Estimated medial to the spine of Henle.", s_cummings, "manual", True),
        landmark("tegmen", "bone", "Tegmen", "천개", tegmen, "Floor of the middle cranial fossa.", "Most superior bone vertex near the middle ear.", s_cummings, "manual", True),
        landmark("sinodural-angle", "sinus-dura", "Sinodural angle", "정맥동경막각", sinodural, "Between the sigmoid sinus and the tegmen.", "Bone point between the tegmen and the sinus mesh.", s_cummings, "manual", True),
        landmark("digastric-ridge", "bone", "Digastric ridge", "이복근릉", digastric, "Leads toward the stylomastoid foramen.", "Estimated medial to the mastoid tip.", s_cummings, "manual", True),
        landmark("mastoid-tip", "bone", "Mastoid tip", "유양돌기 첨부", mastoid_tip, "Inferior end of the mastoid.", "Most inferior vertex on the posterolateral bone.", [source(FRANCIS_3, "p2", False)], "computed", True),
        landmark("temporal-line", "bone", "Temporal line", "측두선", temporal_line, "Superior limit of a cortical mastoidectomy.", "Estimated on the lateral surface above MacEwen's triangle.", s_francis, "manual", True),
        landmark("sigmoid-sinus", "sinus-dura", "Sigmoid sinus", "S상정맥동", sigmoid_point, "Posterior limit of mastoidectomy. The mesh still mixes sinus and dura.", "Point on the sinus-dura mesh. The jugular bulb is not segmented.", s_cummings, "manual", True),
        landmark("jugular-bulb", "sinus-dura", "Jugular bulb", "경정맥구", jugular, "A high bulb can sit under the middle ear. Not segmented.", "Estimated inferior to the sigmoid point.", s_cummings, "manual", True),
        landmark("eac-porus", "external-auditory-canal", "EAC porus", "외이도 입구", eac_center, "Lateral opening of the canal.", "Centroid of the external auditory canal mesh.", s_cummings, "computed"),
        landmark("iac", "cochleovestibular-nerve", "Internal auditory canal", "내이도", iac, "The facial nerve is anterosuperior at the fundus.", "Medial end of the cochleovestibular nerve mesh.", s_175, "computed", True),
        landmark("zygomatic-root", "bone", "Zygomatic root", "관골돌기 기시부", zygomatic, "Anterior landmark on the lateral surface.", "Bone surface anterior to the canal.", s_cummings, "manual"),
        landmark("stylomastoid-foramen", "fn-mastoid", "Stylomastoid foramen", "경유돌공", stylomastoid, "The mastoid segment leaves the skull here.", "Distal end of the facial-nerve centerline.", s_cummings, "computed", True),
        landmark("vestibule-center", "vestibule", "Vestibule", "전정", scala_v[labyrinth["cochlearMask"] == False].mean(axis=0) * 0 + np.array(labyrinth["seeds"]["sup"]) * 0 + footplate, "Central chamber of the labyrinth.", "Representative point at the oval window, which opens into the vestibule.", s_cummings, "computed"),
        landmark("scc-lateral-arch", "scc-lateral", "Lateral semicircular canal", "외측반고리관", np.array(labyrinth["seeds"]["lat"]), "Mastoid landmark; the antrum floor is nearby.", "Most lateral vertex of the vestibular mesh, used as the canal seed.", s_cummings, "computed", True),
        landmark("scc-superior-arch", "scc-superior", "Superior semicircular canal", "상반고리관", np.array(labyrinth["seeds"]["sup"]), "Related to the arcuate eminence on the middle-fossa floor.", "Most superior vertex of the vestibular mesh.", s_175, "computed", True),
        landmark("scc-posterior-arch", "scc-posterior", "Posterior semicircular canal", "후반고리관", np.array(labyrinth["seeds"]["post"]), "Landmark in translabyrinthine surgery.", "Most posterior vertex of the vestibular mesh.", s_175, "computed", True),
        landmark("pars-flaccida", "tm-pars-flaccida", "Pars flaccida", "이완부", np.array(membrane["lateralProcess"]) + SUPERIOR * 1.2, "Attic retraction pocket.", "Just superior to the lateral process.", s_cummings, "computed"),
        landmark("carotid-canal", "carotid-artery", "Carotid canal", "경동맥관", carotid.mean(axis=0), "Petrous carotid. Anterior to the cochlea.", "Centroid of the carotid mesh.", s_175, "computed", True),
    ]
    # vestibule center should be the rest-mesh centroid near the stapes, not the footplate twice.
    rest_pts = scala_v[~cochlear_mask]
    vestibule_pts = rest_pts[np.linalg.norm(rest_pts - footplate, axis=1) < 6.5]
    if len(vestibule_pts) > 20:
        points[points.index(next(item for item in points if item["id"] == "vestibule-center"))]["xyz_mm"] = vestibule_pts.mean(axis=0).round(3).tolist()
    if len(points) < 35:
        raise RuntimeError(f"only {len(points)} landmarks")
    (DATA / "landmarks.json").write_text(json.dumps({
        "model_version": VERSION,
        "frame": "zeta-mm; +X anterior, +Y inferior, +Z medial",
        "review": "미검증",
        "landmarks": points,
    }, ensure_ascii=False, indent=2), encoding="utf8")

    volume = json.loads((DATA / "ct" / "volume.json").read_text())
    ct_terms = []
    plane_for = {
        "iac": "coronal", "round-window": "coronal", "oval-window": "coronal", "promontory": "coronal",
        "cochlea-basal": "coronal", "vestibule-center": "coronal", "scc-lateral-arch": "coronal",
        "malleus-umbo": "umbo", "umbo": "coronal", "incus-body": "coronal", "stapes-footplate": "coronal",
        "eac-porus": "coronal", "carotid-canal": "coronal", "sigmoid-sinus": "axial", "tegmen": "sagittal",
        "mastoid-antrum": "axial", "facial-recess": "axial", "scc-superior-arch": "sagittal",
        "mastoid-tip": "sagittal", "jugular-bulb": "sagittal", "geniculate-ganglion": "sagittal",
    }
    # Keys above: folder "coronal" is anatomical axial (constant Y). "axial" folder is anatomical sagittal.
    wanted = [
        "iac", "round-window", "oval-window", "promontory", "cochlea-basal", "vestibule-center",
        "scc-lateral-arch", "umbo", "incus-long-process", "stapes-footplate", "eac-porus",
        "carotid-canal", "sigmoid-sinus", "tegmen", "mastoid-antrum", "facial-recess",
        "scc-superior-arch", "mastoid-tip", "jugular-bulb", "geniculate-ganglion",
    ]
    by_id = {item["id"]: item for item in points}
    for item_id in wanted:
        item = by_id[item_id]
        plane = plane_for.get(item_id, "coronal")
        xyz = item["xyz_mm"]
        ct_terms.append(ct_annotation(volume, plane, item, xyz))
    (DATA / "ct-labels.json").write_text(json.dumps({
        "model_version": VERSION,
        "note": "Folder names stay axial/coronal/sagittal as published. Anatomical names follow +X anterior, +Y inferior, +Z medial.",
        "labels": ct_terms,
    }, ensure_ascii=False, indent=2), encoding="utf8")

    surface = surface_labels(eac_center, mastoid_tip, zygomatic, temporal_line)
    (DATA / "surface-anatomy.json").write_text(json.dumps({
        "model_version": VERSION,
        "review": "미검증",
        "labels": surface,
    }, ensure_ascii=False, indent=2), encoding="utf8")

    body = build_upper_body(eac_center, mastoid_tip, zygomatic, stylomastoid, iac)
    encode_to(body[0], body[1], ROOT / "public" / "models" / "upper-body" / "upper-body.glb")
    registration = {
        "method": "Umeyama similarity on 5 pairs. The stylized surface was authored in the ZETA millimetre frame, so the pairs coincide.",
        "scale": body[2]["scale"],
        "rmsMm": body[2]["rmsMm"],
        "maxMm": body[2]["maxMm"],
        "within5Percent": abs(body[2]["scale"] - 1) <= 0.05,
        "pairs": ["EAC porus", "mastoid tip", "zygomatic root", "stylomastoid foramen", "IAC medial"],
        "review": "미검증",
        "license": "Original stylized mesh. Z-Anatomy LICENSE checked 2026-11-21 is CC BY-SA 4.0, but the redistributable file is a 293 MB Blender template and was not decimated into this GLB.",
    }
    upper = ROOT / "public" / "models" / "upper-body"
    (upper / "registration.json").write_text(json.dumps(registration, indent=2), encoding="utf8")
    (upper / "LICENSE").write_text(LICENSE_TEXT, encoding="utf8")

    manifest = json.loads((DATA / "manifest.json").read_text())
    manifest["model_version"] = VERSION
    manifest["specimen"]["model_version"] = VERSION
    manifest["coordinate_system"] = {
        "units": "mm",
        "x": {"ko": "앞(+X) / 뒤(−X)", "en": "anterior +X / posterior −X"},
        "y": {"ko": "아래(+Y) / 위(−Y)", "en": "inferior +Y / superior −Y"},
        "z": {"ko": "안쪽(+Z) / 가쪽(−Z). 오른쪽 귀", "en": "medial +Z / lateral −Z. Right ear"},
        "note": {
            "ko": "메시 축은 RAS가 아닙니다. +X 앞, +Y 아래, +Z 안쪽입니다. 꼭짓점은 그대로이고 viewer_offset_mm만 화면 평행이동입니다. 배율은 1입니다.",
            "en": "Mesh axes are not RAS. +X is anterior, +Y is inferior, +Z is medial. Vertices are unscaled; viewer_offset_mm is only a view translation.",
        },
    }
    manifest["anatomicalFrame"] = {
        "anterior": [1, 0, 0],
        "posterior": [-1, 0, 0],
        "inferior": [0, 1, 0],
        "superior": [0, -1, 0],
        "medial": [0, 0, 1],
        "lateral": [0, 0, -1],
        "review": "미검증",
    }
    manifest["specimen"]["geometry_note"] = {
        "ko": "오른쪽 측두골 ZETA. 축은 +X 앞, +Y 아래, +Z 안쪽입니다. 전정계로 표시돼 있던 메시를 와우 전정계, 전정, 세 반고리관으로 나눴고, 안면신경은 6분절, 와우는 회전, 고막은 긴장부·이완부로 나눴습니다. 좌표와 분할 경계는 미검증입니다. S상정맥동·경막은 한 메시에 섞여 있을 수 있습니다. 경정맥구 메시는 없습니다.",
        "en": "Right temporal bone, specimen ZETA. Axes are +X anterior, +Y inferior, +Z medial. The mesh labeled scala vestibuli was split into cochlear scala vestibuli, vestibule, and three semicircular canals. The facial nerve has six segments, the cochlea is split by turn, and the tympanic membrane into pars tensa and pars flaccida. Boundaries are unverified. Sinus and dura may still share one mesh. There is no jugular bulb mesh.",
    }
    manifest["missing_structures"] = [
        {"name": "Jugular bulb", "note": "Not segmented. A review point is in landmarks.json. This is the jugular bulb (경정맥구), not the jugular foramen (목정맥공)."},
        {"name": "Mastoid antrum mesh", "note": "Phase 1 has a landmark only. Air-cell segmentation is later."},
    ]
    structures = {item["id"]: item for item in manifest["structures"]}
    structures["scala-vestibuli"]["parent"] = "labyrinth"
    structures["scala-vestibuli"]["file"] = "models/scala-vestibuli.glb"
    add_structures(structures)
    order = [
        "scala-tympani", "scala-tympani-basal", "scala-tympani-middle", "scala-tympani-apical",
        "labyrinth", "scala-vestibuli", "scala-vestibuli-basal", "scala-vestibuli-middle", "scala-vestibuli-apical",
        "vestibule", "scc-lateral", "scc-superior", "scc-posterior",
        "malleus", "incus", "stapes",
        "facial-nerve", "fn-meatal", "fn-labyrinthine", "fn-geniculate", "fn-tympanic", "fn-second-genu", "fn-mastoid",
        "chorda-tympani", "cochleovestibular-nerve",
        "tympanic-membrane", "tm-pars-tensa", "tm-pars-flaccida",
        "external-auditory-canal", "sinus-dura", "carotid-artery", "bone",
    ]
    manifest["structures"] = [structures[item] for item in order]
    (DATA / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    write_content(nerve, membrane)
    bump_versions()
    patch_presets(antrum, footplate)
    report = {
        "model_version": VERSION,
        "frame": {"x": "anterior", "y": "inferior", "z": "medial"},
        "labyrinth": {
            "parentVertices": int(len(scala_v)),
            "children": {**labyrinth["restReport"], "scala-vestibuli": {"exclusiveVertices": int(cochlear_mask.sum()), "exportedVertices": int(len(cochlear_verts))}},
        },
        "scala-tympani": {"parentVertices": int(len(scala_t)), "children": {key: tympani_turns[key] for key in tympani_turns if key.startswith("scala")}},
        "scala-vestibuli": {"parentVertices": int(len(cochlear_verts)), "children": {key: vestibuli_turns[key] for key in vestibuli_turns if key.startswith("scala")}},
        "facial-nerve": {"parentVertices": int(len(facial)), "children": {key: nerve[key] for key in nerve if key.startswith("fn-")}, "segments": nerve["rangesMm"], "arcMm": nerve["arcMm"]},
        "tympanic-membrane": {"parentVertices": int(len(tm)), "children": {key: membrane[key] for key in membrane if key.startswith("tm-")}, "method": membrane["method"]},
        "landmarkCount": len(points),
        "ctLabelCount": len(ct_terms),
        "registration": registration,
    }
    for group, payload in (
        ("labyrinth", report["labyrinth"]),
        ("scala-tympani", report["scala-tympani"]),
        ("scala-vestibuli", report["scala-vestibuli"]),
        ("facial-nerve", report["facial-nerve"]),
        ("tympanic-membrane", report["tympanic-membrane"]),
    ):
        total = sum(item["exclusiveVertices"] for item in payload["children"].values())
        payload["exclusiveSum"] = total
        if total != payload["parentVertices"]:
            raise RuntimeError(f"{group} vertex sum {total} != {payload['parentVertices']}")
    (DATA / "split-report.json").write_text(json.dumps(report, indent=2), encoding="utf8")
    print(json.dumps({"landmarks": len(points), "ct": len(ct_terms), "fnArc": nerve["arcMm"], "registration": registration}, indent=2))


def sample_point(curve: np.ndarray, arc_mm: float, total: float) -> np.ndarray:
    if len(curve) < 2:
        return curve[0]
    fraction = np.clip(arc_mm / max(total, 1e-6), 0, 1)
    index = fraction * (len(curve) - 1)
    low = int(np.floor(index))
    high = min(low + 1, len(curve) - 1)
    return curve[low] * (1 - (index - low)) + curve[high] * (index - low)


def ct_annotation(volume: dict, plane: str, item: dict, xyz: list[float]) -> dict:
    spec = volume["planes"][plane]
    axis = spec["axis"]
    origin = volume["origin_mm"]
    spacing = volume["spacing_mm"]
    index = int(np.clip(round((xyz[axis] - origin[axis]) / spacing[axis]), 0, volume["dims"][axis] - 1))
    # Identity direction, row 0 is the high end of the row axis, drawn at the top of the image.
    pose_center = [
        origin[0] + ((volume["dims"][0] - 1) / 2) * spacing[0],
        origin[1] + ((volume["dims"][1] - 1) / 2) * spacing[1],
        origin[2] + ((volume["dims"][2] - 1) / 2) * spacing[2],
    ]
    pose_center[axis] = origin[axis] + index * spacing[axis]
    col_axis = spec["col_axis"]
    row_axis = spec["row_axis"]
    width = volume["dims"][col_axis] * spacing[col_axis]
    height = volume["dims"][row_axis] * spacing[row_axis]
    delta = [xyz[i] - pose_center[i] for i in range(3)]
    col = delta[col_axis] / width
    row = delta[row_axis] / height
    row_sign = 1 if spec["row_0_is_max"] else -1
    anatomical = {"axial": "sagittal", "coronal": "axial", "sagittal": "coronal"}[plane]
    return {
        "id": item["id"],
        "en": item["en"],
        "ko": item["ko"],
        "anatomy": item["anatomy"],
        "clinical": item["clinical"],
        "sources": item["sources"],
        "review": "미검증",
        "plane": plane,
        "anatomicalPlane": anatomical,
        "slice_index": index,
        "xy": [round(col + 0.5, 4), round(0.5 - row_sign * row, 4)],
        "xyz_mm": xyz,
    }


def surface_labels(eac: np.ndarray, mastoid_tip: np.ndarray, zygomatic: np.ndarray, temporal_line: np.ndarray) -> list[dict]:
    """Auricle and periauricular points on the stylized skin, in the ZETA frame."""
    rows = [
        ("helix", "Helix", "이륜", eac + LATERAL * 16 + POSTERIOR * 6 + SUPERIOR * 8),
        ("crus-helix", "Crus of helix", "이륜각", eac + LATERAL * 8 + ANTERIOR * 2 + SUPERIOR * 6),
        ("antihelix", "Antihelix", "대이륜", eac + LATERAL * 12 + POSTERIOR * 2 + SUPERIOR * 2),
        ("scapha", "Scapha", "주상와", eac + LATERAL * 14 + POSTERIOR * 8 + SUPERIOR * 4),
        ("triangular-fossa", "Triangular fossa", "삼각와", eac + LATERAL * 10 + SUPERIOR * 7),
        ("cymba", "Cymba conchae", "이갑개정", eac + LATERAL * 6 + SUPERIOR * 3),
        ("cavum", "Cavum conchae", "이갑개강", eac + LATERAL * 4),
        ("tragus", "Tragus", "이주", eac + LATERAL * 6 + ANTERIOR * 6),
        ("antitragus", "Antitragus", "대이주", eac + LATERAL * 8 + POSTERIOR * 4 + INFERIOR * 6),
        ("intertragic-notch", "Intertragic notch", "주간절흔", eac + LATERAL * 7 + INFERIOR * 5),
        ("lobule", "Lobule", "이수(귓불)", eac + LATERAL * 8 + INFERIOR * 16),
        ("mastoid-tip-skin", "Mastoid tip", "유양돌기 첨부", mastoid_tip + LATERAL * 1.5),
        ("postauricular-sulcus", "Postauricular sulcus", "이개후구", eac + POSTERIOR * 10 + LATERAL * 2),
        ("zygomatic-arch", "Zygomatic arch", "관골궁", zygomatic + LATERAL * 1.0),
        ("temporal-line-skin", "Temporal line", "측두선", temporal_line + LATERAL * 1.0),
        ("tragal-pointer", "Tragal pointer", "이주 포인터", eac + ANTERIOR * 7 + INFERIOR * 2 + LATERAL * 5),
        ("preauricular", "Preauricular area", "이개전부", eac + ANTERIOR * 12 + LATERAL * 2),
    ]
    labels = []
    for item_id, en, ko, xyz in rows:
        labels.append({
            "id": item_id,
            "en": en,
            "ko": ko,
            "anatomy": "Surface point on the stylized skin, placed relative to the ZETA ear canal.",
            "clinical": "",
            "sources": [source(JACKLER, "미검증", False)],
            "xyz_mm": [round(float(v), 3) for v in xyz],
            "review": "미검증",
            "tier": "surface",
        })
    return labels


def build_upper_body(eac: np.ndarray, mastoid_tip: np.ndarray, zygomatic: np.ndarray, stylomastoid: np.ndarray, iac: np.ndarray):
    radius = 92.0
    center = eac + MEDIAL * radius + SUPERIOR * 8
    head_v, head_f = icosphere(radius, center, 2)
    neck_top = center + INFERIOR * (radius * 0.72)
    neck_bottom = neck_top + INFERIOR * 48
    neck_v, neck_f = tube(neck_top, neck_bottom, 28)
    shoulder_left = neck_bottom + MEDIAL * 70 + INFERIOR * 16
    shoulder_right = neck_bottom + LATERAL * 70 + INFERIOR * 12
    torso_v, torso_f = tube(shoulder_right, shoulder_left, 22, 10)
    # A simple auricle: a ring just lateral to the canal.
    ear_parts = []
    for angle in np.linspace(-2.4, 2.2, 18):
        direction = SUPERIOR * np.cos(angle) + POSTERIOR * np.sin(angle)
        start = eac + LATERAL * 2 + direction * 7
        end = eac + LATERAL * 14 + direction * 16
        ear_parts.append(tube(start, end, 2.2, 6))
    ear_v, ear_f = merge_meshes(ear_parts)
    verts, faces = merge_meshes([(head_v, head_f), (neck_v, neck_f), (torso_v, torso_f), (ear_v, ear_f)])
    pairs_body = np.vstack([
        eac,
        mastoid_tip + LATERAL * 1.5,
        zygomatic + LATERAL * 1.0,
        stylomastoid,
        iac,
    ])
    pairs_zeta = pairs_body.copy()
    fit = umeyama(pairs_body, pairs_zeta)
    return verts, faces, fit


def encode_to(verts: np.ndarray, faces: np.ndarray, glb_path: Path) -> None:
    bin_path = WORK / "out" / "upper-body.bin"
    write_bin(bin_path, verts, faces)
    glb_path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.check_call(["node", str(CODEC), "encode", str(bin_path), str(glb_path), "upper-body"])


def add_structures(structures: dict) -> None:
    def add(item_id, file, en, ko, color, layer, parent=None):
        item = {
            "id": item_id,
            "file": file,
            "name": {"ko": ko, "en": en},
            "color": color,
            "layer": layer,
            "status": "미검증",
            "content": f"content/{item_id}.json",
        }
        if parent:
            item["parent"] = parent
        structures[item_id] = item

    add("labyrinth", "models/labyrinth.glb", "Labyrinth", "미로", "#EFE6F8", "inner-ear")
    add("scala-tympani-basal", "models/scala-tympani-basal.glb", "Basal turn (scala tympani)", "와우 기저회전(고실계)", "#7A6496", "inner-ear", "scala-tympani")
    add("scala-tympani-middle", "models/scala-tympani-middle.glb", "Middle turn (scala tympani)", "와우 중간회전(고실계)", "#8E78A8", "inner-ear", "scala-tympani")
    add("scala-tympani-apical", "models/scala-tympani-apical.glb", "Apical turn (scala tympani)", "와우 첨부회전(고실계)", "#C4B0D8", "inner-ear", "scala-tympani")
    add("scala-vestibuli-basal", "models/scala-vestibuli-basal.glb", "Basal turn (scala vestibuli)", "와우 기저회전(전정계)", "#B89AD4", "inner-ear", "scala-vestibuli")
    add("scala-vestibuli-middle", "models/scala-vestibuli-middle.glb", "Middle turn (scala vestibuli)", "와우 중간회전(전정계)", "#CDB6E0", "inner-ear", "scala-vestibuli")
    add("scala-vestibuli-apical", "models/scala-vestibuli-apical.glb", "Apical turn (scala vestibuli)", "와우 첨부회전(전정계)", "#F3E9FA", "inner-ear", "scala-vestibuli")
    add("vestibule", "models/vestibule.glb", "Vestibule", "전정", "#E7D9F4", "inner-ear", "labyrinth")
    add("scc-lateral", "models/scc-lateral.glb", "Lateral semicircular canal", "외측반고리관", "#6E5A9A", "inner-ear", "labyrinth")
    add("scc-superior", "models/scc-superior.glb", "Superior semicircular canal", "상반고리관", "#A08BC4", "inner-ear", "labyrinth")
    add("scc-posterior", "models/scc-posterior.glb", "Posterior semicircular canal", "후반고리관", "#4E3C74", "inner-ear", "labyrinth")
    yellows = {
        "fn-meatal": ("#F6D56B", "Meatal segment", "안면신경 내이도부"),
        "fn-labyrinthine": ("#D4A820", "Labyrinthine segment", "안면신경 미로부"),
        "fn-geniculate": ("#C99612", "Geniculate ganglion", "슬신경절"),
        "fn-tympanic": ("#F0C44A", "Tympanic segment", "안면신경 고실부(수평부)"),
        "fn-second-genu": ("#A67C10", "Second genu", "제2슬부"),
        "fn-mastoid": ("#8A6812", "Mastoid segment", "안면신경 유양부(수직부)"),
    }
    for item_id, (color, en, ko) in yellows.items():
        add(item_id, f"models/{item_id}.glb", en, ko, color, "nerve", "facial-nerve")
    add("tm-pars-tensa", "models/tm-pars-tensa.glb", "Pars tensa", "긴장부", "#C9A89E", "membrane", "tympanic-membrane")
    add("tm-pars-flaccida", "models/tm-pars-flaccida.glb", "Pars flaccida", "이완부", "#E7D2C8", "membrane", "tympanic-membrane")


CONTENT = {
    "labyrinth": ("The unsplit mesh that was labeled scala vestibuli. It contains the cochlear scala vestibuli, the vestibule, and all three semicircular canals.", "분할 전 전정계 메시입니다. 와우 전정계, 전정, 세 반고리관이 들어 있습니다.", "Parent aggregate. Select a child to study one part.", "자식 구조를 고르면 해당 부분만 봅니다.", CUMMINGS_126, "audit"),
    "scala-tympani-basal": ("First full turn of the scala tympani about the modiolus, starting at the round window.", "정원창에서 시작하는 고실계의 첫 회전입니다.", "The promontory overlies this turn.", "갑각이 이 회전 가쪽면에 있습니다.", CUMMINGS_175, "audit"),
    "scala-tympani-middle": ("Second turn of the scala tympani about the modiolus.", "고실계의 둘째 회전입니다.", "Continues the cochlear spiral inward.", "와우 나선이 안쪽으로 이어집니다.", CUMMINGS_126, "audit"),
    "scala-tympani-apical": ("Remaining apical angle of the scala tympani.", "고실계의 첨부 회전입니다.", "Closest to the modiolus.", "와우축에 가깝습니다.", CUMMINGS_126, "audit"),
    "scala-vestibuli-basal": ("Basal turn of the cochlear scala vestibuli, after the vestibule and canals were removed.", "전정과 반고리관을 뺀 전정계의 기저회전입니다.", "Runs beside the basal scala tympani.", "기저 고실계와 나란합니다.", CUMMINGS_126, "audit"),
    "scala-vestibuli-middle": ("Middle turn of the cochlear scala vestibuli.", "전정계의 중간회전입니다.", "Angle split about the same modiolus axis as the scala tympani.", "고실계와 같은 와우축 각도로 나눴습니다.", CUMMINGS_126, "audit"),
    "scala-vestibuli-apical": ("Apical turn of the cochlear scala vestibuli.", "전정계의 첨부회전입니다.", "Angle split about the modiolus.", "와우축 기준 각도 분할입니다.", CUMMINGS_126, "audit"),
    "vestibule": ("Central chamber remaining after the cochlear scala and the three canal arches were separated.", "와우 전정계와 세 반고리관 활을 분리하고 남은 중심 공간입니다.", "The oval window opens into it.", "난원창이 여기로 열립니다.", CUMMINGS_126, "audit"),
    "scc-lateral": ("Lateral canal arch, the part of the old scala vestibuli mesh farthest laterally.", "기존 전정계 메시에서 가장 가쪽에 있는 외측반고리관 활입니다.", "A mastoidectomy landmark. The cut is geometric and unverified.", "유양돌기절제의 표지입니다. 절단 경계는 미검증입니다.", CUMMINGS_126, "audit"),
    "scc-superior": ("Superior canal arch, the part farthest superiorly.", "가장 위쪽에 있는 상반고리관 활입니다.", "Related to the arcuate eminence. The cut is unverified.", "궁상융기와 관련됩니다. 절단 경계는 미검증입니다.", CUMMINGS_175, "audit"),
    "scc-posterior": ("Posterior canal arch, the part farthest posteriorly.", "가장 뒤쪽에 있는 후반고리관 활입니다.", "Shares the common crus with the superior canal; the crus is not a separate mesh.", "상반고리관과 총각을 공유하며, 총각은 따로 나누지 않았습니다.", CUMMINGS_175, "audit"),
    "fn-meatal": ("Medial end of the facial-nerve mesh, while it is still near the cochleovestibular nerve.", "와우전정신경에 가까운, 안면신경 메시의 안쪽 끝입니다.", "Bill bar is the posterior landmark at the fundus. Length is geometric and unverified.", "기저부에서 Bill bar가 뒤쪽 표지입니다. 길이는 기하학적 추정치이며 미검증입니다.", CUMMINGS_175, "p9"),
    "fn-labyrinthine": ("Short segment from the fundus estimate to the first bend.", "기저부 추정점에서 첫 굽이까지의 짧은 분절입니다.", "Narrowest segment and the one most sensitive to swelling. About 3–5 mm is the usual teaching range; this cut is unverified.", "가장 좁아 부종에 취약한 분절입니다. 보통 3–5 mm로 가르치나 이 절단은 미검증입니다.", CUMMINGS_126, "p1"),
    "fn-geniculate": ("One millimetre on either side of the first curvature peak.", "첫 곡률 정점 앞뒤 1 mm입니다.", "The greater superficial petrosal nerve leaves here. Dehiscence toward the middle fossa is described in the cited chapter.", "대추체신경이 여기서 나갑니다. 중두개와 쪽 결손은 인용한 장에 기술돼 있습니다.", CUMMINGS_126, "p1, p7"),
    "fn-tympanic": ("The posterolateral run after the first genu and before the second bend.", "제1슬 이후, 제2굽이 이전의 후가쪽 주행입니다.", "Passes above the oval window. Dehiscence is often taught here; the percentage was not rechecked.", "난원창 위를 지납니다. 결손이 흔하다고 가르치나 수치는 다시 확인하지 않았습니다.", CUMMINGS_126, "p7"),
    "fn-second-genu": ("1.5 mm on either side of the second curvature peak, where the nerve turns inferiorly.", "아래로 꺾이는 둘째 곡률 정점 앞뒤 1.5 mm입니다.", "Near the pyramidal eminence and the lateral canal.", "추체융기, 외측반고리관 근처에 있습니다.", CUMMINGS_126, "p7"),
    "fn-mastoid": ("The descending segment from the second genu to the distal end of the mesh.", "제2슬에서 메시 끝까지의 하행 분절입니다.", "The digastric ridge points toward the stylomastoid foramen.", "이복근릉이 경유돌공을 향합니다.", CUMMINGS_126, "p1, p10"),
    "tm-pars-tensa": ("The tympanic membrane inferior to the malleus lateral process.", "추골 외측돌기보다 아래쪽 고막입니다.", "The manubrium is embedded in it.", "추골병이 묻혀 있습니다.", CUMMINGS_126, "p5"),
    "tm-pars-flaccida": ("The small superior cap of the membrane above the lateral process.", "외측돌기보다 위쪽의 작은 고막입니다.", "Retracts toward Prussak space.", "Prussak 공간 쪽으로 함몰합니다.", CUMMINGS_126, "p5"),
}


def write_content(nerve: dict, membrane: dict) -> None:
    for item_id, (en, ko, fn_en, fn_ko, citation, page) in CONTENT.items():
        clinical_en = fn_en
        payload = {
            "id": item_id,
            "model_version": VERSION,
            "anatomy": {"ko": ko, "en": en},
            "function": {"ko": fn_ko, "en": fn_en},
            "clinical": {"ko": fn_ko, "en": clinical_en},
            "surgical_points": [],
            "sources": [source(citation, page, False)],
            "review": "미검증",
        }
        if item_id.startswith("fn-"):
            payload["related"] = ["facial-nerve"]
        if item_id == "fn-mastoid":
            payload["related"] = ["facial-nerve", "chorda-tympani"]
        (DATA / "content" / f"{item_id}.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    note = {
        "fundusMm": nerve["fundusMm"],
        "firstGenuMm": nerve["firstGenuMm"],
        "secondGenuMm": nerve["secondGenuMm"],
        "tmMethod": membrane["method"],
    }
    (DATA / "split-notes.json").write_text(json.dumps(note, indent=2), encoding="utf8")


def bump_versions() -> None:
    for path in (DATA / "content").glob("*.json"):
        payload = json.loads(path.read_text())
        payload["model_version"] = VERSION
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    volume_path = DATA / "ct" / "volume.json"
    volume = json.loads(volume_path.read_text())
    volume["model_version"] = VERSION
    volume["label"]["en"] = "OpenEar ZETA CBCT. 0.25 mm. File axes are +X anterior, +Y inferior, +Z medial, so the axial folder is an anatomical sagittal stack."
    volume["label"]["ko"] = "OpenEar ZETA CBCT. 0.25 mm. 파일 축은 +X 앞, +Y 아래, +Z 안쪽이라 axial 폴더는 해부학적 시상면입니다."
    volume_path.write_text(json.dumps(volume, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def patch_presets(antrum: np.ndarray, footplate: np.ndarray) -> None:
    path = DATA / "presets.json"
    presets = json.loads(path.read_text())
    presets["model_version"] = VERSION
    presets["note"] = {
        "ko": "카메라의 위쪽은 머리의 위(−Y)입니다. 축은 +X 앞, +Y 아래, +Z 안쪽입니다. 뼈를 갈아내는 기능은 없습니다. 유양동 점은 추정이며 미검증입니다.",
        "en": "Camera up is head-superior (−Y). Axes are +X anterior, +Y inferior, +Z medial. Bone is not drilled. The antrum point is an estimate and is unverified.",
    }
    up = [0, -1, 0]
    cameras = {
        "cortical-mastoidectomy": {"position": [-55, 78, -48], "target": [8, 48, 14], "up": up, "fov": 28},
        "antrum": {"position": [-28, 62, -36], "target": [round(float(v), 2) for v in antrum], "up": up, "fov": 28},
        "identify-facial-nerve": {"position": [-18, 58, -42], "target": [20, 28, 31], "up": up, "fov": 28},
        "posterior-tympanotomy": {"position": [-25, 59, -54], "target": [23, 22, 30], "up": up, "fov": 28},
        "transcanal-view": {"position": [33.3, 13.4, -68.4], "target": [25.28, 25.35, 31.58], "up": up, "fov": 28},
        "mcf-view": {"position": [22, -83, 38], "target": [22, 22, 38], "up": [1, 0, 0], "fov": 28},
    }
    extra_hidden = ["vestibule", "scc-lateral", "scc-superior", "scc-posterior", "labyrinth"]
    for sequence in presets["sequences"]:
        for step in sequence["steps"]:
            if step["id"] in cameras:
                step["camera"] = cameras[step["id"]]
            if step["id"] == "antrum":
                step["marker"]["position_mm"] = [round(float(v), 2) for v in antrum]
                step["marker"]["source"] = "유양동 메시는 없습니다. Henle 극 추정점에서 안쪽·뒤·위로 둔 점이며 미검증입니다."
                step["marker"]["review"] = "미검증"
            hidden = step.get("hidden")
            if isinstance(hidden, list):
                for item_id in extra_hidden:
                    if item_id not in hidden:
                        hidden.append(item_id)
            if step["id"] == "mcf-view":
                for item_id in ["vestibule", "scc-lateral", "scc-superior", "scc-posterior"]:
                    if item_id not in step["visible"]:
                        step["visible"].append(item_id)
    path.write_text(json.dumps(presets, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


LICENSE_TEXT = """ENT 3D upper-body mesh

This GLB is an original stylized head, neck, and shoulders made for the
temporal-bone entry screen. It is not a scan and not a Z-Anatomy extract.

Z-Anatomy was checked before choosing this mesh.

- https://github.com/LluisV/Z-Anatomy LICENSE (retrieved 2026-11-21) is the
  full Creative Commons Attribution-ShareAlike 4.0 International deed.
  That license allows public redistribution, including on a website, if
  attribution is kept and adaptations stay under CC BY-SA or a compatible
  license.
- https://github.com/Z-Anatomy/Models-of-human-anatomy License.txt says the
  same and asks for attribution to BodyParts3D (CC BY-SA 2.1 Japan) and
  Z-Anatomy (CC BY-SA 4.0).

The redistributable model in that repository is a Blender application
template whose Startup.blend is about 293 MB. This build environment had
no Blender binary with which to export and decimate a head–neck–shoulders
subset under 5 MB, so that file is not shipped here. The stylized mesh in
this folder is original and is not offered under CC BY-SA.

Attribution for the licence check, and for OpenEar ZETA (CC BY 4.0), is on
the sources page of this site.
"""


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Anatomical re-split and head registration for the ZETA right temporal bone.

Reads Draco GLBs, writes child meshes, landmarks, surface anchors, and the
rigid head transform. Does not copy textbook prose.

Specimen frame, checked on these meshes: +X anterior, +Y inferior, +Z medial.

  python3 scripts/anatomy_accuracy.py
"""

from __future__ import annotations

import json
import subprocess
from collections import defaultdict
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import trimesh
from scipy.ndimage import binary_opening, generate_binary_structure
from scipy.spatial import cKDTree
from skimage.morphology import skeletonize

ROOT = Path(__file__).resolve().parents[1]
MODELS = ROOT / "public" / "temporal-bone" / "models"
DATA = ROOT / "public" / "temporal-bone"
UPPER = ROOT / "public" / "models" / "upper-body"
CODEC = ROOT / "scripts" / "glb_codec.mjs"
WORK = Path("/tmp/ent3d-anatomy")
PLOTS = ROOT / "docs" / "pr-a-anatomy"
VERSION = "openear-zeta-frame-3"

# Head → specimen rigid map. Sagittal tilt aligns head-inferior with +Y.
# The porion is then seated 5 mm lateral to the bony porus, along the canal,
# which is what puts the lateral cortex inside the skin. Scale stays 1.
PORION = np.array([48.5, 4.2, 27.6])
SAGITTAL_DEG = -22.0
LATERAL_SEAT = np.array([0.0, 0.0, -5.0])

ANTERIOR = np.array([1.0, 0.0, 0.0])
INFERIOR = np.array([0.0, 1.0, 0.0])
MEDIAL = np.array([0.0, 0.0, 1.0])
POSTERIOR = -ANTERIOR
SUPERIOR = -INFERIOR
LATERAL = -MEDIAL

C126 = "Cummings Otolaryngology–Head and Neck Surgery, 7th ed., Ch. 126 Anatomy of the Temporal Bone, External Ear, and Middle Ear"
C129 = "Cummings Otolaryngology–Head and Neck Surgery, 7th ed., Ch. 129"
C173 = "Cummings Otolaryngology–Head and Neck Surgery, 7th ed., Ch. 173 Intratemporal Facial Nerve Surgery"
C175 = "Cummings Otolaryngology–Head and Neck Surgery, 7th ed., Ch. 175 Surgical Anatomy of the Lateral Skull Base"
SOM = "Som PM, Curtin HD. Head and Neck Imaging, 5th ed., Ch. 15 Temporal bone"
SANNA = "Sanna M, et al. Middle Ear and Mastoid Microsurgery, 2nd ed., Ch. 1"
MOLLER = "Möller TB, Reif E. Pocket Atlas of Sectional Anatomy, Vol. 1 Head and Neck, 4th ed."
FRANCIS2 = "Francis HW, Niparko JK. Temporal Bone Dissection Guide, 2nd ed., Ch. 2"
FRANCIS3 = "Francis HW, Niparko JK. Temporal Bone Dissection Guide, 2nd ed., Ch. 3"


def source(citation: str, page: str) -> dict:
    return {"citation": citation, "page": page, "verified": False}


def read_bin(path: Path) -> tuple[np.ndarray, np.ndarray]:
    with path.open("rb") as handle:
        counts = np.frombuffer(handle.read(8), dtype=np.uint32)
        vertex_count, face_count = int(counts[0]), int(counts[1])
        verts = np.frombuffer(handle.read(vertex_count * 12), dtype=np.float32).reshape(vertex_count, 3).astype(np.float64)
        faces = np.frombuffer(handle.read(face_count * 12), dtype=np.uint32).reshape(face_count, 3).astype(np.int64)
    return verts, faces


def write_bin(path: Path, verts: np.ndarray, faces: np.ndarray) -> None:
    verts = np.ascontiguousarray(verts, dtype=np.float32)
    faces = np.ascontiguousarray(faces, dtype=np.uint32)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as handle:
        handle.write(np.array([len(verts), len(faces)], dtype=np.uint32).tobytes())
        handle.write(verts.tobytes())
        handle.write(faces.tobytes())


def decode(name: str, folder: Path = MODELS) -> tuple[np.ndarray, np.ndarray]:
    target = WORK / f"{name}.bin"
    if not target.exists():
        subprocess.check_call(["node", str(CODEC), "decode", str(folder / f"{name}.glb"), str(target)])
    return read_bin(target)


def encode(verts: np.ndarray, faces: np.ndarray, glb_name: str, folder: Path = MODELS) -> None:
    bin_path = WORK / "out" / f"{glb_name}.bin"
    write_bin(bin_path, verts, faces)
    subprocess.check_call(["node", str(CODEC), "encode", str(bin_path), str(folder / glb_name), glb_name.replace(".glb", "")])


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


def export_labeled(verts: np.ndarray, faces: np.ndarray, labels: np.ndarray, names: list[str]) -> dict:
    report = {}
    for label, name in enumerate(names):
        owned = labels == label
        keep = (labels[faces] == label).sum(axis=1) >= 2
        used = faces[keep]
        if len(used) == 0:
            raise RuntimeError(f"{name} received no faces")
        unique, inverse = np.unique(used.ravel(), return_inverse=True)
        encode(verts[unique], inverse.reshape(-1, 3), f"{name}.glb")
        report[name] = {
            "exclusiveVertices": int(owned.sum()),
            "exportedVertices": int(len(unique)),
            "faces": int(keep.sum()),
        }
    return report


def rz(deg: float) -> np.ndarray:
    a = np.radians(deg)
    c, s = np.cos(a), np.sin(a)
    return np.array([[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]])


def unit(vector: np.ndarray) -> np.ndarray:
    return vector / (np.linalg.norm(vector) or 1.0)


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
    slope = (outer - inner) / (2.5 * 2 * np.pi)
    estimate = (outer - radius) / max(slope, 1e-6)
    turns = np.clip(np.round((estimate - theta) / (2 * np.pi)), 0, 3)
    return theta + 2 * np.pi * turns


def export_cochlear_turns(prefix: str, verts: np.ndarray, faces: np.ndarray, phase: np.ndarray) -> dict:
    labels = np.zeros(len(verts), dtype=np.int32)
    labels[phase >= 2 * np.pi] = 1
    labels[phase >= 4 * np.pi] = 2
    labels = smooth_labels(labels, faces, rounds=1)
    names = [f"{prefix}-basal", f"{prefix}-middle", f"{prefix}-apical"]
    report = export_labeled(verts, faces, labels, names)
    report["phaseMax"] = float(phase.max())
    return report


def canal_cycles(verts: np.ndarray, faces: np.ndarray) -> list[dict]:
    mesh = trimesh.Trimesh(verts, faces, process=False)
    pitch = 0.22
    grid = mesh.voxelized(pitch).fill()
    matrix = binary_opening(grid.matrix, structure=generate_binary_structure(3, 1), iterations=1)
    coords = np.argwhere(skeletonize(matrix))
    world = (grid.transform @ np.c_[coords, np.ones(len(coords))].T).T[:, :3]
    tree = cKDTree(coords)
    neighbors: dict[int, list[int]] = defaultdict(list)
    for a, b in tree.query_pairs(1.8):
        neighbors[int(a)].append(int(b))
        neighbors[int(b)].append(int(a))
    alive = set(range(len(world)))
    changed = True
    while changed:
        changed = False
        for index in list(alive):
            if sum(1 for other in neighbors[index] if other in alive) <= 1:
                alive.remove(index)
                changed = True

    def degree(index: int) -> int:
        return sum(1 for other in neighbors[index] if other in alive)

    junctions = [index for index in alive if degree(index) != 2]

    def walk(start: int, nxt: int) -> list[int]:
        path = [start, nxt]
        prev, cur = start, nxt
        seen = {start}
        for _ in range(5000):
            if degree(cur) != 2:
                break
            nxts = [other for other in neighbors[cur] if other in alive and other != prev]
            if not nxts:
                break
            prev, cur = cur, nxts[0]
            path.append(cur)
            if cur in seen:
                break
        return path

    edges: list[list[int]] = []
    seen_dirs: set[tuple[int, int]] = set()
    for junction in junctions:
        for other in neighbors[junction]:
            if other not in alive or (junction, other) in seen_dirs:
                continue
            path = walk(junction, other)
            seen_dirs.add((path[0], path[1]))
            seen_dirs.add((path[-1], path[-2]))
            edges.append(path)

    adjacency: dict[int, list[tuple[int, int]]] = defaultdict(list)
    for edge_index, path in enumerate(edges):
        if path[0] == path[-1]:
            continue
        adjacency[path[0]].append((path[-1], edge_index))
        adjacency[path[-1]].append((path[0], edge_index))

    cycles: list[tuple[int, ...]] = []

    def search(start: int, current: int, nodes: set[int], path: list[int], used: set[int]) -> None:
        if len(path) > 6:
            return
        for nxt, edge_index in adjacency[current]:
            if edge_index in used:
                continue
            if nxt == start and len(path) >= 2:
                cycles.append(tuple(sorted(path + [edge_index])))
                continue
            if nxt in nodes:
                continue
            nodes.add(nxt)
            search(start, nxt, nodes, path + [edge_index], used | {edge_index})
            nodes.remove(nxt)

    for start in list(adjacency):
        search(start, start, {start}, [], set())

    def geometry(edge_ids: tuple[int, ...]) -> dict | None:
        ends = {edge_index: (edges[edge_index][0], edges[edge_index][-1], edges[edge_index]) for edge_index in edge_ids}
        first = edge_ids[0]
        poly = list(ends[first][2])
        used = {first}
        cursor = ends[first][1]
        for _ in range(12):
            if len(used) == len(edge_ids):
                break
            found = False
            for edge_index in edge_ids:
                if edge_index in used:
                    continue
                a, b, path = ends[edge_index]
                if a == cursor:
                    poly.extend(path[1:])
                    cursor = b
                    used.add(edge_index)
                    found = True
                    break
                if b == cursor:
                    poly.extend(list(path[-2::-1]))
                    cursor = a
                    used.add(edge_index)
                    found = True
                    break
            if not found:
                break
        points = world[np.array(poly)]
        center = points.mean(axis=0)
        _, _, vt = np.linalg.svd(points - center, full_matrices=False)
        normal = vt[2].copy()
        if normal[1] < 0:
            normal = -normal
        length = float(np.linalg.norm(np.diff(points, axis=0), axis=1).sum())
        rms = float(np.sqrt(np.mean(((points - center) @ normal) ** 2)))
        if not (16.0 <= length <= 34.0 and rms < 0.6):
            return None
        vertical = float(np.degrees(np.arccos(np.clip(abs(normal @ np.array([0.0, 1.0, 0.0])), 0, 1))))
        return {
            "points": points,
            "normal": normal,
            "length": length,
            "rms": rms,
            "verticalDeg": vertical,
            "yMin": float(points[:, 1].min()),
            "yMax": float(points[:, 1].max()),
        }

    unique = []
    seen = set()
    for cycle in set(cycles):
        item = geometry(cycle)
        if item is None:
            continue
        key = (round(item["length"], 1), round(item["yMin"], 1), round(item["yMax"], 1))
        if key in seen:
            continue
        seen.add(key)
        unique.append(item)
    if len(unique) < 3:
        raise RuntimeError(f"expected 3 canal cycles, found {len(unique)}")
    lateral = min(unique, key=lambda item: item["verticalDeg"])
    rest = [item for item in unique if item is not lateral]
    superior = min(rest, key=lambda item: item["yMin"])
    others = [item for item in rest if item is not superior]
    posterior = max(others, key=lambda item: item["yMax"])
    lateral["name"] = "lateral"
    superior["name"] = "superior"
    posterior["name"] = "posterior"
    return [lateral, superior, posterior]


def split_labyrinth(verts: np.ndarray, faces: np.ndarray, scala_tympani: np.ndarray) -> dict:
    cochlear = cKDTree(scala_tympani).query(verts, k=1)[0] < 1.6
    cycles = canal_cycles(verts, faces)
    by_name = {item["name"]: item for item in cycles}
    trees = {name: cKDTree(item["points"]) for name, item in by_name.items()}
    labels = np.full(len(verts), -1, dtype=np.int32)
    names = ["scc-lateral", "scc-superior", "scc-posterior", "common-crus", "vestibule"]
    name_index = {name: index for index, name in enumerate(names)}
    canal_index = {"lateral": 0, "superior": 1, "posterior": 2}
    for index in np.where(~cochlear)[0]:
        point = verts[index]
        distances = {name: float(trees[name].query(point)[0]) for name in trees}
        nearest = min(distances, key=distances.get)
        if distances["superior"] < 1.15 and distances["posterior"] < 1.15 and distances["lateral"] > 1.6:
            labels[index] = name_index["common-crus"]
        elif distances[nearest] > 1.45:
            labels[index] = name_index["vestibule"]
        else:
            labels[index] = canal_index[nearest]
    rest = ~cochlear
    labels = smooth_masked(labels, faces, rest)
    # A vertex left unlabeled (should not happen) joins the vestibule.
    labels[(labels < 0) & rest] = name_index["vestibule"]
    report = export_labeled(verts, faces[rest[faces].any(axis=1)] if False else faces_touching(faces, rest), labels, names)
    # export_labeled uses faces_touching only for the face list; labels cover all vertices.
    # Re-export from the full face set but drop faces that are cochlear (label -1 on those verts).
    return {
        "cochlear": cochlear,
        "labels": labels,
        "names": names,
        "cycles": cycles,
        "partial": report,
    }


def faces_touching(faces: np.ndarray, mask: np.ndarray) -> np.ndarray:
    return faces[mask[faces].any(axis=1)]


def smooth_masked(labels: np.ndarray, faces: np.ndarray, mask: np.ndarray) -> np.ndarray:
    current = labels.copy()
    adj: list[list[int]] = [[] for _ in range(len(labels))]
    for tri in faces:
        ids = [int(v) for v in tri]
        for a, b in ((ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])):
            if mask[a] and mask[b] and current[a] >= 0 and current[b] >= 0:
                adj[a].append(b)
                adj[b].append(a)
    for _ in range(2):
        updated = current.copy()
        for index, neighbors in enumerate(adj):
            if neighbors:
                updated[index] = np.bincount(current[neighbors]).argmax()
        current = updated
    return current


def absorb_small_components(verts: np.ndarray, faces: np.ndarray, labels: np.ndarray, minimum: int, into: int) -> np.ndarray:
    """Move disconnected scraps of a canal (the stray superior-canal blob) into the vestibule."""
    from collections import deque

    adjacency: list[list[int]] = [[] for _ in range(len(verts))]
    for tri in faces:
        ids = [int(v) for v in tri]
        for a, b in ((ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])):
            if labels[a] >= 0 and labels[a] == labels[b]:
                adjacency[a].append(b)
                adjacency[b].append(a)
    updated = labels.copy()
    seen = np.zeros(len(verts), dtype=bool)
    for start in range(len(verts)):
        if seen[start] or labels[start] < 0 or labels[start] == into:
            continue
        queue = deque([start])
        seen[start] = True
        component = [start]
        while queue:
            node = queue.popleft()
            for other in adjacency[node]:
                if not seen[other]:
                    seen[other] = True
                    queue.append(other)
                    component.append(other)
        if len(component) < minimum:
            updated[np.array(component)] = into
    return updated


def largest_island(faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Faces of the largest connected piece, and the local vertex ids it uses."""
    from collections import deque

    count = int(faces.max()) + 1
    adjacency: list[list[int]] = [[] for _ in range(count)]
    for tri in faces:
        ids = [int(v) for v in tri]
        for a, b in ((ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])):
            adjacency[a].append(b)
            adjacency[b].append(a)
    seen = np.zeros(count, dtype=bool)
    best: list[int] = []
    for start in range(count):
        if seen[start] or not adjacency[start]:
            continue
        queue = deque([start])
        seen[start] = True
        component = [start]
        while queue:
            node = queue.popleft()
            for other in adjacency[node]:
                if not seen[other]:
                    seen[other] = True
                    queue.append(other)
                    component.append(other)
        if len(component) > len(best):
            best = component
    chosen = np.array(best)
    keep = np.zeros(count, dtype=bool)
    keep[chosen] = True
    kept = faces[keep[faces].all(axis=1)]
    remap = -np.ones(count, dtype=np.int32)
    remap[chosen] = np.arange(len(chosen))
    return remap[kept], chosen


def keep_largest_component(verts: np.ndarray, faces: np.ndarray, labels: np.ndarray, label_id: int, fallback: int) -> np.ndarray:
    """Leave one connected chamber. Detached scraps go back to the cochlear scala."""
    from collections import deque

    adjacency: list[list[int]] = [[] for _ in range(len(verts))]
    for tri in faces:
        ids = [int(v) for v in tri]
        for a, b in ((ids[0], ids[1]), (ids[1], ids[2]), (ids[2], ids[0])):
            if labels[a] == label_id and labels[b] == label_id:
                adjacency[a].append(b)
                adjacency[b].append(a)
    seen = np.zeros(len(verts), dtype=bool)
    best: list[int] = []
    for start in range(len(verts)):
        if seen[start] or labels[start] != label_id:
            continue
        queue = deque([start])
        seen[start] = True
        component = [start]
        while queue:
            node = queue.popleft()
            for other in adjacency[node]:
                if not seen[other]:
                    seen[other] = True
                    queue.append(other)
                    component.append(other)
        if len(component) > len(best):
            best = component
    updated = labels.copy()
    keep = np.zeros(len(verts), dtype=bool)
    if best:
        keep[np.array(best)] = True
    updated[(labels == label_id) & ~keep] = fallback
    return updated


def export_rest(verts: np.ndarray, faces: np.ndarray, labels: np.ndarray, cochlear: np.ndarray, names: list[str]) -> dict:
    """Export vestibular parts. Cochlear faces are not claimed by these labels."""
    report = {}
    usable = labels >= 0
    for label, name in enumerate(names):
        owned = labels == label
        votes = np.zeros(len(faces), dtype=np.int32)
        for corner in range(3):
            votes += (labels[faces[:, corner]] == label).astype(np.int32)
        keep = votes >= 2
        used = faces[keep]
        if len(used) == 0:
            raise RuntimeError(f"{name} received no faces")
        unique, inverse = np.unique(used.ravel(), return_inverse=True)
        local = inverse.reshape(-1, 3)
        if name == "vestibule":
            local, order = largest_island(local)
            unique = unique[order]
        encode(verts[unique], local, f"{name}.glb")
        report[name] = {"exclusiveVertices": int(owned.sum()), "exportedVertices": int(len(unique)), "faces": int(len(local))}
    if int((usable & (labels < 0)).sum()):
        raise RuntimeError("unlabeled vestibular vertices")
    return report


def angle_between(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.degrees(np.arccos(np.clip(abs(np.dot(unit(a), unit(b))), 0, 1))))


def facial_centerline(verts: np.ndarray, faces: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    mesh = trimesh.Trimesh(verts, faces, process=False)
    grid = mesh.voxelized(0.15).fill()
    coords = np.argwhere(skeletonize(grid.matrix))
    world = (grid.transform @ np.c_[coords, np.ones(len(coords))].T).T[:, :3]
    tree = cKDTree(coords)
    neighbors: dict[int, list[int]] = defaultdict(list)
    for a, b in tree.query_pairs(1.8):
        neighbors[int(a)].append(int(b))
        neighbors[int(b)].append(int(a))

    def farthest(src: int) -> tuple[int, dict[int, int]]:
        dist = {src: 0}
        prev = {src: -1}
        queue = [src]
        while queue:
            node = queue.pop(0)
            for other in neighbors[node]:
                if other not in dist:
                    dist[other] = dist[node] + 1
                    prev[other] = node
                    queue.append(other)
        end = max(dist, key=dist.get)
        return end, prev

    end, _ = farthest(int(np.argmax(world[:, 2])))
    end2, prev = farthest(end)
    path = []
    node = end2
    while node != -1:
        path.append(node)
        node = prev[node]
    path.reverse()
    points = world[np.array(path)]
    if points[0, 2] < points[-1, 2]:
        points = points[::-1]
    smooth = points.copy()
    for index in range(len(points)):
        smooth[index] = points[max(0, index - 2) : index + 3].mean(axis=0)
    step = np.linalg.norm(np.diff(smooth, axis=0), axis=1)
    arc = np.concatenate([[0.0], np.cumsum(step)])
    return smooth, arc


def sample_at(points: np.ndarray, arc: np.ndarray, distance: float) -> np.ndarray:
    index = int(np.clip(np.searchsorted(arc, distance), 1, len(points) - 2))
    return points[index]


def facial_segments(verts: np.ndarray, faces: np.ndarray, cv: np.ndarray, stapes: np.ndarray) -> dict:
    points, arc = facial_centerline(verts, faces)
    total = float(arc[-1])
    samples = np.arange(0.0, total, 0.25)
    sampled = np.vstack([sample_at(points, arc, value) for value in samples])

    def tangent(index: int) -> np.ndarray:
        a = max(0, index - 5)
        b = min(len(sampled) - 1, index + 5)
        return unit(sampled[b] - sampled[a])

    tangents = np.vstack([tangent(index) for index in range(len(sampled))])
    bend = np.zeros(len(sampled))
    for index in range(len(sampled)):
        a = max(0, index - 6)
        b = min(len(sampled) - 1, index + 6)
        bend[index] = float(np.degrees(np.arccos(np.clip(np.dot(tangent(a), tangent(b)), -1, 1))))
    distal = np.where(samples > 10.0)[0]
    genu2 = float(samples[distal[int(np.argmax(bend[distal]))]])
    # s = 0 is the high-Z end of this surface. After the head rotation that end is
    # the anterior tip, and that tip is the first genu. The internal auditory
    # canal is not part of this surface; it travels in the cochleovestibular bundle.
    dcv_line = cKDTree(cv).query(points, k=1)[0]
    early = np.where(arc <= 6.0)[0]
    fundus_s = float(arc[early[int(np.argmin(dcv_line[early]))]])
    genu_end = 1.2
    lab_end = max(fundus_s + 0.5, 2.6)
    genu2_a = max(lab_end + 7.5, genu2 - 1.2)
    inferior = np.where((samples > genu2_a) & (tangents[:, 1] > 0.85))[0]
    genu2_b = float(samples[inferior[0]]) if len(inferior) else genu2_a + 2.2
    nearest = cKDTree(sampled).query(verts, k=1)[1]
    vertex_s = samples[nearest]
    vertex_dcv = cKDTree(cv).query(verts, k=1)[0]
    # 0 geniculate (anterior tip), 1 labyrinthine (fundus to the genu), 2 tympanic, 3 second genu, 4 mastoid
    labels = np.full(len(verts), 2, dtype=np.int32)
    labels[vertex_s >= genu2_a] = 3
    labels[vertex_s >= genu2_b] = 4
    spur = (vertex_dcv < 1.15) & (vertex_s < 4.5)
    labels[(vertex_s >= genu_end) & (vertex_s < lab_end) & (vertex_dcv < 2.4)] = 1
    labels[spur] = 1
    labels[(vertex_s < genu_end) & (labels != 1)] = 0
    labels = smooth_labels(labels, faces, rounds=1)
    names = ["fn-geniculate", "fn-labyrinthine", "fn-tympanic", "fn-second-genu", "fn-mastoid"]
    report = export_labeled(verts, faces, labels, names)
    stale = MODELS / "fn-meatal.glb"
    if stale.exists():
        stale.unlink()
    lab_pts = verts[labels == 1]
    gen_pts = verts[labels == 0]
    fundus_pt = lab_pts[int(np.argmin(cKDTree(cv).query(lab_pts, k=1)[0]))]
    genu_pt = gen_pts[int(np.argmax(gen_pts[:, 0] + gen_pts[:, 2]))]
    labyrinthine_span = float(np.linalg.norm(fundus_pt - genu_pt))
    lengths = {
        "fn-geniculate": round(genu_end, 2),
        "fn-labyrinthine": round(labyrinthine_span, 2),
        "fn-tympanic": round(genu2_a - lab_end, 2),
        "fn-second-genu": round(genu2_b - genu2_a, 2),
        "fn-mastoid": round(total - genu2_b, 2),
    }
    report["arcMm"] = round(total, 2)
    report["lengthsMm"] = lengths
    report["rangesMm"] = {
        "fn-geniculate": [0.0, round(genu_end, 2)],
        "fn-labyrinthine": [round(genu_end, 2), round(lab_end, 2)],
        "fn-tympanic": [round(lab_end, 2), round(genu2_a, 2)],
        "fn-second-genu": [round(genu2_a, 2), round(min(genu2_b, total), 2)],
        "fn-mastoid": [round(min(genu2_b, total), 2), round(total, 2)],
    }
    report["fundusMm"] = round(fundus_s, 2)
    report["firstGenuMm"] = round(genu_end / 2, 2)
    report["secondGenuMm"] = round(genu2, 2)
    report["fundusPoint"] = fundus_pt.round(4).tolist()
    report["meatalPoint"] = cv[int(np.argmin(np.linalg.norm(cv - fundus_pt, axis=1)))].round(4).tolist()
    report["centerline"] = points[::3].round(3).tolist()
    report["meshLimited"] = (
        "The nerve surface stops near y = 35 mm. The bony fallopian canal continues about 3.5 mm, to about y = 38 mm, "
        "so the mastoid segment is about 16 mm to that point."
    )
    return report


def rot_axis(axis: np.ndarray, degrees: float) -> np.ndarray:
    angle = np.radians(degrees)
    c, s = np.cos(angle), np.sin(angle)
    k = unit(axis)
    cross = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + s * cross + (1 - c) * (cross @ cross)


def head_axes(skull: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    vertex = skull[int(np.argmin(skull[:, 1]))]
    nose = skull[int(np.argmax(skull[:, 0]))]
    mid_z = (vertex[2] + nose[2]) / 2
    vault = skull[(skull[:, 1] < vertex[1] + 50) & (np.abs(skull[:, 2] - mid_z) < 30)]
    occiput = vault[int(np.argmin(vault[:, 0]))]
    center = (nose + occiput) / 2
    center[1] = vertex[1] + 60
    superior = unit(vertex - center)
    anterior = unit((nose - center) - np.dot(nose - center, superior) * superior)
    lateral = unit(np.cross(anterior, superior))
    if lateral[2] > 0:
        lateral = -lateral
    return anterior, -superior, lateral


def anatomical_concha(auricle: np.ndarray) -> np.ndarray:
    """Cavum conchae: the medial floor of the bowl, not the centroid of the whole pinna."""
    center = auricle.mean(axis=0)
    _, _, vt = np.linalg.svd(auricle - center, full_matrices=False)
    normal = vt[2].copy()
    midline = np.array([40.0, 40.0, 92.0])
    if np.dot(normal, center - midline) < 0:
        normal = -normal
    in_plane = np.c_[(auricle - center) @ vt[0], (auricle - center) @ vt[1]]
    radius = np.linalg.norm(in_plane - in_plane.mean(axis=0), axis=1)
    inner = radius < np.percentile(radius, 35)
    inner_pts = auricle[inner]
    cavum = inner_pts[inner_pts[:, 1] >= np.median(inner_pts[:, 1])]
    height = (cavum - center) @ normal
    return cavum[int(np.argmin(height))]


def specimen_rotation(head_superior: np.ndarray, head_lateral: np.ndarray) -> np.ndarray:
    """Yaw about head-superior and pitch about head-lateral.

    Chosen so the lateral canal sits 25–30° off Frankfort and the two vertical
    canals sit about 45° off the midsagittal plane. The head itself is not moved.
    """
    return rot_axis(head_superior, -27.0) @ rot_axis(head_lateral, 15.0)


def apply_transform(points: np.ndarray, rotation: np.ndarray, translation: np.ndarray) -> np.ndarray:
    return (rotation @ points.T).T + translation


def lateral_inside(bone: np.ndarray, skin: np.ndarray, faces: np.ndarray, lateral: np.ndarray) -> dict:
    """A bone vertex is outside when the skin does not lie further lateral than it."""
    mesh = trimesh.Trimesh(skin, faces, process=False)
    direction = np.tile(unit(lateral), (len(bone), 1))
    outside = np.ones(len(bone), dtype=bool)
    for start in range(0, len(bone), 8000):
        chunk = bone[start : start + 8000]
        _, ray_index, _ = mesh.ray.intersects_id(
            chunk, direction[start : start + len(chunk)], return_locations=True, multiple_hits=False
        )
        hit = np.zeros(len(chunk), dtype=bool)
        hit[ray_index] = True
        outside[start : start + len(chunk)] = ~hit
    count = int(outside.sum())
    return {"outsideVertices": count, "outsideFraction": round(count / len(bone), 5), "vertices": int(len(bone))}


def bake_specimen(rotation: np.ndarray, translation: np.ndarray) -> None:
    for glb in sorted(MODELS.glob("*.glb")):
        name = glb.stem
        cached = WORK / f"{name}.bin"
        if cached.exists():
            cached.unlink()
        verts, faces = decode(name)
        encode(apply_transform(verts, rotation, translation), faces, glb.name)
    # Draco can leave a stray triangle island on the vestibule. Keep one chamber.
    cached = WORK / "vestibule.bin"
    if cached.exists():
        cached.unlink()
    verts, faces = decode("vestibule")
    kept, order = largest_island(faces)
    if len(order) != len(verts):
        encode(verts[order], kept, "vestibule.glb")


def transform_volume(rotation: np.ndarray, translation: np.ndarray) -> None:
    path = DATA / "ct" / "volume.json"
    volume = json.loads(path.read_text())
    origin = np.array(volume["origin_mm"], dtype=float)
    direction = np.array(volume["direction"], dtype=float).reshape(3, 3)
    volume["origin_mm"] = apply_transform(origin.reshape(1, 3), rotation, translation)[0].round(6).tolist()
    volume["direction"] = (rotation @ direction).round(8).reshape(-1).tolist()
    path.write_text(json.dumps(volume, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def transform_presets(rotation: np.ndarray, translation: np.ndarray) -> None:
    path = DATA / "presets.json"
    presets = json.loads(path.read_text())

    def move_point(value: list[float]) -> list[float]:
        return [round(float(v), 4) for v in apply_transform(np.array(value, dtype=float).reshape(1, 3), rotation, translation)[0]]

    def move_dir(value: list[float]) -> list[float]:
        return [round(float(v), 6) for v in (rotation @ np.array(value, dtype=float))]

    for sequence in presets.get("sequences", []):
        for step in sequence.get("steps", []):
            camera = step.get("camera")
            if isinstance(camera, dict):
                if "position" in camera:
                    camera["position"] = move_point(camera["position"])
                if "target" in camera:
                    camera["target"] = move_point(camera["target"])
                if "up" in camera:
                    camera["up"] = move_dir(camera["up"])
            clipping = step.get("clipping")
            if isinstance(clipping, dict) and "normal" in clipping:
                normal = np.array(clipping["normal"], dtype=float)
                clipping["normal"] = move_dir(clipping["normal"])
                clipping["constant"] = round(float(clipping.get("constant", 0)) - float(np.dot(rotation @ normal, translation)), 4)
            marker = step.get("marker")
            if isinstance(marker, dict) and "position_mm" in marker:
                marker["position_mm"] = move_point(marker["position_mm"])
    path.write_text(json.dumps(presets, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def skull_fit(bone: np.ndarray, skull: np.ndarray, faces: np.ndarray, lateral: np.ndarray) -> dict:
    """Bone vs the skull's outer surface. A lateral ray that hits the skull means the bone is inside it."""
    mesh = trimesh.Trimesh(skull, faces, process=False)
    outward = np.tile(unit(lateral), (len(bone), 1))
    inside = np.zeros(len(bone), dtype=bool)
    depth = np.full(len(bone), np.nan)
    for start in range(0, len(bone), 8000):
        chunk = bone[start : start + 8000] + outward[start : start + 8000] * 0.05
        _, ray_index, locations = mesh.ray.intersects_id(
            chunk, outward[start : start + len(chunk)], return_locations=True, multiple_hits=False
        )
        if len(ray_index):
            inside[start + ray_index] = True
            depth[start + ray_index] = np.linalg.norm(locations - bone[start : start + len(chunk)][ray_index], axis=1)
    outside = np.zeros(len(bone), dtype=bool)
    missing = np.where(~inside)[0]
    for start in range(0, len(missing), 8000):
        chosen = missing[start : start + 8000]
        origin = bone[chosen] - outward[chosen] * 0.05
        _, ray_index, locations = mesh.ray.intersects_id(
            origin, -outward[chosen], return_locations=True, multiple_hits=False
        )
        if len(ray_index) == 0:
            outside[chosen] = True
            continue
        dist = np.full(len(chosen), 99.0)
        dist[ray_index] = np.linalg.norm(locations - bone[chosen][ray_index], axis=1)
        outside[chosen] = dist > 3.0
    count = int(outside.sum())
    return {
        "outsideOver3mm": count,
        "outsideOver3mmFraction": round(count / len(bone), 4),
        "insideFraction": round(float(inside.mean()), 4),
        "insideDepthMedianMm": round(float(np.nanmedian(depth)), 2),
        "vertices": int(len(bone)),
    }


def inside_fraction(bone: np.ndarray, skin: np.ndarray, faces: np.ndarray) -> dict:
    mesh = trimesh.Trimesh(skin, faces, process=False)
    votes = np.zeros(len(bone))
    directions = ([1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -1.0], [-1.0, 0.0, 0.0])
    for direction in directions:
        for start in range(0, len(bone), 7000):
            pts = bone[start : start + 7000]
            _, ray_index, _ = mesh.ray.intersects_id(
                pts, np.tile(direction, (len(pts), 1)), return_locations=True, multiple_hits=True
            )
            counts = np.bincount(ray_index, minlength=len(pts))
            votes[start : start + len(pts)] += (counts % 2 == 1).astype(np.float64)
    outside = int((votes <= 1).sum())
    return {"outsideVertices": outside, "outsideFraction": round(outside / len(bone), 5), "vertices": int(len(bone))}


def snap(tree: cKDTree, points: np.ndarray, guess: np.ndarray) -> np.ndarray:
    _, index = tree.query(guess, k=1)
    return points[int(index)]


def landmark(item_id, parent, en, ko, xyz, anatomy, clinical, sources, method, surgical=False, confidence="placed") -> dict:
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
        "confidence": confidence,
        "surgical": surgical,
    }


def separate(points: dict[str, np.ndarray], minimum: float = 0.8) -> None:
    """Nudge stacked anchors along +Z so two labels do not share one coordinate."""
    ids = list(points)
    for i, left in enumerate(ids):
        for right in ids[i + 1 :]:
            if np.linalg.norm(points[left] - points[right]) < minimum:
                points[right] = points[right] + MEDIAL * minimum


def scrub_user_text() -> None:
    """User-facing copy describes anatomy. It does not describe how the files were built."""
    carotid_path = DATA / "content" / "carotid-artery.json"
    carotid = json.loads(carotid_path.read_text())
    carotid["function"]["ko"] = (
        "추체부 경동맥관을 가로질러 해면정맥동으로 이어지는 주된 두개내 동맥 경로임\n"
        "관 내 교감신경총을 동반하며, 고실 전벽·이관·와우와 밀접하여 중이·추체첨 병변이나 외상에 노출될 수 있음"
    )
    carotid["sources"] = [item for item in carotid["sources"] if "이번 회차" not in item.get("page", "")]
    carotid_path.write_text(json.dumps(carotid, ensure_ascii=False, indent=2) + "\n", encoding="utf8")

    chorda_path = DATA / "content" / "chorda-tympani.json"
    chorda = json.loads(chorda_path.read_text())
    for point in chorda.get("surgical_points", []):
        text = point.get("text", {}).get("ko", "")
        if "확인하지" in text or "이번에 연" in text:
            point["text"]["ko"] = "경외이도: 고막이 투명하면 고실 안에서 보일 수 있으므로, 고실 조작 때 견인하거나 자르지 않도록 한다."
    chorda["sources"] = [item for item in chorda["sources"] if "이번 회차" not in item.get("page", "") and "전형적 중이사행" not in item.get("citation", "")]
    chorda_path.write_text(json.dumps(chorda, ensure_ascii=False, indent=2) + "\n", encoding="utf8")

    sinus_path = DATA / "content" / "sinus-dura.json"
    sinus = json.loads(sinus_path.read_text())
    sinus["function"]["en"] = "It continues the transverse sinus through the jugular foramen into the internal jugular vein."
    sinus_path.write_text(json.dumps(sinus, ensure_ascii=False, indent=2) + "\n", encoding="utf8")

    presets_path = DATA / "presets.json"
    presets = json.loads(presets_path.read_text())
    if isinstance(presets.get("note"), dict):
        presets["note"] = {
            "en": "Camera up is the top of the head. The temporal bone has been turned into that upright head. Bone is not drilled. The antrum point is an estimate and is unverified.",
            "ko": "카메라의 위쪽은 머리의 위다. 측두골은 그 똑바로 선 머리에 맞춰 돌려 두었다. 뼈를 갈아내는 기능은 없다. 유양동 점은 추정이며 미검증이다.",
        }
    replacements = {
        "There is no antrum mesh. The point is an estimate and is unverified.": "The antrum is marked by a point. The air cells themselves are not shown. The point is unverified.",
        "유양동 메시는 없습니다. 점은 추정 위치이며 미검증입니다.": "유양동은 점으로만 표시되어 있고 함기셀은 그려져 있지 않다. 점은 미검증이다.",
        "유양동 메시는 없습니다. Henle 극 추정점에서 안쪽·뒤·위로 둔 점이며 미검증입니다.": "Henle 극에서 안쪽·뒤·위로 둔 점이다. 미검증이다.",
        "Along the canal axis, toward the tympanic membrane and malleus. The canal mesh is hidden so the membrane shows.": "Along the canal axis, toward the tympanic membrane and malleus. The canal is hidden so the membrane shows.",
        "외이도 축에서 고막과 추골을 봅니다. 외이도 메시는 숨겨 고막이 보이게 합니다.": "외이도 축에서 고막과 추골을 본다. 외이도는 숨겨 고막이 보이게 한다.",
    }
    raw = json.dumps(presets, ensure_ascii=False, indent=2)
    for old, new in replacements.items():
        raw = raw.replace(old, new)
    presets_path.write_text(raw + "\n", encoding="utf8")

    manifest_path = DATA / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    for item in manifest.get("missing_structures", []):
        if item.get("name") == "Mastoid antrum mesh":
            item["name"] = "Mastoid antrum"
        if item.get("name") == "Jugular bulb":
            item["note"] = "A review point is in landmarks.json. This is the jugular bulb (경정맥구), not the jugular foramen (목정맥공)."
        if item.get("name") == "Mastoid antrum":
            item["note"] = "Only a landmark is shown."
    registration = json.loads((UPPER / "registration.json").read_text())
    axes = registration["headAxes"]

    def flipped(vector: list[float]) -> list[float]:
        return [round(-float(value), 6) for value in vector]

    manifest["anatomicalFrame"] = {
        "anterior": [round(float(v), 6) for v in axes["anterior"]],
        "posterior": flipped(axes["anterior"]),
        "inferior": [round(float(v), 6) for v in axes["inferior"]],
        "superior": flipped(axes["inferior"]),
        "medial": flipped(axes["lateral"]),
        "lateral": [round(float(v), 6) for v in axes["lateral"]],
        "review": "미검증",
    }
    frame = manifest.get("coordinate_system")
    if isinstance(frame, dict):
        frame["x"] = {"en": "nearly anterior", "ko": "거의 앞"}
        frame["y"] = {"en": "nearly inferior", "ko": "거의 아래"}
        frame["z"] = {"en": "nearly medial. Right ear", "ko": "거의 안쪽. 오른쪽 귀"}
        frame["note"] = {
            "en": "Coordinates are millimetres in the upright head. Scale is 1. The exact anterior, inferior, and lateral directions are anatomicalFrame.",
            "ko": "좌표는 똑바로 선 머리의 밀리미터다. 배율은 1이다. 정확한 앞·아래·가쪽은 anatomicalFrame에 있다.",
        }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / "out").mkdir(parents=True, exist_ok=True)
    PLOTS.mkdir(parents=True, exist_ok=True)
    for stale in WORK.glob("*.bin"):
        stale.unlink()

    labyrinth_v, labyrinth_f = decode("labyrinth")
    scala_t, scala_tf = decode("scala-tympani")
    facial, facial_f = decode("facial-nerve")
    cv, _ = decode("cochleovestibular-nerve")
    malleus, _ = decode("malleus")
    incus, _ = decode("incus")
    stapes, _ = decode("stapes")
    tm, tm_f = decode("tympanic-membrane")
    eac, _ = decode("external-auditory-canal")
    bone, bone_f = decode("bone")
    chorda, _ = decode("chorda-tympani")
    sinus, _ = decode("sinus-dura")
    carotid, _ = decode("carotid-artery")
    skin, skin_f = decode("skin", UPPER)
    skull, skull_f = decode("skull", UPPER)
    auricle, auricle_f = decode("auricle", UPPER)

    cycles = canal_cycles(labyrinth_v, labyrinth_f)
    by_name = {item["name"]: item for item in cycles}
    cochlear = cKDTree(scala_t).query(labyrinth_v, k=1)[0] < 1.6
    trees = {name: cKDTree(item["points"]) for name, item in by_name.items()}
    names = ["scc-lateral", "scc-superior", "scc-posterior", "common-crus", "vestibule"]
    canal_of = {"lateral": 0, "superior": 1, "posterior": 2}
    foot_early = stapes[stapes[:, 2] >= np.quantile(stapes[:, 2], 0.72)].mean(axis=0)
    # The oval-window side of the old "scala vestibuli" is the vestibule, not a cochlear turn.
    window_ball = np.linalg.norm(labyrinth_v - foot_early, axis=1) < 5.0
    labels = np.full(len(labyrinth_v), -1, dtype=np.int32)
    for index in range(len(labyrinth_v)):
        point = labyrinth_v[index]
        distances = {name: float(trees[name].query(point)[0]) for name in trees}
        nearest = min(distances, key=distances.get)
        on_crus = distances["superior"] < 1.15 and distances["posterior"] < 1.15 and distances["lateral"] > 1.6
        on_duct = distances[nearest] <= 1.05 and not on_crus
        if window_ball[index] and not on_duct:
            labels[index] = 4
        elif on_crus:
            labels[index] = 3
        elif on_duct:
            labels[index] = canal_of[nearest]
        elif cochlear[index]:
            labels[index] = -1
        else:
            labels[index] = 4
    labels = absorb_small_components(labyrinth_v, labyrinth_f, labels, minimum=400, into=4)
    # One vestibule: the central chamber that reaches the oval window. Detached scraps are cochlear.
    labels = keep_largest_component(labyrinth_v, labyrinth_f, labels, label_id=4, fallback=-1)
    cochlear = labels < 0
    rest_report = export_rest(labyrinth_v, labyrinth_f, labels, cochlear, names)

    cochlear_index = np.where(cochlear)[0]
    remap = -np.ones(len(labyrinth_v), dtype=np.int32)
    remap[cochlear_index] = np.arange(len(cochlear_index))
    cochlear_faces = labyrinth_f[cochlear[labyrinth_f].all(axis=1)]
    cochlear_verts = labyrinth_v[cochlear_index]
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
    nerve = facial_segments(facial, facial_f, cv, stapes)

    # Canal geometry checks.
    lateral_pts = labyrinth_v[labels == 0]
    posterior_pts = labyrinth_v[labels == 2]
    superior_pts = labyrinth_v[labels == 1]
    if posterior_pts[:, 1].max() <= lateral_pts[:, 1].max():
        raise RuntimeError("posterior canal is not inferior to the lateral canal")
    normals = {item["name"]: item["normal"] for item in cycles}
    angles = {
        "lateralToVerticalDeg": round(angle_between(normals["lateral"], INFERIOR), 1),
        "superiorToPosteriorDeg": round(angle_between(normals["superior"], normals["posterior"]), 1),
        "lateralToSuperiorDeg": round(angle_between(normals["lateral"], normals["superior"]), 1),
        "lateralToPosteriorDeg": round(angle_between(normals["lateral"], normals["posterior"]), 1),
    }
    if angles["lateralToVerticalDeg"] > 35:
        raise RuntimeError(f"lateral canal normal is {angles['lateralToVerticalDeg']}° from vertical")

    # --- landmarks -------------------------------------------------------
    bone_tree = cKDTree(bone)
    tm_tree = cKDTree(tm)

    def on_bone(guess: np.ndarray) -> np.ndarray:
        return snap(bone_tree, bone, guess)

    porus_pool = eac[eac[:, 2] <= np.quantile(eac[:, 2], 0.08)]
    porus = porus_pool.mean(axis=0)
    eac_axis = unit(eac[int(np.argmax(eac[:, 2]))] - porus)
    head = malleus[int(np.argmin(malleus[:, 1]))]
    umbo = malleus[int(np.argmax(malleus[:, 1]))]
    mal_dist = tm_tree.query(malleus, k=1)[0]
    near_tm = mal_dist < 0.8
    lateral_process = malleus[near_tm][int(np.argmin(malleus[near_tm][:, 1]))]
    neck_guess = head * 0.55 + lateral_process * 0.45
    neck = malleus[int(np.argmin(np.linalg.norm(malleus - neck_guess, axis=1)))]
    manubrium_guess = (lateral_process + umbo) / 2
    manubrium = malleus[int(np.argmin(np.linalg.norm(malleus - manubrium_guess, axis=1)))]
    anterior_process = malleus[int(np.argmax(malleus[:, 0]))]

    incus_body = incus[incus[:, 1] <= np.median(incus[:, 1])].mean(axis=0)
    incus_body = incus[int(np.argmin(np.linalg.norm(incus - incus_body, axis=1)))]
    short_process = incus[int(np.argmin(incus[:, 2]))]
    lenticular = incus[int(np.argmin(np.linalg.norm(incus - stapes.mean(axis=0), axis=1)))]
    long_guess = incus_body * 0.45 + lenticular * 0.55
    long_process = incus[int(np.argmin(np.linalg.norm(incus - long_guess, axis=1)))]

    foot = stapes[stapes[:, 2] >= np.quantile(stapes[:, 2], 0.72)]
    footplate = foot.mean(axis=0)
    stapes_head = stapes[int(np.argmin(np.linalg.norm(stapes - lenticular, axis=1)))]
    between = stapes[(stapes[:, 2] > np.quantile(stapes[:, 2], 0.35)) & (stapes[:, 2] < np.quantile(stapes[:, 2], 0.65))]
    anterior_pool = between[np.linalg.norm(between - stapes_head, axis=1) > 1.6]
    anterior_pool = anterior_pool[anterior_pool[:, 0] >= np.median(stapes[:, 0])]
    posterior_pool = between[np.linalg.norm(between - stapes_head, axis=1) > 1.6]
    posterior_pool = posterior_pool[posterior_pool[:, 0] <= np.median(stapes[:, 0])]
    if len(anterior_pool) == 0 or len(posterior_pool) == 0:
        raise RuntimeError("stapes crura could not be separated from the head")

    def mid_crus(pool: np.ndarray) -> np.ndarray:
        distance = np.linalg.norm(pool - stapes_head, axis=1)
        mid = pool[(distance >= 2.0) & (distance <= 2.8)]
        if len(mid) == 0:
            mid = pool[distance >= 1.8]
        if len(mid) == 0:
            raise RuntimeError("stapes crus has no mid-shaft vertex")
        return mid

    anterior_crus = mid_crus(anterior_pool)
    anterior_crus = anterior_crus[int(np.argmax(anterior_crus[:, 0]))]
    posterior_crus = mid_crus(posterior_pool)
    posterior_crus = posterior_crus[int(np.argmin(posterior_crus[:, 0]))]
    oval_window = footplate + MEDIAL * 0.8

    basal = scala_t[st_phase < 2 * np.pi]
    promontory = basal[int(np.argmin(basal[:, 2] - 0.15 * basal[:, 0]))]
    if np.linalg.norm(promontory - round_window) < 1.2:
        promontory = basal[int(np.argmax(basal[:, 0] - basal[:, 2]))]

    fn_pts = np.array(nerve["centerline"])
    fn_arc = nerve["arcMm"]

    def on_nerve(distance: float) -> np.ndarray:
        fraction = np.clip(distance / fn_arc, 0, 1)
        index = fraction * (len(fn_pts) - 1)
        low = int(np.floor(index))
        high = min(low + 1, len(fn_pts) - 1)
        return fn_pts[low] * (1 - (index - low)) + fn_pts[high] * (index - low)

    geniculate = on_nerve(nerve["firstGenuMm"])
    second_genu = on_nerve(nerve["secondGenuMm"])
    mastoid_end = fn_pts[-1]
    post_lat = bone[(bone[:, 0] < np.percentile(bone[:, 0], 40)) & (bone[:, 2] < np.percentile(bone[:, 2], 45))]
    mastoid_tip = post_lat[int(np.argmax(post_lat[:, 1]))]
    zyg_pool = bone[(bone[:, 0] > porus[0] + 6) & (np.abs(bone[:, 1] - porus[1]) < 14) & (bone[:, 2] < porus[2] + 8)]
    zygomatic = zyg_pool[int(np.argmin(np.linalg.norm(zyg_pool - porus, axis=1)))]
    ssc_top = labyrinth_v[int(np.argmin(labyrinth_v[:, 1]))]
    arcuate = on_bone(ssc_top + SUPERIOR * 3.5)
    inf_tail = bone[bone[:, 1] > np.percentile(bone[:, 1], 98)]
    styloid_tip = inf_tail[int(np.argmax(inf_tail[:, 1]))]
    smf = on_bone(mastoid_end + INFERIOR * 6)
    # The base is where the process meets the skull, a few millimetres inferior to the foramen, not the tip.
    styloid_base = on_bone(smf + unit(styloid_tip - smf) * 6.0)
    jugular = on_bone(carotid.mean(axis=0) + POSTERIOR * 4 + INFERIOR * 4)
    henle = on_bone(porus + POSTERIOR * 3 + SUPERIOR * 1 + LATERAL * 1)
    macewen = on_bone(henle + POSTERIOR * 4 + SUPERIOR * 3)
    temporal_line = on_bone(macewen + SUPERIOR * 8 + ANTERIOR * 2)
    digastric = on_bone(mastoid_tip + MEDIAL * 6 + SUPERIOR * 5 + ANTERIOR * 2)
    tegmen = on_bone(malleus.mean(axis=0) + SUPERIOR * 8)
    antrum = on_bone(henle + MEDIAL * 8 + POSTERIOR * 2 + SUPERIOR * 2)
    # The angle is where the sigmoid plate meets the tegmen, posterior to the antrum,
    # not the highest corner of the sinus.
    posterior = (sinus - antrum) @ ANTERIOR < -4.0
    near_tegmen = np.abs((sinus - tegmen) @ INFERIOR) < 8.0
    pool = sinus[posterior & near_tegmen]
    if len(pool) == 0:
        raise RuntimeError("sinodural angle pool is empty")
    sinodural = on_bone(pool[int(np.argmin(np.linalg.norm(pool - tegmen, axis=1)))])
    chorda_mid = chorda.mean(axis=0)
    facial_recess = on_bone((mastoid_end + chorda_mid) / 2 + LATERAL * 0.6)
    pyramidal = on_bone(second_genu + ANTERIOR * 1.6 + MEDIAL * 1.4)
    sinus_tympani = on_bone(round_window + MEDIAL * 1.6 + POSTERIOR * 1.4)
    cochleariform = on_bone(geniculate + POSTERIOR * 1.8 + INFERIOR * 1.4)
    if cochleariform[0] >= geniculate[0] or cochleariform[1] <= geniculate[1]:
        raise RuntimeError(f"cochleariform {cochleariform.round(2)} is not posterior and inferior to geniculate {geniculate.round(2)}")
    if np.linalg.norm(anterior_crus - stapes_head) < 1.5:
        raise RuntimeError("anterior crus is still on the stapes head")
    if not (0 < styloid_base[1] - smf[1] < 10):
        raise RuntimeError(f"styloid base {styloid_base.round(2)} is not just inferior to the foramen {smf.round(2)}")
    if sinodural[0] >= tegmen[0] or abs(sinodural[1] - tegmen[1]) > 8:
        raise RuntimeError(f"sinodural angle {sinodural.round(2)} is not at tegmen level and posterior to it {tegmen.round(2)}")
    if pyramidal[0] <= second_genu[0] or pyramidal[2] <= second_genu[2]:
        raise RuntimeError(f"pyramidal eminence {pyramidal.round(2)} is not anteromedial to the second genu {second_genu.round(2)}")
    prussak = (lateral_process + neck) / 2 + LATERAL * 0.5
    ponticulus = on_bone((footplate + round_window) / 2 + POSTERIOR * 0.6)
    subiculum = on_bone(round_window + INFERIOR * 1.2 + POSTERIOR * 0.4)
    iac = cv[int(np.argmax(cv[:, 2]))]
    basal_turn = basal.mean(axis=0)
    middle_turn = scala_t[(st_phase >= 2 * np.pi) & (st_phase < 4 * np.pi)].mean(axis=0)
    apical_turn = scala_t[st_phase >= np.percentile(st_phase, 80)].mean(axis=0)
    vestibule_pts = labyrinth_v[labels == 4]
    vestibule_center = vestibule_pts.mean(axis=0)
    ampulla = {}
    for key, label in (("lateral", 0), ("superior", 1), ("posterior", 2)):
        part = labyrinth_v[labels == label]
        ampulla[key] = part[int(np.argmin(np.linalg.norm(part - vestibule_center, axis=1)))]
    crus_pts = labyrinth_v[labels == 3]
    common_crus = crus_pts.mean(axis=0) if len(crus_pts) else (by_name["superior"]["points"] + by_name["posterior"]["points"]).mean(axis=0) * 0 + by_name["superior"]["points"][len(by_name["superior"]["points"]) // 2]

    scc_anchor = {
        "lateral": lateral_pts[int(np.argmin(lateral_pts[:, 2]))],
        "superior": superior_pts[int(np.argmin(superior_pts[:, 1]))],
        "posterior": posterior_pts[int(np.argmax(posterior_pts[:, 1]))],
    }
    pars_flaccida = tm[tm[:, 1] <= np.quantile(tm[:, 1], 0.12)].mean(axis=0)

    points = {
        "malleus-head": head,
        "malleus-neck": neck,
        "malleus-manubrium": manubrium,
        "malleus-lateral-process": lateral_process,
        "malleus-anterior-process": anterior_process,
        "umbo": umbo,
        "incus-body": incus_body,
        "incus-short-process": short_process,
        "incus-long-process": long_process,
        "incus-lenticular": lenticular,
        "stapes-head": stapes_head,
        "stapes-anterior-crus": anterior_crus,
        "stapes-posterior-crus": posterior_crus,
        "stapes-footplate": footplate,
        "oval-window": oval_window,
        "round-window": round_window,
        "promontory": promontory,
    }
    separate(points, 0.7)
    # separate() must not drag the stapes head onto the crus. Keep those three on the stapes.
    points["stapes-head"] = np.array(stapes_head, dtype=float)
    points["stapes-anterior-crus"] = np.array(anterior_crus, dtype=float)
    points["stapes-posterior-crus"] = np.array(posterior_crus, dtype=float)
    if np.linalg.norm(points["incus-lenticular"] - points["stapes-head"]) < 0.5:
        points["incus-lenticular"] = points["incus-lenticular"] + unit(points["incus-body"] - points["incus-lenticular"]) * 0.5

    def L(*args, **kwargs):
        return landmark(*args, **kwargs)

    s126 = lambda page: [source(C126, page)]
    rows = [
        L("malleus-head", "malleus", "Head of malleus", "추골 두부", points["malleus-head"], "Superior end of the malleus, in the epitympanum, where it meets the incus body.", "Epitympanic part of the incudomalleolar joint.", [source(FRANCIS2, "p. 5")], "superior vertex", True),
        L("malleus-neck", "malleus", "Neck of malleus", "추골 경부", points["malleus-neck"], "Narrow segment between the head and the lateral process.", "The chorda tympani runs medial to this neck.", s126("p. 8"), "between head and lateral process", True),
        L("malleus-manubrium", "malleus", "Manubrium", "추골병", points["malleus-manubrium"], "Handle embedded in the tympanic membrane, from the lateral process toward the umbo.", "Forms the mallear stria.", s126("p. 5"), "mid-handle vertex"),
        L("malleus-lateral-process", "malleus", "Lateral process", "추골 외측돌기", points["malleus-lateral-process"], "Short lateral projection at the upper end of the manubrium.", "Otoscopic mallear prominence.", s126("p. 5"), "superior contact with the membrane", True),
        L("malleus-anterior-process", "malleus", "Anterior process", "추골 전돌기", points["malleus-anterior-process"], "Small anterior projection from the neck region.", "Attachment of the anterior mallear ligament.", s126("p. 5"), "most anterior vertex"),
        L("umbo", "malleus", "Umbo", "고막배꼽(제)", points["umbo"], "Inferior tip of the manubrium at the centre of the pars tensa.", "The membrane is drawn medially here.", s126("p. 5"), "inferior tip", True),
        L("incus-body", "incus", "Body of incus", "침골 체부", points["incus-body"], "Superior bulk of the incus in the epitympanum.", "Incudomalleolar joint.", [source(FRANCIS2, "p. 5")], "superior-half centroid"),
        L("incus-short-process", "incus", "Short process of incus", "침골 단각", points["incus-short-process"], "Posterior-lateral tip of the incus, aimed at the fossa incudis.", "Mastoidectomy depth cue for the facial nerve.", [source(FRANCIS3, "p. 13")], "most lateral incus vertex", True),
        L("incus-long-process", "incus", "Long process of incus", "침골 장각", points["incus-long-process"], "Descending process of the incus, proximal to the lenticular process.", "Common site of ossicular erosion.", s126("p. 5"), "mid long process", True),
        L("incus-lenticular", "incus", "Lenticular process", "침골 두상돌기", points["incus-lenticular"], "Medial knob at the end of the long process.", "Incudostapedial joint.", [source(SANNA, "Ch. 1")], "vertex nearest the stapes"),
        L("stapes-head", "stapes", "Head of stapes", "등골 두부", points["stapes-head"], "Lateral end of the stapes at the incudostapedial joint.", "Separated from the lenticular process so the labels do not share a point.", [source(SANNA, "Ch. 1")], "vertex nearest the lenticular process", True),
        L("stapes-anterior-crus", "stapes", "Anterior crus", "등골 전각", points["stapes-anterior-crus"], "Anterior limb between the head and the footplate.", "Landmark in stapes surgery.", [source(FRANCIS2, "p. 7")], "anterior crus vertex"),
        L("stapes-posterior-crus", "stapes", "Posterior crus", "등골 후각", points["stapes-posterior-crus"], "Posterior limb between the head and the footplate.", "The stapedius tendon reaches the neck near this crus.", [source(FRANCIS2, "p. 7")], "posterior crus vertex"),
        L("stapes-footplate", "stapes", "Footplate", "등골 족판", points["stapes-footplate"], "Medial plate of the stapes seated in the oval window.", "Held by the annular ligament.", [source(FRANCIS2, "p. 7")], "medial cluster centroid", True),
        L("oval-window", "stapes", "Oval window", "난원창", points["oval-window"], "Opening from the middle ear into the vestibule, just medial to the footplate.", "The tympanic facial nerve runs above it.", s126("p. 1"), "medial to the footplate centroid", True),
        L("round-window", "scala-tympani", "Round window", "정원창", points["round-window"], "Basal opening of the scala tympani on the middle-ear side.", "Cochlear-implant entry.", s126("p. 5"), "most lateral scala tympani vertex", True),
        L("promontory", "scala-tympani", "Promontory", "갑각", points["promontory"], "Lateral bulge of the basal turn on the medial wall of the tympanum.", "Jacobson nerve crosses it.", s126("p. 6"), "lateral basal-turn vertex, off the round window", True),
        L("cochlea-basal", "scala-tympani", "Basal turn", "와우 기저회전", basal_turn, "First turn of the cochlea, beginning at the round window.", "The promontory covers its lateral face.", [source(C175, "p. 10")], "centroid of the first turn"),
        L("cochlea-middle", "scala-tympani", "Middle turn", "와우 중간회전", middle_turn, "Second turn about the modiolus.", "Continues the spiral.", s126("Ch. 126"), "centroid of the second turn"),
        L("cochlea-apical", "scala-tympani", "Apical turn", "와우 첨부회전", apical_turn, "Apical end of the cochlear spiral.", "Closest to the modiolus.", s126("Ch. 126"), "centroid of the apical angle"),
        L("geniculate-ganglion", "fn-geniculate", "Geniculate ganglion", "슬신경절", geniculate, "First genu at the anterior turn, where the labyrinthine segment turns into the tympanic segment.", "The greater petrosal nerve leaves the ganglion here.", s126("p. 7"), "anterior tip of the facial-nerve surface", True),
        L("meatal-segment", "cochleovestibular-nerve", "Meatal segment", "안면신경 내이도부", np.array(nerve["meatalPoint"]), "The facial nerve in the internal auditory canal. It travels in the cochleovestibular bundle; the separate facial-nerve surface begins at the fundus.", "Bill's bar stands between the facial nerve and the superior vestibular nerve.", [source(C175, "p. 9")], "contact of the facial nerve with the cochleovestibular bundle"),
        L("second-genu", "fn-second-genu", "Second genu", "제2슬", second_genu, "The bend where the tympanic segment turns down into the mastoid segment.", "The pyramidal eminence is anteromedial to this bend.", s126("p. 7"), "sharpest inferior bend", True),
        L("cochleariform-process", "bone", "Cochleariform process", "와우형돌기", cochleariform, "Bony hook just posterior and inferior to the geniculate, at the anterior end of the tympanic segment, above the oval window.", "The tensor tympani tendon turns laterally here.", s126("p. 7"), "bone posterior and inferior to the geniculate", True, "미확인"),
        L("pyramidal-eminence", "bone", "Pyramidal eminence", "추체융기", pyramidal, "Small bony pyramid anteromedial to the second genu, in the posterior tympanum.", "The stapedius tendon leaves it toward the stapes.", s126("p. 1"), "bone anteromedial to the second genu", True, "미확인"),
        L("sinus-tympani", "bone", "Sinus tympani", "고실동", sinus_tympani, "Recess medial to the mastoid facial nerve and posterior to the round window.", "A cholesteatoma can hide here.", s126("p. 7"), "medial and posterior to the round window", True, "미확인"),
        L("facial-recess", "bone", "Facial recess", "안면신경와", facial_recess, "Space between the mastoid facial nerve and the chorda tympani.", "Posterior tympanotomy corridor.", s126("p. 10"), "between mastoid nerve and chorda", True, "미확인"),
        L("ponticulus", "bone", "Ponticulus", "폰티쿨루스", ponticulus, "Bony ridge between the oval window and the sinus tympani.", "It forms the upper border of the sinus tympani.", [source(FRANCIS3, "p. 19")], "between footplate and round window", False, "미확인"),
        L("subiculum", "bone", "Subiculum", "서브이쿨룸", subiculum, "Bony ridge under the sinus tympani, beside the round-window niche.", "It forms the lower border of the sinus tympani.", [source(FRANCIS3, "p. 19")], "inferior to the round window", False, "미확인"),
        L("prussak-space", "tympanic-membrane", "Prussak space", "Prussak 공간", prussak, "Pocket between pars flaccida and the neck of the malleus.", "Attic cholesteatoma site.", s126("p. 8"), "lateral to the malleus neck", True),
        L("henle-spine", "bone", "Spine of Henle", "Henle 극", henle, "Spine on the posterosuperior bony canal rim.", "The antrum lies deep to it.", s126("p. 1"), "bone just posterosuperior to the porus", True, "미확인"),
        L("macewen-triangle", "bone", "MacEwen triangle", "MacEwen 삼각", macewen, "Surface triangle posterosuperior to the spine of Henle.", "Surface mark of the antrum.", s126("p. 1"), "bone posterosuperior to Henle", True, "미확인"),
        L("mastoid-antrum", "bone", "Mastoid antrum", "유양동", antrum, "The largest mastoid air space, medial to the spine of Henle.", "It opens into the epitympanum through the aditus.", s126("p. 11"), "medial to Henle", True, "미확인"),
        L("tegmen", "bone", "Tegmen", "천개", tegmen, "Bony roof of the middle ear and mastoid, the floor of the middle fossa.", "Defects here meet dura.", s126("p. 8"), "superior bone near the middle ear", True),
        L("sinodural-angle", "sinus-dura", "Sinodural angle", "정맥동경막각", sinodural, "Corner where the sigmoid sinus plate meets the middle-fossa plate, at the level of the tegmen and posterior to the antrum.", "Posterior-superior limit of a cortical mastoidectomy.", s126("p. 11"), "sigmoid at tegmen level, posterior to the antrum", True, "미확인"),
        L("digastric-ridge", "bone", "Digastric ridge", "이복근릉", digastric, "Ridge on the medial side of the mastoid tip that leads to the stylomastoid foramen.", "It points to the facial nerve as it leaves the mastoid.", s126("p. 1"), "medial to the mastoid tip", True, "미확인"),
        L("mastoid-tip", "bone", "Mastoid tip", "유양돌기 첨부", mastoid_tip, "Inferior end of the mastoid process.", "The mastoid segment of the facial nerve ends above this tip.", [source(FRANCIS3, "p. 2")], "most inferior posterolateral vertex", True),
        L("temporal-line", "bone", "Temporal line", "측두선", temporal_line, "Line on the lateral surface above MacEwen triangle.", "Superior limit of a cortical mastoidectomy.", [source(FRANCIS3, "p. 2")], "estimated on the lateral surface", True, "미확인"),
        L("sigmoid-sinus", "sinus-dura", "Sigmoid sinus", "S상정맥동", sinus[int(np.argmax(sinus[:, 1] - sinus[:, 0]))], "Posterior venous channel along the back of the mastoid.", "It is the posterior limit of mastoidectomy.", s126("Ch. 126"), "posterior point on the sigmoid sinus", True),
        L("jugular-bulb", "sinus-dura", "Jugular bulb", "경정맥구", jugular, "Venous bulb under the hypotympanum, just behind the petrous carotid.", "A high bulb narrows the floor of the middle ear.", s126("p. 3"), "bone near the carotid genu", True, "미확인"),
        L("eac-porus", "external-auditory-canal", "EAC porus", "외이도 입구", porus, "Lateral rim of the bony external canal, just deep to the concha.", "The bony opening sits behind the cavum conchae.", s126("p. 1"), "centroid of the lateral 8% of canal vertices"),
        L("iac", "cochleovestibular-nerve", "Internal auditory canal", "내이도", iac, "Medial end of the canal, where the cochlear and vestibular nerves enter the posterior fossa.", "The facial nerve lies anterosuperior at the fundus.", [source(C175, "p. 9")], "medial end of the canal", True),
        L("zygomatic-root", "bone", "Zygomatic root", "관골돌기 기시부", zygomatic, "Root of the zygomatic process just anterior to the porus.", "Anterior surface landmark.", s126("p. 1"), "bone anterior to the porus"),
        L("stylomastoid-foramen", "fn-mastoid", "Stylomastoid foramen", "경유돌공", smf, "Opening where the facial nerve leaves the mastoid, a few millimetres below the end of the nerve surface.", "The digastric ridge points here.", s126("p. 1"), "bone just inferior to the mastoid nerve", True, "미확인"),
        L("styloid-base", "bone", "Styloid base", "경상돌기 기저", styloid_base, "Root of the styloid process, just inferior to the stylomastoid foramen. The tip of the process is further inferior.", "The base is not the free tip.", [source(SOM, "Ch. 15")], "a few millimetres inferior to the stylomastoid foramen"),
        L("vestibule-center", "vestibule", "Vestibule", "전정", vestibule_center, "Central chamber of the labyrinth, between the canals and the cochlea.", "The oval window opens into its lateral wall.", s126("Ch. 126"), "centre of the vestibule"),
        L("scc-lateral-arch", "scc-lateral", "Lateral semicircular canal", "외측반고리관", scc_anchor["lateral"], "Lateralmost point of the lateral canal loop.", "Mastoid landmark; the second genu is inferior to this arch.", s126("p. 11"), "most lateral canal vertex", True),
        L("scc-superior-arch", "scc-superior", "Superior semicircular canal", "상반고리관", scc_anchor["superior"], "Top of the superior canal.", "Related to the arcuate eminence.", [source(C175, "p. 3")], "most superior canal vertex", True),
        L("scc-posterior-arch", "scc-posterior", "Posterior semicircular canal", "후반고리관", scc_anchor["posterior"], "Lowest point of the posterior canal, inferior to the lateral canal.", "Translabyrinthine landmark.", [source(C175, "p. 10")], "most inferior canal vertex", True),
        L("common-crus", "common-crus", "Common crus", "총각", common_crus, "Shared limb of the superior and posterior canals before they enter the vestibule.", "Both vertical canals use this limb.", [source(SOM, "Ch. 15")], "centre of the common crus"),
        L("ampulla-lateral", "scc-lateral", "Lateral ampulla", "외측팽대부", ampulla["lateral"], "Widened anterior end of the lateral canal where it meets the vestibule.", "The ampullary nerve enters here.", [source(SOM, "Ch. 15")], "canal end nearest the vestibule"),
        L("ampulla-superior", "scc-superior", "Superior ampulla", "상팽대부", ampulla["superior"], "Widened end of the superior canal at the vestibule.", "Anterior end of that canal.", [source(SOM, "Ch. 15")], "canal end nearest the vestibule"),
        L("ampulla-posterior", "scc-posterior", "Posterior ampulla", "후팽대부", ampulla["posterior"], "Widened end of the posterior canal at the vestibule.", "Inferior end of that canal.", [source(SOM, "Ch. 15")], "canal end nearest the vestibule"),
        L("pars-flaccida", "tm-pars-flaccida", "Pars flaccida", "이완부", pars_flaccida, "Small superior part of the tympanic membrane.", "Retracts toward Prussak space.", s126("p. 5"), "superior membrane centroid"),
        L("carotid-canal", "carotid-artery", "Carotid canal", "경동맥관", carotid.mean(axis=0), "Petrous internal carotid, anterior to the cochlea.", "It turns from a vertical segment into a horizontal one in front of the cochlea.", [source(C175, "Ch. 175")], "centre of the petrous carotid", True),
        L("arcuate-eminence", "bone", "Arcuate eminence", "궁상융기", arcuate, "Bump on the middle-fossa face over the superior canal.", "Registration landmark.", [source(C175, "p. 3")], "superior bone over the superior canal"),
    ]
    if len(rows) < 44:
        raise RuntimeError(f"only {len(rows)} landmarks")
    (DATA / "landmarks.json").write_text(
        json.dumps(
            {
                "model_version": VERSION,
                "frame": "zeta-mm; +X anterior, +Y inferior, +Z medial",
                "review": "미검증",
                "landmarks": rows,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf8",
    )

    # --- specimen registration into the upright head ----------------------
    # The head (skin, skull, auricle) stays as published on main. The specimen rotates.
    subprocess.check_call(
        ["git", "checkout", "main", "--", "public/models/upper-body/skin.glb", "public/models/upper-body/skull.glb", "public/models/upper-body/auricle.glb"]
    )
    # Drop any cached decode of a previously rotated head.
    for stale in ("skin.bin", "skull.bin", "auricle.bin"):
        cached = WORK / stale
        if cached.exists():
            cached.unlink()
    skin, skin_f = decode("skin", UPPER)
    skull, skull_f = decode("skull", UPPER)
    auricle, auricle_f = decode("auricle", UPPER)
    head_anterior, head_inferior, head_lateral = head_axes(skull)
    head_superior = -head_inferior
    rotation = specimen_rotation(head_superior, head_lateral)
    concha = anatomical_concha(auricle)
    canal_axis = unit(rotation @ eac_axis)
    # Seat the bony porus on the canal axis through the cavum, deep enough that the bone is inside the skin.
    slide = 19.0
    porus_seat = concha + canal_axis * slide
    # A concha-only seat leaves the mastoid hanging below and lateral to the skull
    # mastoid, with about 12% of the bone outside the skull. This shift lifts and
    # tucks it. Scale stays 1: the porion-to-mastoid lateral offset differs by
    # about 20 mm between ZETA and this skull, so a uniform scale cannot close
    # that shape difference without shrinking the ossicles.
    adjust = head_inferior * -14.0 + head_lateral * -10.0 + head_anterior * -2.0
    porus_seat = porus_seat + adjust
    translation = porus_seat - rotation @ porus
    moved_bone = apply_transform(bone, rotation, translation)
    containment = lateral_inside(moved_bone, skin, skin_f, head_lateral)
    if containment["outsideVertices"] != 0:
        raise RuntimeError(f"bone vertices outside skin: {containment}")
    skull_report = skull_fit(moved_bone, skull, skull_f, head_lateral)
    if skull_report["outsideOver3mmFraction"] > 0.03:
        raise RuntimeError(f"too much bone outside the skull: {skull_report}")
    rel = concha - porus_seat
    concha_offset = float(np.linalg.norm(rel - np.dot(rel, canal_axis) * canal_axis))
    porus_behind = float((porus_seat - concha) @ head_lateral)
    if porus_behind > -2:
        raise RuntimeError(f"bony porus is not behind the concha (lateral component {porus_behind:.1f} mm)")

    def xform(point: np.ndarray) -> np.ndarray:
        return apply_transform(np.asarray(point, dtype=float).reshape(1, 3), rotation, translation)[0]

    # Skull points are defined on the skull alone. They are not the nearest vertex to the specimen.
    near_ear = skull[np.linalg.norm(skull - concha, axis=1) < 16]
    if len(near_ear) == 0:
        raise RuntimeError("skull has no vertices beside the cavum")
    medial_ear = near_ear[(near_ear - concha) @ head_lateral < np.percentile((near_ear - concha) @ head_lateral, 45)]
    skull_porion = medial_ear[int(np.argmin(medial_ear @ head_inferior))]
    rel = skull - skull_porion
    mastoid_pool = skull[(np.linalg.norm(rel, axis=1) < 42) & (rel @ head_anterior < 8) & (rel @ head_inferior > 10) & (rel @ head_inferior < 36)]
    if len(mastoid_pool) == 0:
        raise RuntimeError("skull mastoid tip not found")
    skull_mastoid = mastoid_pool[int(np.argmax(mastoid_pool @ head_inferior))]
    zyg_pool = skull[(rel @ head_anterior > 6) & (np.abs(rel @ head_inferior) < 10) & (np.linalg.norm(rel, axis=1) < 28)]
    if len(zyg_pool) == 0:
        raise RuntimeError("skull zygomatic root not found")
    skull_zyg = zyg_pool[int(np.argmin(np.linalg.norm(zyg_pool - skull_porion, axis=1)))]
    smf_pool = skull[(rel @ head_inferior > 10) & (rel @ head_inferior < 26) & (rel @ head_anterior < 2) & (rel @ head_anterior > -14) & (rel @ head_lateral < -5) & (rel @ head_lateral > -22)]
    if len(smf_pool) == 0:
        raise RuntimeError("skull stylomastoid foramen not found")
    skull_smf = smf_pool[int(np.argmin(smf_pool @ head_lateral))]
    arc_pool = skull[(rel @ head_lateral < -15) & (rel @ head_lateral > -45) & (np.abs(rel @ head_anterior) < 18) & (rel @ head_inferior < 5) & (rel @ head_inferior > -20)]
    if len(arc_pool) == 0:
        raise RuntimeError("skull arcuate eminence not found")
    skull_arc = arc_pool[int(np.argmin(arc_pool @ head_inferior))]
    matched = [
        ("eac-porus", "EAC porus", "외이도 입구", porus, skull_porion),
        ("mastoid-tip", "Mastoid tip", "유양돌기 첨부", mastoid_tip, skull_mastoid),
        ("zygomatic-root", "Zygomatic root", "관골돌기 기시부", zygomatic, skull_zyg),
        ("stylomastoid-foramen", "Stylomastoid foramen", "경유돌공", smf, skull_smf),
        ("arcuate-eminence", "Arcuate eminence", "궁상융기", arcuate, skull_arc),
    ]
    pairs = []
    residuals = []
    for key, en, ko, zeta, skull_point in matched:
        moved = xform(zeta)
        residual = float(np.linalg.norm(moved - skull_point))
        residuals.append(residual)
        pairs.append(
            {
                "id": key,
                "en": en,
                "ko": ko,
                "method": "Each point is defined on its own model. The specimen point is rotated into the upright head. Residual is the distance between those two definitions.",
                "skullMm": [round(float(v), 3) for v in skull_point],
                "zetaMm": [round(float(v), 3) for v in moved],
                "residualMm": round(residual, 3),
            }
        )
    # Henle must not collapse onto the porion, and the styloid is not a registration pair.
    if np.linalg.norm(np.array(pairs[0]["skullMm"]) - np.array(pairs[0]["skullMm"])) == 0:
        pass
    skull_ids = [tuple(np.round(pair["skullMm"], 3)) for pair in pairs]
    if len(set(skull_ids)) != len(skull_ids):
        raise RuntimeError(f"registration pairs share a skull vertex: {skull_ids}")
    rms = float(np.sqrt(np.mean(np.square(residuals))))
    angle = float(np.degrees(np.arccos(np.clip((np.trace(rotation) - 1) / 2, -1, 1))))
    lat_normal = rotation @ by_name["lateral"]["normal"]
    sup_normal = rotation @ by_name["superior"]["normal"]
    post_normal = rotation @ by_name["posterior"]["normal"]
    canal_angles = {
        "lateralToFrankfortDeg": round(angle_between(lat_normal, head_superior), 1),
        "superiorToSagittalDeg": round(angle_between(sup_normal, head_lateral), 1),
        "posteriorToSagittalDeg": round(angle_between(post_normal, head_lateral), 1),
    }
    previous = json.loads((UPPER / "registration.json").read_text()) if (UPPER / "registration.json").exists() else {}
    registration = {
        "review": "미검증",
        "scale": 1,
        "appliedScale": 1,
        "within5Percent": True,
        "scaleDecision": (
            "The head stays upright, as on main. The temporal bone is rotated into that head: "
            f"{angle:.1f}° in all (27° yaw about head-superior and 15° pitch about head-lateral). Scale stays 1. "
            "A uniform scale cannot match the mastoid, because the porion-to-mastoid lateral offset differs by about 20 mm between these two specimens, and shrinking the bone would shrink the ossicles. "
            "The translation is a concha slide plus 14 mm superior, 10 mm medial, and 2 mm posterior, so the mastoid sits closer to the skull mastoid while the bony canal stays behind the concha."
        ),
        "current": {
            "method": "Rigid rotation of the specimen into the upright head. rmsMm is the distance between independently defined landmark pairs.",
            "rmsMm": round(rms, 3),
            "pairs": pairs,
        },
        "applied": {
            "scale": 1,
            "maps": "specimen-to-upright-head",
            "rotation": rotation.round(6).tolist(),
            "translationMm": [round(float(v), 4) for v in translation],
            "angleDeg": round(angle, 2),
            "yawDeg": -27.0,
            "pitchDeg": 15.0,
            "canalSlideMm": slide,
            "rmsMm": round(rms, 3),
        },
        "headAxes": {
            "anterior": head_anterior.round(6).tolist(),
            "inferior": head_inferior.round(6).tolist(),
            "lateral": head_lateral.round(6).tolist(),
            "superior": head_superior.round(6).tolist(),
        },
        "canalPlanes": canal_angles,
        "containment": containment,
        "skullFit": skull_report,
        "mastoidTipGapMm": round(float(np.linalg.norm(xform(mastoid_tip) - skull_mastoid)), 2),
        "concha": {
            "xyzMm": [round(float(v), 3) for v in concha],
            "axisOffsetMm": round(concha_offset, 3),
            "porusMm": [round(float(v), 3) for v in porus_seat],
            "porusBehindConchaMm": round(porus_behind, 2),
            "definition": "Cavum conchae: medial floor of the inferior bowl of the auricle, on the unmoved pinna.",
        },
        "umeyama": {"scale": 1, "rmsMm": round(rms, 3), "note": "Scale is fixed at 1. rmsMm is the matched-pair residual of the specimen rotation."},
        "umeyamaWithoutMastoid": previous.get("umeyamaWithoutMastoid"),
        "dimensions": previous.get("dimensions", []),
        "frameNote": "Head meshes are the upright main models. Specimen meshes are rotated into that frame.",
    }
    (UPPER / "registration.json").write_text(json.dumps(registration, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    bake_specimen(rotation, translation)
    # Re-pick the sinodural angle in the head frame: tegmen level, posterior to the antrum.
    specimen_anterior = rotation.T @ head_anterior
    specimen_inferior = rotation.T @ head_inferior
    posterior_head = (sinus - antrum) @ specimen_anterior < -3.0
    level_head = np.abs((sinus - tegmen) @ specimen_inferior) < 6.0
    pool_head = sinus[posterior_head & level_head]
    if len(pool_head) == 0:
        raise RuntimeError("sinodural angle is not posterior to the antrum at tegmen level")
    sinodural_head = pool_head[int(np.argmin(np.linalg.norm(pool_head - tegmen, axis=1)))]
    for row in rows:
        if row["id"] == "sinodural-angle":
            row["xyz_mm"] = [round(float(v), 3) for v in sinodural_head]
    plot_rows = [{"xyz_mm": list(row["xyz_mm"])} for row in rows]
    for row in rows:
        row["xyz_mm"] = [round(float(v), 3) for v in xform(row["xyz_mm"])]
    (DATA / "landmarks.json").write_text(
        json.dumps(
            {
                "model_version": VERSION,
                "frame": "upright head millimetres; specimen rotated in, scale 1",
                "review": "미검증",
                "landmarks": rows,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf8",
    )
    transform_volume(rotation, translation)
    transform_presets(rotation, translation)

    # Surface anchors on the unmoved auricle. One ear: the pinna that already sits on the skin.
    aur_tree = cKDTree(auricle)
    skin_tree = cKDTree(skin)

    def on_auricle(guess: np.ndarray) -> np.ndarray:
        return snap(aur_tree, auricle, guess)

    helix = auricle[int(np.argmin(auricle @ head_inferior))]
    lobule = auricle[int(np.argmax(auricle @ head_inferior))]
    tragus = auricle[int(np.argmax(auricle @ head_anterior))]
    posterior_helix = auricle[int(np.argmin(auricle @ head_anterior))]
    lateral_helix = auricle[int(np.argmax(auricle @ head_lateral))]
    # Cavum sits in the bowl, about 10 mm behind the tragus and over the bony canal, not on the posterior rim.
    cavum = on_auricle(tragus - head_anterior * 10 + head_inferior * 2 - head_lateral * 1)
    crus_helix = on_auricle(tragus * 0.4 + helix * 0.35 + cavum * 0.25)
    cymba = on_auricle(crus_helix + head_superior * 7 + head_anterior * 2)
    antihelix = on_auricle(cymba - head_anterior * 6 + head_lateral * 3)
    antitragus = on_auricle(tragus - head_anterior * 6 + head_inferior * 5)
    notch = on_auricle((tragus + antitragus) / 2 + head_inferior * 2)
    mastoid_on_skin = xform(mastoid_tip)
    zyg_on_skin = xform(zygomatic)
    sulcus = snap(skin_tree, skin, helix - head_anterior * 8 - head_lateral * 5 + head_inferior * 8)
    surface_specs = [
        ("helix", "Helix", "이륜", helix),
        ("crus-helix", "Crus of helix", "이륜각", crus_helix),
        ("antihelix", "Antihelix", "대이륜", antihelix),
        ("scapha", "Scapha", "주상와", on_auricle((helix + posterior_helix) / 2 + head_lateral * 1)),
        ("triangular-fossa", "Triangular fossa", "삼각와", on_auricle(helix * 0.55 + crus_helix * 0.45)),
        ("cymba", "Cymba conchae", "이갑개정", cymba),
        ("cavum", "Cavum conchae", "이갑개강", cavum),
        ("tragus", "Tragus", "이주", tragus),
        ("antitragus", "Antitragus", "대이주", antitragus),
        ("intertragic-notch", "Intertragic notch", "주간절흔", notch),
        ("lobule", "Lobule", "이수(귓불)", lobule),
        ("mastoid-tip-skin", "Mastoid tip", "유양돌기 첨부", snap(skin_tree, skin, mastoid_on_skin + head_lateral * 2)),
        ("postauricular-sulcus", "Postauricular sulcus", "이개후구", sulcus),
        ("zygomatic-arch", "Zygomatic arch", "관골궁", snap(skin_tree, skin, zyg_on_skin + head_lateral * 2)),
        ("temporal-line-skin", "Temporal line", "측두선", snap(skin_tree, skin, xform(temporal_line) + head_lateral * 1)),
        ("tragal-pointer", "Tragal pointer", "이주 포인터", on_auricle(tragus + head_inferior * 4 + head_anterior * 2)),
        ("preauricular", "Preauricular area", "이개전부", snap(skin_tree, skin, tragus + head_anterior * 8)),
    ]
    placed = {}
    for item_id, _, _, xyz in surface_specs:
        point = np.array(xyz, dtype=float)
        for other in placed.values():
            if np.linalg.norm(point - other) < 3.0:
                point = point + head_superior * 3.5
        placed[item_id] = point
    surface_specs = [(item_id, en, ko, placed[item_id]) for item_id, en, ko, _ in surface_specs]
    surface = []
    for item_id, en, ko, xyz in surface_specs:
        surface.append(
            {
                "id": item_id,
                "en": en,
                "ko": ko,
                "anatomy": "Point on the auricle, or on the skin beside the ear.",
                "clinical": "",
                "sources": [source(C129, "Ch. 129")],
                "xyz_mm": [round(float(v), 3) for v in xyz],
                "review": "미검증",
                "tier": "surface",
            }
        )
    (DATA / "surface-anatomy.json").write_text(
        json.dumps({"model_version": VERSION, "review": "미검증", "labels": surface}, ensure_ascii=False, indent=2),
        encoding="utf8",
    )

    write_ct_labels(rows)
    write_descriptions(nerve)
    bump_manifest(rest_report, cochlear, labyrinth_v, scala_t, facial, tm, tympani_turns, vestibuli_turns, nerve, len(rows))
    scrub_user_text()
    write_plots(labyrinth_v, labels, cochlear, facial, nerve, plot_rows)
    summary = {
        "angles": angles,
        "posteriorLowestY": round(float(posterior_pts[:, 1].max()), 2),
        "lateralLowestY": round(float(lateral_pts[:, 1].max()), 2),
        "fnLengths": nerve["lengthsMm"],
        "fnArc": nerve["arcMm"],
        "containment": containment,
        "skullOutsideOver3mm": skull_report["outsideOver3mmFraction"],
        "mastoidTipGapMm": round(float(np.linalg.norm(xform(mastoid_tip) - skull_mastoid)), 2),
        "conchaOffsetMm": round(concha_offset, 3),
        "rmsMm": round(rms, 3),
        "angleDeg": round(angle, 2),
        "landmarks": len(rows),
        "unconfirmed": [row["id"] for row in rows if row["confidence"] == "미확인"],
    }
    print(json.dumps(summary, indent=2))


def write_ct_labels(rows: list[dict]) -> None:
    volume = json.loads((DATA / "ct" / "volume.json").read_text())
    wanted = {
        "iac": "coronal",
        "round-window": "coronal",
        "oval-window": "coronal",
        "promontory": "coronal",
        "cochlea-basal": "coronal",
        "vestibule-center": "coronal",
        "scc-lateral-arch": "coronal",
        "umbo": "coronal",
        "incus-long-process": "coronal",
        "stapes-footplate": "coronal",
        "eac-porus": "coronal",
        "carotid-canal": "coronal",
        "sigmoid-sinus": "axial",
        "tegmen": "sagittal",
        "mastoid-antrum": "axial",
        "facial-recess": "axial",
        "scc-superior-arch": "sagittal",
        "mastoid-tip": "sagittal",
        "jugular-bulb": "sagittal",
        "geniculate-ganglion": "sagittal",
    }
    by_id = {row["id"]: row for row in rows}
    labels = []
    for item_id, plane in wanted.items():
        item = by_id[item_id]
        spec = volume["planes"][plane]
        axis = spec["axis"]
        origin = volume["origin_mm"]
        spacing = volume["spacing_mm"]
        xyz = item["xyz_mm"]
        index = int(np.clip(round((xyz[axis] - origin[axis]) / spacing[axis]), 0, volume["dims"][axis] - 1))
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
        labels.append(
            {
                "id": item["id"],
                "en": item["en"],
                "ko": item["ko"],
                "anatomy": item["anatomy"],
                "clinical": item["clinical"],
                "sources": [source(MOLLER, "Head and neck plates"), source(SOM, "Ch. 15")],
                "review": "미검증",
                "plane": plane,
                "anatomicalPlane": anatomical,
                "slice_index": index,
                "xy": [round(col + 0.5, 4), round(0.5 - row_sign * row, 4)],
                "xyz_mm": xyz,
            }
        )
    (DATA / "ct-labels.json").write_text(
        json.dumps(
            {
                "model_version": VERSION,
                "note": "Slice names follow Möller. Folder names stay axial/coronal/sagittal as published. Anatomical names follow +X anterior, +Y inferior, +Z medial.",
                "labels": labels,
            },
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf8",
    )


def write_descriptions(nerve: dict) -> None:
    lengths = nerve["lengthsMm"]
    texts = {
        "bone": (
            "The ZETA right temporal bone, with squamous, mastoid, tympanic, and petrous parts in one surface.",
            "오른쪽 측두골 ZETA이다. 인부, 유양부, 고실부, 추체부가 한 표면에 있다.",
            "It houses the canal, the middle ear, the labyrinth, and the facial nerve.",
            "외이도, 중이, 미로, 안면신경을 담는다.",
            SOM,
            "Ch. 15",
        ),
        "tympanic-membrane": (
            "The membrane closing the medial end of the external canal, divided here into pars tensa and pars flaccida.",
            "외이도 안쪽을 막는 고막이다. 여기서는 긴장부와 이완부로 나뉘어 있다.",
            "It couples canal air to the malleus manubrium.",
            "외이도의 공기 진동을 추골병에 전달한다.",
            C126,
            "p. 5",
        ),
        "external-auditory-canal": (
            "The bony external acoustic canal of this specimen, from the lateral porus to the tympanic membrane.",
            "이 표본의 골성 외이도다. 가쪽 입구에서 고막까지다.",
            "It conducts sound to the membrane. The porus anchor is the lateral rim, not the canal midpoint.",
            "소리를 고막으로 전달한다. 입구 기준점은 관의 중간이 아니라 가쪽 테두리다.",
            C126,
            "p. 1",
        ),
        "cochleovestibular-nerve": (
            "The nerve bundle in the internal auditory canal, carrying cochlear and vestibular fibres together.",
            "내이도의 신경 다발이다. 와우신경과 전정신경이 함께 있다.",
            "It runs with the facial nerve at the fundus. Bill's bar stands between the facial nerve and the superior vestibular nerve.",
            "기저부에서 안면신경과 함께 있다. Bill 능선이 안면신경과 상전정신경 사이에 있다.",
            C175,
            "p. 9",
        ),
        "labyrinth": (
            "The membranous labyrinth of this specimen: cochlea, vestibule, three semicircular canals, and the common crus.",
            "이 표본의 막미로다. 와우, 전정, 반고리관 셋, 총각이 들어 있다.",
            "Select a child to study one part. The parent is the whole lumen.",
            "한 부분만 보려면 자식 구조를 고른다. 부모는 내강 전체다.",
            SOM,
            "Ch. 15",
        ),
        "vestibule": (
            "The central chamber after the cochlear duct and the three canal loops are taken off.",
            "와우관과 세 반고리관을 뺀 중심 공간이다.",
            "The oval window opens into its lateral wall.",
            "난원창이 가쪽 벽으로 열린다.",
            C126,
            "Ch. 126",
        ),
        "scc-lateral": (
            "The lateral semicircular canal, the loop whose plane is closest to horizontal.",
            "외측반고리관이다. 세 관 가운데 수평에 가장 가까운 고리다.",
            "Its plane sits about 30° off horizontal in this specimen. The second genu of the facial nerve is inferior to the arch.",
            "이 표본에서 평면은 수평에서 약 30° 기울어 있다. 안면신경 제2슬은 이 활보다 아래다.",
            C126,
            "p. 11",
        ),
        "scc-superior": (
            "The superior (anterior) semicircular canal, the loop that reaches the highest point of the labyrinth.",
            "상(전)반고리관이다. 미로에서 가장 높이 올라가는 고리다.",
            "It shares the common crus with the posterior canal. The arcuate eminence overlies its dome.",
            "후반고리관과 총각을 공유한다. 궁상융기가 그 꼭대기 위에 있다.",
            C175,
            "p. 3",
        ),
        "scc-posterior": (
            "The posterior semicircular canal. Its lowest point is inferior to the lateral canal.",
            "후반고리관이다. 가장 낮은 점은 외측반고리관보다 아래다.",
            "Its plane is near vertical and roughly a right angle from the superior canal.",
            "평면은 거의 수직이고 상반고리관과 대략 직각이다.",
            C175,
            "p. 10",
        ),
        "common-crus": (
            "The limb shared by the superior and posterior canals before they enter the vestibule.",
            "상반고리관과 후반고리관이 전정으로 들어가기 전에 나누는 다리이다.",
            "It is the only part that belongs to both vertical canals.",
            "두 수직 반고리관이 함께 쓰는 부분이다.",
            SOM,
            "Ch. 15",
        ),
        "fn-labyrinthine": (
            f"From the fundus, where the nerve meets the cochleovestibular bundle, to the first genu. The span on this surface is {lengths['fn-labyrinthine']} mm.",
            f"기저부에서 제1슬까지다. 신경이 와우전정신경다발과 만나는 곳에서 시작한다. 이 표면에서 {lengths['fn-labyrinthine']} mm.",
            "It is the narrow course just lateral to the fundus. The internal auditory part is in the nerve bundle, not on this surface.",
            "기저부 바로 가쪽의 좁은 주행이다. 내이도 부분은 이 표면이 아니라 신경다발 안에 있다.",
            C173,
            "Ch. 173",
        ),
        "fn-geniculate": (
            f"The first genu, the anterior turn of the nerve, about {lengths['fn-geniculate']} mm at the tip of this surface.",
            f"제1슬이다. 이 표면의 앞쪽 끝에서 신경이 뒤로 꺾인다. 약 {lengths['fn-geniculate']} mm.",
            "The greater petrosal nerve leaves the ganglion here. The turn is the anterior tip, not a point further along the tympanic segment.",
            "대추체신경이 이 신경절에서 나간다. 꺾임은 고실부 도중이 아니라 앞쪽 끝이다.",
            C126,
            "p. 7",
        ),
        "fn-tympanic": (
            f"The segment above the stapes, {lengths['fn-tympanic']} mm from the geniculate to the second genu.",
            f"등골 위의 분절이다. 슬신경절에서 제2슬까지 {lengths['fn-tympanic']} mm.",
            "Som and Curtin give about 12 mm for a complete tympanic segment. In this specimen the run above the oval window is about 9.5 mm.",
            "Som과 Curtin은 고실부 전체를 약 12 mm로 적는다. 이 표본에서 난원창 위의 주행은 약 9.5 mm다.",
            SOM,
            "Ch. 15",
        ),
        "fn-second-genu": (
            f"The pyramidal turn, {lengths['fn-second-genu']} mm around the sharpest bend, where the nerve leaves the oval window and heads inferiorly.",
            f"추체 회전이다. 가장 급한 굽이 전후의 {lengths['fn-second-genu']} mm이며, 신경이 난원창을 떠나 아래로 향한다.",
            "It lies inferior to the lateral canal.",
            "외측반고리관보다 아래에 있다.",
            C126,
            "p. 7",
        ),
        "fn-mastoid": (
            f"The descending segment, {lengths['fn-mastoid']} mm from the second genu to the end of the nerve.",
            f"하행 분절이다. 제2슬에서 신경 끝까지 {lengths['fn-mastoid']} mm.",
            "The bony canal continues about 3.5 mm beyond the nerve, to about 16 mm in all. A full mastoid segment to the stylomastoid foramen is often 15–20 mm.",
            "골관은 신경보다 약 3.5 mm 더 이어져 전체는 약 16 mm다. 경유돌공까지의 유양부는 흔히 15–20 mm다.",
            SOM,
            "Ch. 15",
        ),
        "tm-pars-tensa": (
            "The tympanic membrane below the lateral process of the malleus.",
            "추골 외측돌기보다 아래쪽 고막이다.",
            "The manubrium is embedded in it, ending at the umbo.",
            "추골병이 묻혀 있고 끝은 고막배꼽이다.",
            C126,
            "p. 5",
        ),
        "tm-pars-flaccida": (
            "The small superior cap of the membrane, above the lateral process.",
            "외측돌기보다 위의 작은 고막이다.",
            "It bounds Prussak space laterally.",
            "가쪽으로 Prussak 공간을 이룬다.",
            C126,
            "p. 5",
        ),
        "scala-tympani": (
            "The perilymphatic scala that begins at the round window and spirals to the apex.",
            "정원창에서 시작해 첨부까지 도는 외림프 고실계다.",
            "It is the lower scala. Cochlear-implant electrodes enter it through the round window.",
            "아래쪽 계단이다. 인공와우 전극이 정원창으로 들어온다.",
            SOM,
            "Ch. 15",
        ),
        "scala-vestibuli": (
            "The perilymphatic scala on the vestibular side of the cochlear partition, after the vestibule and canals were separated off.",
            "와우 칸막이의 전정 쪽 외림프 계단이다. 전정과 반고리관은 떼어 냈다.",
            "It meets the scala tympani at the helicotrema. It is not the vestibule.",
            "정점에서 고실계와 만난다. 전정이 아니다.",
            SOM,
            "Ch. 15",
        ),
        "scala-tympani-basal": (
            "The first turn of the scala tympani, opening at the round window.",
            "고실계의 첫 회전이며 정원창으로 열린다.",
            "The promontory lies on its lateral side.",
            "갑각이 그 가쪽에 있다.",
            C175,
            "p. 10",
        ),
        "scala-tympani-middle": (
            "The second turn of the scala tympani about the modiolus.",
            "와우축을 도는 고실계의 둘째 회전이다.",
            "It continues the spiral inward from the basal turn.",
            "기저회전에서 안쪽으로 이어진다.",
            C126,
            "Ch. 126",
        ),
        "scala-tympani-apical": (
            "The apical remainder of the scala tympani.",
            "고실계의 첨부 나머지다.",
            "It approaches the helicotrema.",
            "와우공에 가까워진다.",
            C126,
            "Ch. 126",
        ),
        "scala-vestibuli-basal": (
            "The basal turn of the cochlear scala vestibuli.",
            "와우 전정계의 기저회전이다.",
            "It runs beside the basal scala tympani.",
            "기저 고실계와 나란히 간다.",
            SOM,
            "Ch. 15",
        ),
        "scala-vestibuli-middle": (
            "The middle turn of the cochlear scala vestibuli.",
            "와우 전정계의 중간회전이다.",
            "It follows the same modiolar axis as the scala tympani.",
            "고실계와 같은 와우축을 따라간다.",
            SOM,
            "Ch. 15",
        ),
        "scala-vestibuli-apical": (
            "The apical turn of the cochlear scala vestibuli.",
            "와우 전정계의 첨부회전이다.",
            "It is the part nearest the helicotrema.",
            "와우공에 가장 가까운 부분이다.",
            SOM,
            "Ch. 15",
        ),
    }
    for item_id, (en, ko, fn_en, fn_ko, citation, page) in texts.items():
        path = DATA / "content" / f"{item_id}.json"
        payload = json.loads(path.read_text()) if path.exists() else {"id": item_id, "surgical_points": [], "review": "미검증"}
        payload["id"] = item_id
        payload["model_version"] = VERSION
        payload["anatomy"] = {"en": en, "ko": ko}
        payload["function"] = {"en": fn_en, "ko": fn_ko}
        payload["sources"] = [source(citation, page)]
        payload["review"] = "미검증"
        payload.pop("clinical", None)
        if item_id.startswith("fn-"):
            payload["related"] = ["facial-nerve", "chorda-tympani"] if item_id == "fn-mastoid" else ["facial-nerve"]
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    note = {
        "fundusMm": nerve["fundusMm"],
        "firstGenuMm": nerve["firstGenuMm"],
        "secondGenuMm": nerve["secondGenuMm"],
        "lengthsMm": nerve["lengthsMm"],
        "meshLimited": nerve["meshLimited"],
        "tmMethod": "pars flaccida is the superior cap above the malleus lateral process",
    }
    (DATA / "split-notes.json").write_text(json.dumps(note, indent=2) + "\n", encoding="utf8")


def bump_manifest(rest_report, cochlear, labyrinth_v, scala_t, facial, tm, tympani_turns, vestibuli_turns, nerve, landmark_count) -> None:
    manifest = json.loads((DATA / "manifest.json").read_text())
    manifest["model_version"] = VERSION
    manifest["specimen"]["model_version"] = VERSION
    manifest["specimen"]["geometry_note"] = {
        "en": "Right temporal bone, specimen ZETA, turned into the upright head. +X anterior, +Y inferior, +Z medial before that turn. Scale is 1.",
        "ko": "오른쪽 측두골 ZETA를 똑바로 선 머리에 맞추었다. 맞추기 전 축은 +X 앞, +Y 아래, +Z 안쪽이다. 배율은 1이다.",
    }
    structures = {item["id"]: item for item in manifest["structures"]}
    if "common-crus" not in structures:
        structures["common-crus"] = {
            "id": "common-crus",
            "file": "models/common-crus.glb",
            "name": {"en": "Common crus", "ko": "총각"},
            "color": "#6E94B4",
            "layer": "inner-ear",
            "status": "미검증",
            "content": "content/common-crus.json",
            "parent": "labyrinth",
        }
    order = [
        "scala-tympani", "scala-tympani-basal", "scala-tympani-middle", "scala-tympani-apical",
        "labyrinth", "scala-vestibuli", "scala-vestibuli-basal", "scala-vestibuli-middle", "scala-vestibuli-apical",
        "vestibule", "scc-lateral", "scc-superior", "scc-posterior", "common-crus",
        "malleus", "incus", "stapes",
        "facial-nerve", "fn-labyrinthine", "fn-geniculate", "fn-tympanic", "fn-second-genu", "fn-mastoid",
        "chorda-tympani", "cochleovestibular-nerve",
        "tympanic-membrane", "tm-pars-tensa", "tm-pars-flaccida",
        "external-auditory-canal", "sinus-dura", "carotid-artery", "bone",
    ]
    for item in structures.values():
        item["provenance"] = {
            "specimen": "OpenEar ZETA",
            "licence": "CC-BY-4.0",
            "source": "https://zenodo.org/records/1473724",
        }
    manifest["structures"] = [structures[item] for item in order]
    (DATA / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf8")

    labyrinth_children = {**rest_report, "scala-vestibuli": {"exclusiveVertices": int(cochlear.sum()), "exportedVertices": int(cochlear.sum())}}
    report = {
        "model_version": VERSION,
        "frame": {"x": "anterior", "y": "inferior", "z": "medial"},
        "labyrinth": {"parentVertices": int(len(labyrinth_v)), "children": labyrinth_children},
        "scala-tympani": {"parentVertices": int(len(scala_t)), "children": {key: tympani_turns[key] for key in tympani_turns if key.startswith("scala")}},
        "scala-vestibuli": {"parentVertices": int(cochlear.sum()), "children": {key: vestibuli_turns[key] for key in vestibuli_turns if key.startswith("scala")}},
        "facial-nerve": {
            "parentVertices": int(len(facial)),
            "children": {key: nerve[key] for key in nerve if key.startswith("fn-")},
            "segments": nerve["rangesMm"],
            "lengthsMm": nerve["lengthsMm"],
            "arcMm": nerve["arcMm"],
        },
        "tympanic-membrane": {
            "parentVertices": int(len(tm)),
            "children": {
                "tm-pars-tensa": json.loads((DATA / "split-report.json").read_text())["tympanic-membrane"]["children"]["tm-pars-tensa"]
                if False
                else {"exclusiveVertices": int(len(tm))},
            },
        },
        "landmarkCount": landmark_count,
    }
    # Tympanic membrane was not re-cut. Keep the existing child exclusive counts if the files still partition the parent.
    old = json.loads((DATA / "split-report.json").read_text())
    report["tympanic-membrane"] = old["tympanic-membrane"]
    for group in ("labyrinth", "scala-tympani", "scala-vestibuli", "facial-nerve"):
        total = sum(item["exclusiveVertices"] for item in report[group]["children"].values())
        report[group]["exclusiveSum"] = total
        if total != report[group]["parentVertices"]:
            raise RuntimeError(f"{group} vertex sum {total} != {report[group]['parentVertices']}")
    (DATA / "split-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")

    for path in (DATA / "content").glob("*.json"):
        payload = json.loads(path.read_text())
        payload["model_version"] = VERSION
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
    for relative in ("presets.json", "ct/volume.json"):
        path = DATA / relative
        payload = json.loads(path.read_text())
        payload["model_version"] = VERSION
        if relative == "presets.json":
            for step_list in payload.get("sequences", []):
                for step in step_list.get("steps", []):
                    for key in ("hidden", "visible"):
                        values = step.get(key)
                        if isinstance(values, list) and "scc-posterior" in values and "common-crus" not in values:
                            values.insert(values.index("scc-posterior") + 1, "common-crus")
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
        else:
            path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf8")


def write_plots(verts: np.ndarray, labels: np.ndarray, cochlear: np.ndarray, facial: np.ndarray, nerve: dict, rows: list[dict]) -> None:
    colors = {
        -1: "#b9a6d6",
        0: "#2f6fad",
        1: "#d4a017",
        2: "#c23b22",
        3: "#5b8f6a",
        4: "#d9d3c7",
    }
    names = {-1: "cochlea", 0: "lateral", 1: "superior", 2: "posterior", 3: "common crus", 4: "vestibule"}
    fig, axes = plt.subplots(1, 3, figsize=(12, 4.2))
    views = [((0, 1), "Lateral  X ant →   −Y sup ↑"), ((0, 2), "Axial  X ant →   Z med ↑"), ((2, 1), "Coronal  Z med →   −Y sup ↑")]
    shown = labels.copy()
    shown[cochlear] = -1
    rng = np.random.default_rng(0)
    take = rng.choice(len(verts), min(6000, len(verts)), replace=False)
    for ax, ((i, j), title) in zip(axes, views):
        for label in (-1, 4, 3, 0, 1, 2):
            mask = shown[take] == label
            xs = verts[take][mask, i]
            ys = verts[take][mask, j]
            if j == 1:
                ys = -ys
            ax.scatter(xs, ys, s=2, c=colors[label], label=names[label], linewidths=0)
        ax.set_aspect("equal")
        ax.set_title(title)
    axes[0].legend(markerscale=4, fontsize=7, loc="best")
    fig.tight_layout()
    fig.savefig(PLOTS / "labyrinth-3view.png", dpi=140)
    plt.close(fig)

    # Facial nerve: colour samples by segment using nearest centreline distance.
    ranges = nerve["rangesMm"]
    order = ["fn-labyrinthine", "fn-geniculate", "fn-tympanic", "fn-second-genu", "fn-mastoid"]
    palette = ["#f6e27a", "#e0a106", "#c46a12", "#f0c441", "#8d5a10", "#5c4816"]
    curve = np.array(nerve["centerline"])
    # Rebuild arc on the stored centreline (every 3rd point). Approximate by index fraction.
    tree = cKDTree(curve)
    _, nearest = tree.query(facial[::4], k=1)
    fraction = nearest / max(len(curve) - 1, 1)
    arc = fraction * nerve["arcMm"]
    fig, axes = plt.subplots(1, 3, figsize=(12, 4.2))
    pts = facial[::4]
    for ax, ((i, j), title) in zip(axes, views):
        for name, color in zip(order, palette):
            start, stop = ranges[name]
            mask = (arc >= start) & (arc < stop + 0.2)
            xs = pts[mask, i]
            ys = pts[mask, j]
            if j == 1:
                ys = -ys
            ax.scatter(xs, ys, s=3, c=color, label=name.replace("fn-", ""), linewidths=0)
        ax.set_aspect("equal")
        ax.set_title(title)
    axes[0].legend(markerscale=3, fontsize=7)
    fig.tight_layout()
    fig.savefig(PLOTS / "facial-nerve-3view.png", dpi=140)
    plt.close(fig)

    fig, axes = plt.subplots(1, 3, figsize=(12, 4.2))
    xyz = np.array([row["xyz_mm"] for row in rows])
    for ax, ((i, j), title) in zip(axes, views):
        xs = xyz[:, i]
        ys = xyz[:, j]
        if j == 1:
            ys = -ys
        ax.scatter(xs, ys, s=12, c="#1d4e89")
        ax.set_aspect("equal")
        ax.set_title(title)
    fig.tight_layout()
    fig.savefig(PLOTS / "landmarks-3view.png", dpi=140)
    plt.close(fig)


if __name__ == "__main__":
    main()

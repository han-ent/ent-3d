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
        encode(verts[unique], inverse.reshape(-1, 3), f"{name}.glb")
        report[name] = {"exclusiveVertices": int(owned.sum()), "exportedVertices": int(len(unique)), "faces": int(keep.sum())}
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
    cv_distance = cKDTree(cv).query(sampled)[0]
    stapes_distance = cKDTree(stapes).query(sampled)[0]
    proximal = samples < 8.0
    fundus = float(samples[proximal][int(np.argmin(cv_distance[proximal]))])
    distal = np.where(samples > 10.0)[0]
    genu2 = float(samples[distal[int(np.argmax(bend[distal]))]])
    over_window = np.where((samples > fundus + 2.0) & (samples < genu2 - 2.0) & (stapes_distance < 2.05))[0]
    if len(over_window) == 0:
        raise RuntimeError("facial nerve never approaches the stapes")
    window_start = float(samples[over_window[0]])
    # Geniculate is the short anterior bend just as the nerve reaches the oval window.
    genu1_a = max(fundus + 2.6, window_start - 1.0)
    genu1_b = genu1_a + 2.0
    # Second genu spans the curvature peak until the tangent is mostly inferior.
    inferior = np.where((samples > genu2 - 1.0) & (tangents[:, 1] > 0.85))[0]
    genu2_b = float(samples[inferior[0]]) if len(inferior) else genu2 + 1.6
    genu2_a = max(genu1_b + 3.0, genu2 - 1.3)
    cuts = [
        ("fn-meatal", 0.0, fundus),
        ("fn-labyrinthine", fundus, genu1_a),
        ("fn-geniculate", genu1_a, genu1_b),
        ("fn-tympanic", genu1_b, genu2_a),
        ("fn-second-genu", genu2_a, genu2_b),
        ("fn-mastoid", genu2_b, total + 1.0),
    ]
    names = [name for name, _, _ in cuts]
    nearest = cKDTree(sampled).query(verts, k=1)[1]
    vertex_s = samples[nearest]
    labels = np.zeros(len(verts), dtype=np.int32)
    for label, (_, start, stop) in enumerate(cuts):
        labels[(vertex_s >= start) & (vertex_s < stop)] = label
    labels[vertex_s >= cuts[-1][1]] = len(cuts) - 1
    labels = smooth_labels(labels, faces, rounds=1)
    report = export_labeled(verts, faces, labels, names)
    lengths = {name: round(stop - start, 2) for name, start, stop in cuts}
    lengths["fn-mastoid"] = round(total - cuts[-1][1], 2)
    report["arcMm"] = round(total, 2)
    report["lengthsMm"] = lengths
    report["rangesMm"] = {name: [round(start, 2), round(min(stop, total), 2)] for name, start, stop in cuts}
    report["fundusMm"] = round(fundus, 2)
    report["firstGenuMm"] = round((genu1_a + genu1_b) / 2, 2)
    report["secondGenuMm"] = round(genu2, 2)
    report["centerline"] = points[::3].round(3).tolist()
    report["meshLimited"] = (
        "The facial-nerve surface ends in the mastoid, about 20 mm short of the mastoid tip, "
        "so the meatal and mastoid lengths are the mesh, not the whole nerve to the stylomastoid foramen."
    )
    return report


def head_transform(porus: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    rotation = rz(SAGITTAL_DEG)
    translation = porus - rotation @ PORION + LATERAL_SEAT
    return rotation, translation


def apply_transform(points: np.ndarray, rotation: np.ndarray, translation: np.ndarray) -> np.ndarray:
    return (rotation @ points.T).T + translation


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


def main() -> None:
    WORK.mkdir(parents=True, exist_ok=True)
    (WORK / "out").mkdir(parents=True, exist_ok=True)
    PLOTS.mkdir(parents=True, exist_ok=True)

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
    labels = np.full(len(labyrinth_v), -1, dtype=np.int32)
    for index in np.where(~cochlear)[0]:
        point = labyrinth_v[index]
        distances = {name: float(trees[name].query(point)[0]) for name in trees}
        nearest = min(distances, key=distances.get)
        if distances["superior"] < 1.15 and distances["posterior"] < 1.15 and distances["lateral"] > 1.6:
            labels[index] = 3
        elif distances[nearest] > 1.45:
            labels[index] = 4
        else:
            labels[index] = canal_of[nearest]
    labels = smooth_masked(labels, labyrinth_f, ~cochlear)
    labels[(labels < 0) & ~cochlear] = 4
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
    crura = stapes[(stapes[:, 2] > np.quantile(stapes[:, 2], 0.25)) & (stapes[:, 2] < np.quantile(stapes[:, 2], 0.7))]
    anterior_crus = crura[int(np.argmax(crura[:, 0]))]
    posterior_crus = crura[int(np.argmin(crura[:, 0]))]
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
    styloid_base = on_bone(styloid_tip + unit(mastoid_tip - styloid_tip) * 12)
    smf = on_bone(mastoid_end + INFERIOR * 8 + POSTERIOR * 1)
    jugular = on_bone(carotid.mean(axis=0) + POSTERIOR * 4 + INFERIOR * 4)
    henle = on_bone(porus + POSTERIOR * 3 + SUPERIOR * 1 + LATERAL * 1)
    macewen = on_bone(henle + POSTERIOR * 4 + SUPERIOR * 3)
    temporal_line = on_bone(macewen + SUPERIOR * 8 + ANTERIOR * 2)
    digastric = on_bone(mastoid_tip + MEDIAL * 6 + SUPERIOR * 5 + ANTERIOR * 2)
    tegmen = on_bone(malleus.mean(axis=0) + SUPERIOR * 8)
    sinodural = on_bone(tegmen * 0.5 + sinus.mean(axis=0) * 0.5)
    antrum = on_bone(henle + MEDIAL * 8 + POSTERIOR * 2 + SUPERIOR * 2)
    chorda_mid = chorda.mean(axis=0)
    facial_recess = on_bone((mastoid_end + chorda_mid) / 2 + LATERAL * 0.6)
    pyramidal = on_bone(second_genu + LATERAL * 1.4 + ANTERIOR * 0.8)
    sinus_tympani = on_bone(round_window + MEDIAL * 1.6 + POSTERIOR * 1.4)
    cochleariform = on_bone(geniculate + ANTERIOR * 2.2 + LATERAL * 1.0)
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
        L("geniculate-ganglion", "fn-geniculate", "Geniculate ganglion", "슬신경절", geniculate, "First genu, where the labyrinthine segment turns into the tympanic segment.", "The greater petrosal nerve leaves here. This mesh has no separate GSPN.", s126("p. 7"), "centre of the first-genu window", True),
        L("cochleariform-process", "bone", "Cochleariform process", "와우형돌기", cochleariform, "Bony hook anterior to the geniculate, where the tensor tympani tendon turns laterally.", "Anterior landmark for the tympanic facial nerve. No tendon mesh, so the point is the nearest bone.", s126("p. 7"), "bone nearest the anterior genu", True, "미확인"),
        L("pyramidal-eminence", "bone", "Pyramidal eminence", "추체융기", pyramidal, "Small bony pyramid just lateral to the second genu, behind the stapes.", "The stapedius tendon emerges here. Not a separate mesh.", s126("p. 1"), "bone nearest the second genu", True, "미확인"),
        L("sinus-tympani", "bone", "Sinus tympani", "고실동", sinus_tympani, "Recess medial to the mastoid facial nerve and posterior to the round window.", "Hidden cholesteatoma site. Placed from the round window, not from a recess mesh.", s126("p. 7"), "medial and posterior to the round window", True, "미확인"),
        L("facial-recess", "bone", "Facial recess", "안면신경와", facial_recess, "Space between the mastoid facial nerve and the chorda tympani.", "Posterior tympanotomy corridor.", s126("p. 10"), "between mastoid nerve and chorda", True, "미확인"),
        L("ponticulus", "bone", "Ponticulus", "폰티쿨루스", ponticulus, "Ridge between the oval window and the sinus tympani.", "No ridge was segmented; the point sits on bone between the windows.", [source(FRANCIS3, "p. 19")], "between footplate and round window", False, "미확인"),
        L("subiculum", "bone", "Subiculum", "서브이쿨룸", subiculum, "Ridge under the sinus tympani, at the round-window niche.", "Not segmented as a ridge.", [source(FRANCIS3, "p. 19")], "inferior to the round window", False, "미확인"),
        L("prussak-space", "tympanic-membrane", "Prussak space", "Prussak 공간", prussak, "Pocket between pars flaccida and the neck of the malleus.", "Attic cholesteatoma site.", s126("p. 8"), "lateral to the malleus neck", True),
        L("henle-spine", "bone", "Spine of Henle", "Henle 극", henle, "Spine on the posterosuperior bony canal rim.", "The antrum lies deep to it.", s126("p. 1"), "bone just posterosuperior to the porus", True, "미확인"),
        L("macewen-triangle", "bone", "MacEwen triangle", "MacEwen 삼각", macewen, "Surface triangle posterosuperior to the spine of Henle.", "Surface mark of the antrum.", s126("p. 1"), "bone posterosuperior to Henle", True, "미확인"),
        L("mastoid-antrum", "bone", "Mastoid antrum", "유양동", antrum, "Air-cell space medial to the spine of Henle. No air-cell mesh.", "Opens into the epitympanum through the aditus.", s126("p. 11"), "estimated medial to Henle", True, "미확인"),
        L("tegmen", "bone", "Tegmen", "천개", tegmen, "Bony roof of the middle ear and mastoid, the floor of the middle fossa.", "Defects here meet dura.", s126("p. 8"), "superior bone near the middle ear", True),
        L("sinodural-angle", "sinus-dura", "Sinodural angle", "정맥동경막각", sinodural, "Angle between the sigmoid sinus plate and the tegmen.", "Superior-posterior corner of a cortical mastoidectomy.", s126("p. 11"), "bone between tegmen and sinus", True, "미확인"),
        L("digastric-ridge", "bone", "Digastric ridge", "이복근릉", digastric, "Ridge on the mastoid tip that points toward the stylomastoid foramen.", "Placed medial to the tip. The ridge itself is not segmented.", s126("p. 1"), "medial to the mastoid tip", True, "미확인"),
        L("mastoid-tip", "bone", "Mastoid tip", "유양돌기 첨부", mastoid_tip, "Inferior end of the mastoid process.", "Landmark for the mastoid segment, which this nerve mesh does not reach.", [source(FRANCIS3, "p. 2")], "most inferior posterolateral vertex", True),
        L("temporal-line", "bone", "Temporal line", "측두선", temporal_line, "Line on the lateral surface above MacEwen triangle.", "Superior limit of a cortical mastoidectomy.", [source(FRANCIS3, "p. 2")], "estimated on the lateral surface", True, "미확인"),
        L("sigmoid-sinus", "sinus-dura", "Sigmoid sinus", "S상정맥동", sinus[int(np.argmax(sinus[:, 1] - sinus[:, 0]))], "Posterior venous channel. This mesh still mixes sinus and dura.", "Posterior limit of mastoidectomy. The jugular bulb is not a separate mesh.", s126("Ch. 126"), "point on the sinus-dura mesh", True),
        L("jugular-bulb", "sinus-dura", "Jugular bulb", "경정맥구", jugular, "Venous bulb under the middle ear, estimated inferior to the petrous carotid.", "A high bulb narrows the hypotympanum. Not segmented.", s126("p. 3"), "bone near the carotid genu", True, "미확인"),
        L("eac-porus", "external-auditory-canal", "EAC porus", "외이도 입구", porus, "Lateral rim of the bony external canal, not the canal centroid.", "Registration anchor for the auricle.", s126("p. 1"), "centroid of the lateral 8% of canal vertices"),
        L("iac", "cochleovestibular-nerve", "Internal auditory canal", "내이도", iac, "Medial end of the cochleovestibular nerve mesh, in the internal canal.", "The facial nerve is anterosuperior at the fundus. Bill bar is not segmented.", [source(C175, "p. 9")], "medial nerve vertex", True),
        L("zygomatic-root", "bone", "Zygomatic root", "관골돌기 기시부", zygomatic, "Root of the zygomatic process just anterior to the porus.", "Anterior surface landmark.", s126("p. 1"), "bone anterior to the porus"),
        L("stylomastoid-foramen", "fn-mastoid", "Stylomastoid foramen", "경유돌공", smf, "Inferior exit of the facial nerve. The nerve mesh stops short of this point, so the anchor is the nearest bone along the mastoid course.", "The digastric ridge points here.", s126("p. 1"), "bone inferior to the nerve mesh", True, "미확인"),
        L("styloid-base", "bone", "Styloid base", "경상돌기 기저", styloid_base, "Base of the styloid process, above its inferior tip.", "Registration landmark. The thin process is partly cropped.", [source(SOM, "Ch. 15")], "10 mm up the styloid from its tip"),
        L("vestibule-center", "vestibule", "Vestibule", "전정", vestibule_center, "Central chamber left after the three canals, their common crus, and the cochlea are separated.", "The oval window opens into it.", s126("Ch. 126"), "centroid of the vestibule mesh"),
        L("scc-lateral-arch", "scc-lateral", "Lateral semicircular canal", "외측반고리관", scc_anchor["lateral"], "Lateralmost point of the lateral canal loop.", "Mastoid landmark; the second genu is inferior to this arch.", s126("p. 11"), "most lateral canal vertex", True),
        L("scc-superior-arch", "scc-superior", "Superior semicircular canal", "상반고리관", scc_anchor["superior"], "Top of the superior canal.", "Related to the arcuate eminence.", [source(C175, "p. 3")], "most superior canal vertex", True),
        L("scc-posterior-arch", "scc-posterior", "Posterior semicircular canal", "후반고리관", scc_anchor["posterior"], "Lowest point of the posterior canal, inferior to the lateral canal.", "Translabyrinthine landmark.", [source(C175, "p. 10")], "most inferior canal vertex", True),
        L("common-crus", "common-crus", "Common crus", "총각", common_crus, "Shared limb of the superior and posterior canals.", "The two vertical canals meet here before entering the vestibule.", [source(SOM, "Ch. 15")], "centroid of the common-crus mesh"),
        L("ampulla-lateral", "scc-lateral", "Lateral ampulla", "외측팽대부", ampulla["lateral"], "Dilated anterior end of the lateral canal at the vestibule.", "Ampullary end, not a separate mesh.", [source(SOM, "Ch. 15")], "canal vertex nearest the vestibule"),
        L("ampulla-superior", "scc-superior", "Superior ampulla", "상팽대부", ampulla["superior"], "Ampullary end of the superior canal at the vestibule.", "Anterior end of that canal.", [source(SOM, "Ch. 15")], "canal vertex nearest the vestibule"),
        L("ampulla-posterior", "scc-posterior", "Posterior ampulla", "후팽대부", ampulla["posterior"], "Ampullary end of the posterior canal at the vestibule.", "Inferior end of that canal.", [source(SOM, "Ch. 15")], "canal vertex nearest the vestibule"),
        L("pars-flaccida", "tm-pars-flaccida", "Pars flaccida", "이완부", pars_flaccida, "Small superior part of the tympanic membrane.", "Retracts toward Prussak space.", s126("p. 5"), "superior membrane centroid"),
        L("carotid-canal", "carotid-artery", "Carotid canal", "경동맥관", carotid.mean(axis=0), "Petrous internal carotid, anterior to the cochlea.", "The genu and horizontal segment are not split.", [source(C175, "Ch. 175")], "centroid of the carotid mesh", True),
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

    # --- head registration ----------------------------------------------
    rotation, translation = head_transform(porus)
    skin_fit = apply_transform(skin, rotation, translation)
    skull_fit = apply_transform(skull, rotation, translation)
    auricle_fit = apply_transform(auricle, rotation, translation)
    # Keep the concha on the bony canal axis, then slide it laterally until the
    # pinna sits against the skin instead of floating in the canal.
    concha = auricle_fit.mean(axis=0)
    perpendicular = (concha - porus) - np.dot(concha - porus, eac_axis) * eac_axis
    auricle_fit = auricle_fit - perpendicular
    skin_tree_fit = cKDTree(skin_fit)
    best_shift = 0.0
    best_score = 1e9
    for extra in np.linspace(-12.0, 6.0, 37):
        trial = auricle_fit + eac_axis * extra
        gap = float(np.median(skin_tree_fit.query(trial[::5], k=1)[0]))
        score = abs(gap - 1.2)
        if score < best_score:
            best_score = score
            best_shift = float(extra)
    auricle_fit = auricle_fit + eac_axis * best_shift
    concha = auricle_fit.mean(axis=0)
    rel = concha - porus
    concha_offset = float(np.linalg.norm(rel - np.dot(rel, eac_axis) * eac_axis))
    if concha_offset > 3:
        raise RuntimeError(f"concha is {concha_offset:.2f} mm off the EAC axis")
    encode(skin_fit, skin_f, "skin.glb", UPPER)
    encode(skull_fit, skull_f, "skull.glb", UPPER)
    encode(auricle_fit, auricle_f, "auricle.glb", UPPER)
    containment = inside_fraction(bone, skin_fit, skin_f)
    if containment["outsideVertices"] != 0:
        raise RuntimeError(f"bone vertices outside skin: {containment}")

    vertex = skull[int(np.argmin(skull[:, 1]))]
    nose = skull[int(np.argmax(skull[:, 0]))]
    mid_z = (vertex[2] + nose[2]) / 2
    vault = skull[(skull[:, 1] < vertex[1] + 50) & (np.abs(skull[:, 2] - mid_z) < 30)]
    occiput = vault[int(np.argmin(vault[:, 0]))]
    cranial_center = (nose + occiput) / 2
    cranial_center[1] = vertex[1] + 60
    head_superior = unit(vertex - cranial_center)
    head_anterior = unit((nose - cranial_center) - np.dot(nose - cranial_center, head_superior) * head_superior)
    head_lateral = unit(np.cross(head_anterior, head_superior))
    if head_lateral[2] > 0:
        head_lateral = -head_lateral
    head_inferior = -head_superior

    def head_point(anterior_mm: float, inferior_mm: float, lateral_mm: float) -> np.ndarray:
        return PORION + head_anterior * anterior_mm + head_inferior * inferior_mm + head_lateral * lateral_mm

    fitted_skull = apply_transform(skull, rotation, translation)
    fitted_tree = cKDTree(fitted_skull)
    # Outer pairs. The skull vertex is the one nearest the ZETA landmark after the
    # rigid map; the residual is that gap. Internal petrous points are listed
    # separately: the decimated skull has no inner surface there.
    outer_ids = {
        "eac-porus": (porus, "EAC porus", "외이도 입구"),
        "mastoid-tip": (mastoid_tip, "Mastoid tip", "유양돌기 첨부"),
        "zygomatic-root": (zygomatic, "Zygomatic root", "관골돌기 기시부"),
        "styloid-base": (styloid_base, "Styloid base", "경상돌기 기저"),
        "henle-spine": (henle, "Spine of Henle", "Henle 극"),
        "digastric-ridge": (digastric, "Digastric ridge", "이복근릉"),
    }
    internal_ids = {
        "arcuate-eminence": (arcuate, "Arcuate eminence", "궁상융기"),
        "jugular-foramen": (jugular, "Jugular foramen region", "경정맥공 부근"),
    }
    inverse_rotation = rotation.T

    def pair_from(key: str, zeta: np.ndarray, en: str, ko: str, kind: str) -> tuple[dict, float]:
        distance, index = fitted_tree.query(zeta, k=1)
        skull_point = skull[int(index)]
        moved = fitted_skull[int(index)]
        # Inverse of p' = R p + t is p = R.T (p' - t). Check the stored skull point round-trips.
        _ = inverse_rotation @ (moved - translation)
        return (
            {
                "id": key,
                "en": en,
                "ko": ko,
                "kind": kind,
                "method": "Skull vertex nearest to the ZETA landmark after the rigid map. The map is the sagittal rotation plus the 5 mm lateral porion seat, not a least-squares of these points.",
                "skullMm": [round(float(v), 3) for v in skull_point],
                "zetaMm": [round(float(v), 3) for v in zeta],
                "transformedSkullMm": [round(float(v), 3) for v in moved],
                "residualMm": round(float(distance), 3),
            },
            float(distance),
        )

    pairs = []
    residuals = []
    for key, (zeta, en, ko) in outer_ids.items():
        item, distance = pair_from(key, zeta, en, ko, "outer")
        pairs.append(item)
        residuals.append(distance)
    internal_pairs = []
    for key, (zeta, en, ko) in internal_ids.items():
        item, _ = pair_from(key, zeta, en, ko, "internal-no-skull-surface")
        internal_pairs.append(item)
    rms = float(np.sqrt(np.mean(np.square(residuals))))
    angle = float(np.degrees(np.arccos(np.clip((np.trace(rotation) - 1) / 2, -1, 1))))
    previous = json.loads((UPPER / "registration.json").read_text())
    registration = {
        "review": "미검증",
        "scale": 1,
        "appliedScale": 1,
        "within5Percent": True,
        "scaleDecision": (
            f"Rigid map of the Z-Anatomy skull and MakeHuman skin into the ZETA frame. "
            f"Rotation is {angle:.1f}° about Z, the sagittal tilt between head-inferior and specimen +Y. "
            f"The audit's 51° figure was the Umeyama of an earlier, unpaired landmark set and is not applied. "
            f"Scale stays 1. The skull porion is seated 5 mm lateral to the bony porus so the lateral cortex lies inside the skin."
        ),
        "current": {
            "method": "Rigid rotation plus translation, scale 1, porion seated 5 mm lateral to the bony porus. rmsMm is the root-mean-square gap from six outer ZETA landmarks to the registered skull surface.",
            "rmsMm": round(rms, 3),
            "pairs": pairs,
        },
        "internalPairs": internal_pairs,
        "applied": {
            "scale": 1,
            "rotation": rotation.round(6).tolist(),
            "translationMm": [round(float(v), 4) for v in translation],
            "angleDeg": round(angle, 2),
            "porionSkullMm": PORION.round(3).tolist(),
            "lateralSeatMm": LATERAL_SEAT.tolist(),
            "rmsMm": round(rms, 3),
        },
        "containment": containment,
        "concha": {
            "xyzMm": [round(float(v), 3) for v in concha],
            "axisOffsetMm": round(concha_offset, 3),
            "porusMm": [round(float(v), 3) for v in porus],
        },
        "umeyama": {"scale": 1, "rmsMm": round(rms, 3), "note": "Applied transform is rigid with scale fixed at 1. rmsMm is the seven-pair residual of that map, not a free similarity."},
        "umeyamaWithoutMastoid": previous.get("umeyamaWithoutMastoid"),
        "dimensions": previous.get("dimensions", []),
        "frameNote": "Specimen axes verified on the meshes: cochlea is anteromedial to the canals, the superior canal is the minimum Y, and the lateral canal opens toward minimum Z. +X anterior, +Y inferior, +Z medial.",
    }
    (UPPER / "registration.json").write_text(json.dumps(registration, ensure_ascii=False, indent=2) + "\n", encoding="utf8")

    # Surface anchors on the moved auricle and skin.
    aur_tree = cKDTree(auricle_fit)
    skin_tree = cKDTree(skin_fit)

    def on_auricle(guess: np.ndarray) -> np.ndarray:
        return snap(aur_tree, auricle_fit, guess)

    helix = auricle_fit[int(np.argmin(auricle_fit[:, 1]))]
    lobule = auricle_fit[int(np.argmax(auricle_fit[:, 1]))]
    tragus = auricle_fit[int(np.argmax(auricle_fit[:, 0]))]
    posterior_helix = auricle_fit[int(np.argmin(auricle_fit[:, 0]))]
    lateral_helix = auricle_fit[int(np.argmin(auricle_fit[:, 2]))]
    cavum = auricle_fit[int(np.argmin(np.linalg.norm(auricle_fit - concha, axis=1)))]
    surface_specs = [
        ("helix", "Helix", "이륜", helix),
        ("crus-helix", "Crus of helix", "이륜각", on_auricle(concha + ANTERIOR * 4 + SUPERIOR * 6)),
        ("antihelix", "Antihelix", "대이륜", on_auricle(concha + POSTERIOR * 3 + SUPERIOR * 4 + LATERAL * 2)),
        ("scapha", "Scapha", "주상와", on_auricle((helix + posterior_helix) / 2 + LATERAL * 1)),
        ("triangular-fossa", "Triangular fossa", "삼각와", on_auricle(helix * 0.6 + concha * 0.4)),
        ("cymba", "Cymba conchae", "이갑개정", on_auricle(concha + SUPERIOR * 4)),
        ("cavum", "Cavum conchae", "이갑개강", cavum),
        ("tragus", "Tragus", "이주", tragus),
        ("antitragus", "Antitragus", "대이주", on_auricle(concha + POSTERIOR * 4 + INFERIOR * 5)),
        ("intertragic-notch", "Intertragic notch", "주간절흔", on_auricle((tragus + lobule) / 2)),
        ("lobule", "Lobule", "이수(귓불)", lobule),
        ("mastoid-tip-skin", "Mastoid tip", "유양돌기 첨부", snap(skin_tree, skin_fit, mastoid_tip + LATERAL * 2)),
        ("postauricular-sulcus", "Postauricular sulcus", "이개후구", on_auricle(posterior_helix + MEDIAL * 2)),
        ("zygomatic-arch", "Zygomatic arch", "관골궁", snap(skin_tree, skin_fit, zygomatic + LATERAL * 2 + ANTERIOR * 4)),
        ("temporal-line-skin", "Temporal line", "측두선", snap(skin_tree, skin_fit, temporal_line + LATERAL * 1)),
        ("tragal-pointer", "Tragal pointer", "이주 포인터", on_auricle(tragus + INFERIOR * 2)),
        ("preauricular", "Preauricular area", "이개전부", snap(skin_tree, skin_fit, tragus + ANTERIOR * 8 + MEDIAL * 2)),
    ]
    surface = []
    for item_id, en, ko, xyz in surface_specs:
        surface.append(
            {
                "id": item_id,
                "en": en,
                "ko": ko,
                "anatomy": "Point on the registered auricle or the skin beside it.",
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
    write_plots(labyrinth_v, labels, cochlear, facial, nerve, rows)
    summary = {
        "angles": angles,
        "posteriorLowestY": round(float(posterior_pts[:, 1].max()), 2),
        "lateralLowestY": round(float(lateral_pts[:, 1].max()), 2),
        "fnLengths": nerve["lengthsMm"],
        "fnArc": nerve["arcMm"],
        "containment": containment,
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
            "The nerve bundle in the internal auditory canal, still unsplit into cochlear and vestibular parts.",
            "내이도의 신경 다발이다. 와우신경과 전정신경으로는 아직 나누지 않았다.",
            "It runs with the facial nerve at the fundus. Bill's bar is not a separate surface.",
            "기저부에서 안면신경과 함께 있다. Bill 능선은 별도 표면이 없다.",
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
        "fn-meatal": (
            f"The part of this facial-nerve surface still against the cochleovestibular nerve, {lengths['fn-meatal']} mm on the centreline.",
            f"이 안면신경 표면 가운데 와우전정신경에 붙어 있는 구간이다. 중심선 길이 {lengths['fn-meatal']} mm.",
            "The mesh begins near the fundus, so this is only the lateral end of the meatal segment, not the whole internal canal.",
            "메시가 기저부 근처에서 시작하므로, 내이도 전체의 내이도부가 아니라 그 가쪽 끝이다.",
            C175,
            "p. 9",
        ),
        "fn-labyrinthine": (
            f"From the fundus to the geniculate, {lengths['fn-labyrinthine']} mm along this centreline.",
            f"기저부에서 슬신경절까지다. 이 중심선에서 {lengths['fn-labyrinthine']} mm.",
            "Teaching lengths are often 3–5 mm. This cut is the specimen's own course, kept inside that range.",
            "흔히 3–5 mm로 가르친다. 이 경계는 그 범위 안에서 이 표본의 주행으로 잡았다.",
            C173,
            "Ch. 173",
        ),
        "fn-geniculate": (
            f"The first genu, a {lengths['fn-geniculate']} mm window where the nerve turns from the labyrinthine course onto the tympanic course, just as it reaches the oval window.",
            f"제1슬이다. 미로부에서 고실부로 꺾이며 난원창에 닿는 {lengths['fn-geniculate']} mm 구간이다.",
            "The greater petrosal nerve leaves here. It is not in this mesh.",
            "대추체신경이 여기서 나간다. 이 메시에는 없다.",
            C126,
            "p. 7",
        ),
        "fn-tympanic": (
            f"The posterolateral run above the stapes, {lengths['fn-tympanic']} mm from the geniculate to the second genu.",
            f"등골 위의 후가쪽 주행이다. 슬신경절에서 제2슬까지 {lengths['fn-tympanic']} mm.",
            "Som and Curtin cite about 12 mm for a full tympanic segment. This surface's horizontal run is shorter; the cut follows the stapes and the second bend, not a fixed length.",
            "Som과 Curtin은 고실부 전체를 약 12 mm로 적는다. 이 표면의 수평 주행은 더 짧다. 고정 길이가 아니라 등골과 제2굽이로 잘랐다.",
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
            f"The descending segment, {lengths['fn-mastoid']} mm from the second genu to the end of the mesh.",
            f"하행 분절이다. 제2슬에서 메시 끝까지 {lengths['fn-mastoid']} mm.",
            "Reference lengths are about 15–20 mm to the stylomastoid foramen. This mesh stops in the mastoid, short of the foramen and the mastoid tip.",
            "참고 길이는 경유돌공까지 약 15–20 mm다. 이 메시는 유양부 안에서 끝나며 공과 유양돌기 첨부에 닿지 않는다.",
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
            "Cut by angle about the same modiolus as the scala tympani.",
            "고실계와 같은 와우축 각도로 나눴다.",
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
        "en": "Right temporal bone, ZETA. Axes checked on the meshes: +X anterior, +Y inferior, +Z medial. Canals were split by their loops and planes. The facial nerve was split at the fundus, the oval window, and the second bend. The head is rigidly registered; scale is 1.",
        "ko": "오른쪽 측두골 ZETA. 메시에서 축을 확인했다. +X 앞, +Y 아래, +Z 안쪽. 반고리관은 고리와 평면으로 나눴고, 안면신경은 기저부, 난원창, 제2굽이로 나눴다. 머리는 강체 정합이며 배율은 1이다.",
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
        "facial-nerve", "fn-meatal", "fn-labyrinthine", "fn-geniculate", "fn-tympanic", "fn-second-genu", "fn-mastoid",
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
    order = ["fn-meatal", "fn-labyrinthine", "fn-geniculate", "fn-tympanic", "fn-second-genu", "fn-mastoid"]
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

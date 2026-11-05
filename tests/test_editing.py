import io
import json
import time
import zipfile

import numpy as np
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from server.app import app
from server import pipeline, storage

client = TestClient(app)


def wait(response):
    assert response.status_code == 200, response.text
    jid = response.json()["job_id"]
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{jid}").json()
        if job["state"] in ("done", "failed", "canceled"):
            assert job["state"] == "done", job
            return job["result"]
        time.sleep(.01)
    raise AssertionError("Task did not finish")


def pose(x=10, color=(230, 120, 40, 255), odd=False):
    im = Image.new("RGBA", (96, 96))
    d = ImageDraw.Draw(im)
    d.rectangle((x, 20, x+24, 60), fill=color)
    d.rectangle((x+4, 25, x+8, 30), fill=(20, 30, 40, 255))
    if odd:
        d.ellipse((35, 3, 85, 80), fill=(80, 40, 230, 255))
    return im


def project(images, style="smooth"):
    p = storage.create("editing test", 12, style)
    root = storage.project_dir(p["id"])
    paths = []
    for i, im in enumerate(images):
        path = root / "uploads" / f"{i:04d}.png"
        im.save(path)
        paths.append(path)
    pipeline.ingest(p, paths, 12, 0, 0, lambda *_: None, lambda: False)
    return client.get(f'/api/projects/{p["id"]}').json()


def edit(p, operation, **kwargs):
    r = client.post(f'/api/projects/{p["id"]}/edit',
                    json={"expected_revision": p["revision"], "operation": operation, **kwargs})
    assert r.status_code == 200, r.text
    return r.json()


def analyze(p, **kwargs):
    report = wait(client.post(f'/api/projects/{p["id"]}/analyze',
                  json={"expected_revision": p["revision"], **kwargs}))["analysis"]
    assert client.get(f'/api/projects/{p["id"]}').json()["revision"] == p["revision"]
    return report


def apply(p, report, operation, ids, **kwargs):
    r = client.post(f'/api/projects/{p["id"]}/analysis/apply',
                   json={"expected_revision": p["revision"], "report_id": report["id"],
                         "operation": operation, "candidate_ids": ids, **kwargs})
    assert r.status_code == 200, r.text
    return r.json()


def test_copy_reverse_duration_export_preserve_identity_source_and_undo():
    p = project([pose(10), pose(20), pose(30)], "pixel")
    wait(client.post(f'/api/projects/{p["id"]}/process',
                     json={"settings": p["settings"] | {"size": 96}}))
    p = client.get(f'/api/projects/{p["id"]}').json()
    p = edit(p, "duplicate", indices=[0])
    ids = [f["id"] for f in p["frames"]]
    assert len(set(ids)) == 4
    assert p["frames"][1]["original"] == p["frames"][0]["original"]
    assert p["frames"][1]["time"] == 0
    assert p["frames"][1]["timeline_time"] == 1/12
    assert p["actions"][0]["end"] == 3
    p = edit(p, "duration", indices=[1], duration=.35)
    p = edit(p, "reverse", indices=[0, 1, 2, 3])
    assert [f["id"] for f in p["frames"]] == list(reversed(ids))
    assert p["frames"][2]["duration"] == .35
    result = wait(client.post(f'/api/projects/{p["id"]}/export'))
    z = zipfile.ZipFile(io.BytesIO(client.get(result["url"]).content))
    mf = json.loads(z.read("manifest.json"))
    assert [f["id"] for f in mf["frames"].values()] == list(reversed(ids))
    assert mf["frames"]["2"]["duration"] == .35
    assert mf["frames"]["2"]["source_time"] == 0
    exported = np.asarray(Image.open(io.BytesIO(z.read("frames/00002.png"))))
    assert set(np.unique(exported[..., 3])) <= {0, 255}
    undone = client.post(f'/api/projects/{p["id"]}/undo').json()
    assert [f["id"] for f in undone["frames"]] == ids
    # Copying must not rewrite its shared original when a brush mask is applied.
    wait(client.put(f'/api/projects/{p["id"]}/frames/1/mask', json={"strokes": [
        {"mode": "erase", "points": [[.2, .4]], "radius": .08}]}))
    after = client.get(f'/api/projects/{p["id"]}').json()
    assert after["frames"][0]["strokes"] == []
    assert after["frames"][1]["strokes"]


def test_action_aware_reorder_delete_and_invalid_edits_are_atomic():
    p = project([pose(i*5) for i in range(6)])
    p = client.post(f'/api/projects/{p["id"]}/actions',
                    json={"name": "part", "start": 3, "end": 5, "fps": 8}).json()
    revision = p["revision"]
    for body in ({"operation": "order", "order": [0, 1, 3, 2, 4, 5]},
                 {"operation": "reverse", "indices": [2, 3]},
                 {"operation": "delete", "indices": list(range(6))},
                 {"operation": "order", "order": [0, 0, 2, 3, 4, 5]}):
        r = client.post(f'/api/projects/{p["id"]}/edit', json=body | {"expected_revision": revision})
        assert r.status_code == 400, r.text
        assert client.get(f'/api/projects/{p["id"]}').json()["revision"] == revision
    p = edit(p, "order", order=[2, 0, 1, 3, 4, 5])
    assert [f["id"] for f in p["frames"][:3]] == ["00002", "00000", "00001"]
    p = edit(p, "delete", indices=[0, 3])
    assert [(a["start"], a["end"]) for a in p["actions"]] == [(0, 1), (2, 3)]
    assert [a["fps"] for a in p["actions"]] == [12, 8]
    stale = client.post(f'/api/projects/{p["id"]}/edit',
                        json={"expected_revision": revision, "operation": "duration", "indices": [0], "duration": .5})
    assert stale.status_code == 400


def test_duplicates_compress_conserves_timing_and_reports_stale_after_edit():
    p = project([pose(10), pose(10), pose(20), pose(30)])
    p = edit(p, "duration", indices=[1], duration=.4)
    total = sum(f["duration"] for f in p["frames"])
    report = analyze(p)
    groups = [g for g in report["duplicates"] if g["kind"] == "consecutive"]
    assert len(groups) == 1
    assert groups[0]["indices"] == [0, 1]
    p = apply(p, report, "compress", [groups[0]["id"]])
    assert len(p["frames"]) == 3
    assert abs(sum(f["duration"] for f in p["frames"]) - total) < 1e-9
    assert abs(p["frames"][0]["duration"] - (1/12+.4)) < 1e-9
    stale = client.post(f'/api/projects/{p["id"]}/analysis/apply',
                        json={"expected_revision": p["revision"], "report_id": report["id"],
                              "operation": "compress", "candidate_ids": [groups[0]["id"]]})
    assert stale.status_code == 400
    undone = client.post(f'/api/projects/{p["id"]}/undo').json()
    assert len(undone["frames"]) == 4


def test_posture_returns_are_not_compressible_and_checks_do_not_cross_actions():
    p = project([pose(10), pose(30), pose(10), pose(40)])
    report = analyze(p)
    assert not [g for g in report["duplicates"] if g["kind"] == "consecutive"]
    returns = [g for g in report["duplicates"] if g["kind"] == "return"]
    assert returns[0]["indices"] == [0, 2]
    r = client.post(f'/api/projects/{p["id"]}/analysis/apply',
                    json={"expected_revision": p["revision"], "report_id": report["id"],
                          "operation": "compress", "candidate_ids": [returns[0]["id"]]})
    assert r.status_code == 400
    p = client.post(f'/api/projects/{p["id"]}/actions',
                    json={"name": "part", "start": 2, "end": 3, "fps": 12}).json()
    report = analyze(p)
    assert not report["duplicates"]
    assert not report["suspects"]


def test_color_and_alpha_are_checked_and_hidden_transparent_rgb_is_ignored():
    a, b = pose(), pose()
    aa, bb = np.array(a), np.array(b)
    aa[aa[..., 3] == 0, :3] = [255, 0, 0]
    bb[bb[..., 3] == 0, :3] = [0, 255, 0]
    c = pose(color=(0, 200, 100, 255))
    p = project([Image.fromarray(aa), Image.fromarray(bb), c])
    report = analyze(p, duplicate_threshold=.01)
    assert report["duplicates"][0]["indices"] == [0, 1]
    assert all(2 not in g["indices"] for g in report["duplicates"])


def test_single_outlier_is_reported_and_skip_updates_only_temporal_dependents():
    p = project([pose(10+i) if i != 4 else pose(10, odd=True) for i in range(10)])
    settings = p["settings"] | {"size": 96, "stabilize": .2}
    wait(client.post(f'/api/projects/{p["id"]}/process', json={"settings": settings}))
    p = client.get(f'/api/projects/{p["id"]}').json()
    report = analyze(p, source="original")
    assert [s["index"] for s in report["suspects"]] == [4]
    outputs = [f["output"] for f in p["frames"]]
    p = apply(p, report, "skip", [report["suspects"][0]["id"]])
    assert not p["frames"][4]["enabled"]
    assert pipeline.neighbor_ids(storage.read(p["id"]), 3) == [2, 5]
    assert set(p["last_run"]["affected"]) <= {3, 4, 5}
    assert [f["output"] for f in p["frames"][:3]] == outputs[:3]


def test_loop_evidence_rejects_static_and_monotonic_sequences_and_applies_range():
    for images in ([pose(10)] * 12, [pose(5+i*3) for i in range(12)]):
        assert not analyze(project(images))["loops"]
    p = project([pose(x) for x in [5, 20, 35, 50]*3])
    report = analyze(p)
    assert [c["period"] for c in report["loops"]] == [4]
    candidate = report["loops"][0]
    p = apply(p, report, "loop", [candidate["id"]], name="walk")
    action = next(a for a in p["actions"] if a["name"] == "walk")
    assert action["end"]-action["start"]+1 == 4
    assert action["loop"]
    assert len({a["name"] for a in p["actions"]}) == len(p["actions"])
    assert len(p["frames"]) == 12


def test_loops_with_held_poses_and_variable_timing_are_retained():
    p = project([pose(x) for x in [5, 5, 30, 30]*3])
    p = edit(p, "duration", indices=[0, 4, 8], duration=.3)
    report = analyze(p)
    assert [c["period"] for c in report["loops"]] == [4]
    assert report["stats"][0]["timing_normalized"]
    assert not report["suspects"]


def test_unprocessed_pixel_edits_do_not_lock_palette_and_action_split_is_local():
    p = project([pose(i+10) for i in range(8)], "pixel")
    p = edit(p, "duplicate", indices=[0])
    assert p["palette"] is None
    assert all(f["output"] is None for f in p["frames"])
    settings = p["settings"] | {"size": 96, "stabilize": .2}
    wait(client.post(f'/api/projects/{p["id"]}/process', json={"settings": settings}))
    p = client.get(f'/api/projects/{p["id"]}').json()
    outputs = [f["output"] for f in p["frames"]]
    p = client.post(f'/api/projects/{p["id"]}/actions',
                    json={"name": "middle", "start": 3, "end": 5, "fps": 12}).json()
    assert all(f["output"] for f in p["frames"])
    assert p["frames"][1]["output"] == outputs[1]
    assert set(p["last_run"]["affected"]) <= {0, 2, 3, 5, 6, 8}

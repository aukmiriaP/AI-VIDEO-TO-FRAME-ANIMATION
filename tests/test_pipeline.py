import io
import json
import time
import zipfile
from fractions import Fraction

import av
import numpy as np
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from server.app import app
from server import imaging, storage

client = TestClient(app)


def wait(response):
    assert response.status_code == 200, response.text
    jid = response.json()["job_id"]
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        job = client.get(f"/api/jobs/{jid}").json()
        if job["state"] in ("failed", "done", "canceled"):
            assert job["state"] == "done", job
            return job
        time.sleep(.02)
    raise AssertionError("Job timed out")


def images_project():
    files = []
    for i in (10, 2, 1, 3):
        im = Image.new("RGBA", (64, 64), (200, 30+i, 10, 0))
        d = ImageDraw.Draw(im)
        d.ellipse((10+i, 10, 44+i, 52), fill=(220, 130+i, 50, 180))
        buf = io.BytesIO()
        im.save(buf, format="PNG")
        files.append(("files", (f"frame{i}.png", buf.getvalue(), "image/png")))
    job = wait(client.post("/api/import", data={"name": "test", "fps": 12}, files=files))
    return client.get(f'/api/projects/{job["project_id"]}').json()


def test_import_natural_order_and_alpha_preserved():
    p = images_project()
    assert [f["label"].split(".")[0] for f in p["frames"]] == ["frame1", "frame2", "frame3", "frame10"]
    image = Image.open(io.BytesIO(client.get(p["frames"][0]["original_url"]).content))
    assert set(np.unique(np.asarray(image)[..., 3])) == {0, 180}
    assert p["import_status"] == "ready"


def test_local_edit_updates_temporal_dependents_undo_and_preview():
    p = images_project()
    pid = p["id"]
    original = [f["source_hash"] for f in p["frames"]]
    settings = p["settings"] | {"size": 64, "stabilize": .2}
    wait(client.post(f"/api/projects/{pid}/process", json={"settings": settings}))
    p = client.get(f"/api/projects/{pid}").json()
    before = [f["output"] for f in p["frames"]]
    revision = p["revision"]
    preview = client.post(f"/api/projects/{pid}/preview", json={"index": 1, "settings": settings | {"offset_x": .05}})
    assert preview.status_code == 200, preview.text
    assert client.get(f"/api/projects/{pid}").json()["revision"] == revision
    wait(client.put(f"/api/projects/{pid}/frames/0/mask", json={"strokes": [
        {"mode": "erase", "points": [[.5,.5], [.6,.5]], "radius": .05}
    ]}))
    p = client.get(f"/api/projects/{pid}").json()
    assert p["last_run"]["affected"] == [0, 1, 3]  # loop neighbors, including last frame
    assert p["frames"][2]["output"] == before[2]
    assert [f["source_hash"] for f in p["frames"]] == original
    undone = client.post(f"/api/projects/{pid}/undo").json()
    assert [f["output"] for f in undone["frames"]] == before
    assert undone["frames"][0]["strokes"] == []


def test_pixel_shared_palette_export_and_smooth_alpha():
    p = images_project()
    pid = p["id"]
    smooth = p["settings"] | {"size": 64}
    wait(client.post(f"/api/projects/{pid}/process", json={"settings": smooth}))
    exported = wait(client.post(f"/api/projects/{pid}/export"))
    z = zipfile.ZipFile(io.BytesIO(client.get(exported["result"]["url"]).content))
    mf = json.loads(z.read("manifest.json"))
    index = "0"
    x,y,w,h = mf["frames"][index]["rect"]
    atlas = Image.open(io.BytesIO(z.read(mf["pages"][0])))
    frame = Image.open(io.BytesIO(z.read("frames/00000.png")))
    assert np.array_equal(np.asarray(atlas.crop((x,y,x+w,y+h))), np.asarray(frame))
    assert 180 in np.unique(np.asarray(frame)[...,3])  # no squaring alpha during atlas composition
    assert "project.godot" in z.namelist()
    pixel = smooth | {"style": "pixel", "colors": 8, "stabilize": .4}
    wait(client.post(f"/api/projects/{pid}/process", json={"settings": pixel}))
    p = client.get(f"/api/projects/{pid}").json()
    allowed = {tuple(c) for c in p["palette"]}
    for fr in p["frames"]:
        im = np.asarray(Image.open(io.BytesIO(client.get(fr["output_url"]).content)))
        assert set(np.unique(im[...,3])) <= {0,255}
        assert {tuple(c) for c in im[im[...,3]>0,:3]} <= allowed
    old_palette = p["palette"]
    wait(client.post(f"/api/projects/{pid}/process", json={"indices":[1], "settings": pixel | {"offset_x": .05}}))
    assert client.get(f"/api/projects/{pid}").json()["palette"] == old_palette


def test_time_sampling_and_trim_use_video_pts(tmp_path):
    path = tmp_path/"variable.mp4"
    with av.open(str(path), "w") as c:
        s = c.add_stream("libx264", rate=30)
        s.width = 64; s.height = 64; s.pix_fmt = "yuv420p"
        s.time_base = Fraction(1, 30)
        for i, pts in enumerate((0, 3, 9, 12, 18, 24)):
            frame = av.VideoFrame.from_ndarray(np.full((64,64,3), 30+i*30, np.uint8), format="rgb24")
            frame.pts = pts; frame.time_base = Fraction(1,30)
            for packet in s.encode(frame): c.mux(packet)
        for packet in s.encode(): c.mux(packet)
    job = wait(client.post("/api/import", data={"name":"VFR","fps":10,"start":.2,"end":.7},
                           files={"files":("variable.mp4",path.read_bytes(),"video/mp4")}))
    p = client.get(f'/api/projects/{job["project_id"]}').json()
    assert np.allclose([f["time"] for f in p["frames"]], [.3,.4,.6])
    assert np.allclose([f["duration"] for f in p["frames"][:2]], [.1,.2])
    assert abs(p["frames"][-1]["duration"] - .1) < .001


def test_invalid_edits_do_not_change_project():
    p = images_project()
    pid = p["id"]
    r = client.patch(f"/api/projects/{pid}/frames", json={"indices":[999], "enabled": False})
    assert r.status_code == 400
    assert client.get(f"/api/projects/{pid}").json()["revision"] == p["revision"]
    assert client.post(f"/api/projects/{pid}/actions", json={"name":"bad","start":3,"end":1,"fps":12}).status_code == 400
    assert client.post("/api/demo", headers={"origin":"https://unrelated.example"}).status_code == 403


def test_smooth_resize_transparency_does_not_make_black_halo():
    im = Image.new("RGBA", (4,4), (0,0,0,0))
    ImageDraw.Draw(im).rectangle((1,1,2,2), fill=(255,255,255,255))
    arr = np.asarray(imaging.resize_rgba(im,(32,32)))
    partial = (arr[...,3] > 10) & (arr[...,3] < 240)
    assert partial.any()
    assert np.min(arr[partial,:3]) >= 250


def test_selected_preview_matches_apply_with_temporal_neighbors():
    p = images_project()
    pid = p["id"]
    settings = p["settings"] | {"size": 64, "stabilize": .4}
    wait(client.post(f"/api/projects/{pid}/process", json={"settings": settings}))
    revision = client.get(f"/api/projects/{pid}").json()["revision"]
    edit = settings | {"offset_x": .05}
    preview = client.post(f"/api/projects/{pid}/preview",
                          json={"index": 1, "indices": [1], "settings": edit})
    assert preview.status_code == 200, preview.text
    assert client.get(f"/api/projects/{pid}").json()["revision"] == revision
    wait(client.post(f"/api/projects/{pid}/process", json={"indices": [1], "settings": edit}))
    after = client.get(f"/api/projects/{pid}").json()
    assert after["frames"][1]["output_url"] == preview.json()["url"]
    assert after["frames"][0]["settings"]["offset_x"] == 0

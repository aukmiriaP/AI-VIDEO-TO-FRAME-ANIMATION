import io
import json
import zipfile

import numpy as np
import pytest
from PIL import Image, ImageDraw

from server import pipeline, storage
from server.normals import NormalSettings, generate
from test_pipeline import client, images_project, wait


def png(url):
    return np.asarray(Image.open(io.BytesIO(client.get(url).content)))


def test_bevel_directions_unit_vectors_and_alpha():
    im = Image.new("RGBA", (32, 32))
    ImageDraw.Draw(im).rectangle((4, 4, 27, 27), fill=(190, 120, 50, 180))
    n = np.asarray(generate(im, NormalSettings(bevel=6, strength=3)))
    assert np.array_equal(n[..., 3], np.asarray(im)[..., 3])
    assert np.array_equal(n[0, 0], [128, 128, 255, 0])
    assert n[16, 5, 0] < 128 and n[16, 26, 0] > 128  # left/right outward
    assert n[5, 16, 1] > 128 and n[26, 16, 1] < 128  # +Y up
    assert np.array_equal(n[16, 16, :3], [128, 128, 255])
    lengths = np.linalg.norm(n[..., :3]/255*2-1, axis=-1)
    assert np.max(abs(lengths-1)) < .012
    flat = np.asarray(generate(im, NormalSettings(strength=0)))
    assert np.all(flat[..., :3] == [128, 128, 255])
    inverted = np.asarray(generate(im, NormalSettings(bevel=6, strength=3, invert=True)))
    assert inverted[16, 5, 0] > 128
    flip = np.asarray(generate(im, NormalSettings(bevel=6, strength=3, flip_y=True)))
    assert flip[5, 16, 1] < 128
    assert np.array_equal(flip[..., (0, 2, 3)], n[..., (0, 2, 3)])


def test_luma_hidden_rgb_grid_and_degenerate_canvas():
    arr = np.zeros((19, 23, 4), dtype=np.uint8)
    arr[2:17, 2:21, :3] = np.arange(19)[None, :, None]*12
    arr[2:17, 2:21, 3] = 180
    options = NormalSettings(method="luma", smooth=2)
    first = generate(Image.fromarray(arr), options)
    arr[arr[..., 3] == 0, :3] = 255
    assert np.array_equal(np.asarray(first), np.asarray(generate(Image.fromarray(arr), options)))
    # Nearest replication preserves one vector per logical pixel even on partial edge cells.
    cell = 3
    a = np.array(Image.new("RGBA", (23, 19), (120, 50, 20, 255)))
    a[::cell, ::cell, :3] = np.arange(8)[None, :, None]*25
    normal = np.asarray(generate(Image.fromarray(a), NormalSettings(method="mix"), cell))
    logical = normal[::cell, ::cell]
    expected = np.repeat(np.repeat(logical, cell, axis=0), cell, axis=1)[:19, :23]
    assert np.array_equal(normal, expected)
    assert generate(Image.new("RGBA", (1, 1)), options).size == (1, 1)


def test_read_only_preview_local_apply_cache_geometry_and_undo():
    p = images_project(); pid = p["id"]
    wait(client.post(f"/api/projects/{pid}/process", json={"settings_patch":{"size":64}}))
    p = client.get(f"/api/projects/{pid}").json()
    before = [f["output"] for f in p["frames"]]
    opts = NormalSettings(method="mix").model_dump()
    response = client.post(f"/api/projects/{pid}/normals/preview", json={
        "index":1, "settings":opts, "expected_revision":p["revision"]})
    assert response.status_code == 200, response.text
    preview = response.json()
    assert preview["geometry"] == p["frames"][1]["geometry"]
    assert np.array_equal(png(preview["normal_url"])[...,3],png(preview["url"])[...,3])
    assert client.get(f"/api/projects/{pid}").json()["revision"] == p["revision"]
    wait(client.post(f"/api/projects/{pid}/normals", json={
        "indices":[1], "settings":opts, "expected_revision":p["revision"]}))
    p = client.get(f"/api/projects/{pid}").json()
    assert p["frames"][1]["normal_url"] == preview["normal_url"]
    assert not p["frames"][0].get("normal")
    assert [f["output"] for f in p["frames"]] == before
    wait(client.post(f"/api/projects/{pid}/normals", json={
        "settings":NormalSettings().model_dump(), "expected_revision":p["revision"]}))
    p = client.get(f"/api/projects/{pid}").json()
    previous_normals = [f["normal"] for f in p["frames"]]
    # Quantization / dither / neighbor stabilization must not change geometry-derived normals.
    wait(client.post(f"/api/projects/{pid}/process",json={"settings_patch":{
        "style":"pixel", "pixel_cell":2, "size":64}}))
    p = client.get(f"/api/projects/{pid}").json()
    normals = [f["normal"] for f in p["frames"]]
    wait(client.post(f"/api/projects/{pid}/process",json={"settings_patch":{
        "palette_mode":"custom", "custom_palette":["#000000","#ffffff"], "dither_strength":1, "stabilize":.3}}))
    p = client.get(f"/api/projects/{pid}").json()
    assert [f["normal"] for f in p["frames"]] == normals
    wait(client.post(f"/api/projects/{pid}/process",json={"indices":[1],"settings_patch":{"offset_x":.1}}))
    p = client.get(f"/api/projects/{pid}").json()
    assert p["frames"][1]["normal"] != normals[1]
    assert [p["frames"][i]["normal"] for i in (0,2,3)] == [normals[i] for i in (0,2,3)]
    restored = client.post(f"/api/projects/{pid}/undo").json()
    assert [f["normal"] for f in restored["frames"]] == normals
    # Mask edits refresh affected normals alongside colors, preserving settings.
    wait(client.put(f"/api/projects/{pid}/frames/1/mask",json={"strokes":[
        {"mode":"erase","points":[[.5,.5]],"radius":.1}]}))
    edited = client.get(f"/api/projects/{pid}").json()
    assert edited["frames"][1]["normal"] != normals[1]
    assert edited["frames"][0]["normal"] == normals[0]
    assert previous_normals != normals


def test_invalid_revision_cancel_and_normal_export():
    p = images_project(); pid = p["id"]
    body = {"settings":NormalSettings().model_dump(), "expected_revision":p["revision"]}
    assert client.post(f"/api/projects/{pid}/normals/preview", json=body|{"index":-1}).status_code == 422
    assert client.post(f"/api/projects/{pid}/normals/preview", json=body|{"index":99}).status_code == 400
    assert client.post(f"/api/projects/{pid}/normals/preview", json=body|{"index":0,"expected_revision":0}).status_code == 400
    assert client.post(f"/api/projects/{pid}/normals/preview", json=body|{"index":0,"settings":{"strength":99}}).status_code == 422
    with pytest.raises(InterruptedError):
        pipeline.apply_normals(pid, None, NormalSettings(), p["revision"], lambda *_:None, lambda:True)
    assert storage.read(pid)["revision"] == p["revision"]
    wait(client.post(f"/api/projects/{pid}/process",json={"settings_patch":{"size":64},
        "asset_options":{"pivot_x":.25,"pivot_y":.9}}))
    p = client.get(f"/api/projects/{pid}").json()
    wait(client.post(f"/api/projects/{pid}/normals",json={
        "settings":NormalSettings(flip_y=True).model_dump(),"indices":[1],"expected_revision":p["revision"]}))
    result = wait(client.post(f"/api/projects/{pid}/export",json={
        "options":{"include_normals":True,"padding":4,"extrude":1,"columns":1,"page_size":128,"prefix":"hero"}}))
    z = zipfile.ZipFile(io.BytesIO(client.get(result["result"]["url"]).content))
    mf = json.loads(z.read("manifest.json"))
    assert mf["version"] == 3 and mf["normals"]["convention"] == "OpenGL +Y up"
    assert len(mf["normal_pages"]) == len(mf["pages"]) == 4
    assert mf["frames"]["1"]["normal_settings"]["flip_y"]
    assert not mf["frames"]["0"]["normal_settings"]["flip_y"]
    for info in mf["frames"].values():
        n = np.asarray(Image.open(io.BytesIO(z.read(info["normal_file"]))))
        c = np.asarray(Image.open(io.BytesIO(z.read(info["file"]))))
        atlas = Image.open(io.BytesIO(z.read(mf["normal_pages"][info["page"]])))
        x,y,w,h = info["rect"]
        assert np.array_equal(np.asarray(atlas.crop((x,y,x+w,y+h))),n)
        assert np.array_equal(n[...,3],c[...,3])
        assert np.array_equal(np.asarray(atlas)[0,0],[128,128,255,0])
    assert 'type="CanvasTexture"' in z.read("animations.tres").decode()
    assert 'type="PointLight2D"' in z.read("preview.tscn").decode()
    assert "light.png" in z.namelist()
    saved = client.get(f"/api/projects/{pid}").json()
    assert not saved["frames"][0].get("normal")
    assert saved["frames"][1].get("normal")
    assert saved["export_options"]["include_normals"]
    restored = client.post(f"/api/projects/{pid}/undo").json()
    assert not restored["export_options"]["include_normals"]
    assert not restored["frames"][0].get("normal")

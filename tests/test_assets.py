import io
import json
import zipfile

import numpy as np
import pytest
from PIL import Image, ImageDraw

from server import exporting, imaging, storage
from test_pipeline import client, images_project, wait


def subject(alpha=255):
    im = Image.new("RGBA", (64, 64))
    ImageDraw.Draw(im).rectangle((8, 8, 23, 39), fill=(210, 100, 40, alpha))
    return im


def test_subject_alignment_and_source_geometry():
    options = imaging.AssetOptions(canvas_width=96, canvas_height=80, pivot_x=.5, pivot_y=.9)
    im, g = imaging.prepare_geometry(subject(), imaging.Settings(size=64, align_mode="bottom"),
                                     [], storage.MODELS, options)
    assert im.size == (96, 80)
    assert im.getchannel("A").getbbox() == (40, 40, 56, 72)
    assert g["offset"] == [32, 32] and g["scale"] == [1, 1]
    assert g["pivot"] == [.5, .9] and not g["warnings"]
    # A known source point maps exactly into the exported canvas.
    assert im.getpixel((12+g["offset"][0], 20+g["offset"][1])) == subject().getpixel((12,20))
    centered, _ = imaging.prepare_geometry(subject(), imaging.Settings(size=64, align_mode="center"),
                                           [], storage.MODELS, options.model_copy(update={"pivot_y":.5}))
    bbox = centered.getchannel("A").getbbox()
    assert (bbox[0]+bbox[2])/2 == 48
    assert abs((bbox[1]+bbox[3])/2-40) <= .5


def test_clipped_empty_and_opaque_subject_warnings():
    settings = imaging.Settings(size=64, align_mode="bottom")
    _, g = imaging.prepare_geometry(subject(), settings, [], storage.MODELS,
                                     imaging.AssetOptions(canvas_width=8, canvas_height=8))
    assert g["clipped_pixels"] > 0 and any("裁切" in w for w in g["warnings"])
    _, g = imaging.prepare_geometry(Image.new("RGBA",(64,64)), settings, [], storage.MODELS,
                                     imaging.AssetOptions())
    assert g["bounds"] is None and any("没有" in w for w in g["warnings"])
    _, g = imaging.prepare_geometry(Image.new("RGBA",(64,64),(20,40,50,255)), settings,
                                     [], storage.MODELS, imaging.AssetOptions())
    assert any("透明背景" in w for w in g["warnings"])


def test_matte_refinement_preserves_alpha_manual_restore_and_hard_pixel():
    source = subject(alpha=180)
    ImageDraw.Draw(source).rectangle((50,50,51,51),fill=(40,50,200,180))
    refined = imaging.refine_matte(source, source, imaging.Settings(matte_feather=1, speck_area=10))
    arr = np.asarray(refined)
    assert arr[50,50,3] == 0 and 0 < arr[8,8,3] < 180
    assert np.all(arr[...,3] <= np.asarray(source)[...,3])
    strokes=[{"mode":"restore","points":[[50/63,50/63]],"radius":.02}]
    manual = imaging.prepare(source, imaging.Settings(size=64,speck_area=10), strokes, storage.MODELS)
    assert manual.getpixel((50,50)) == source.getpixel((50,50))
    pixel = imaging.prepare(source, imaging.Settings(size=64,style="pixel",matte_feather=1),
                             [], storage.MODELS)
    assert set(np.unique(np.asarray(pixel)[...,3])) <= {0,255}


def test_matte_grow_chroma_and_edge_color_cleanup():
    source = Image.new("RGBA",(64,64),(54,184,89,255))
    ImageDraw.Draw(source).rectangle((8,8,23,39),fill=(220,40,40,255))
    base = imaging.Settings(size=64,background="chroma",despill=0)
    grown=imaging.prepare(source, base.model_copy(update={"matte_grow":2}), [], storage.MODELS)
    shrunk=imaging.prepare(source, base.model_copy(update={"matte_grow":-2}), [], storage.MODELS)
    assert grown.getchannel("A").getbbox()==(6,6,26,42)
    assert shrunk.getchannel("A").getbbox()==(10,10,22,38)
    edge=subject()
    edge.putpixel((8,20),(0,240,0,100))
    fixed=imaging.refine_matte(edge,edge,imaging.Settings(edge_cleanup=1))
    assert fixed.getpixel((8,20))[1]<240
    assert fixed.getpixel((8,20))[3]==100
    assert fixed.getpixel((12,20))==edge.getpixel((12,20))


def test_asset_patch_scope_cache_preview_undo_and_preserved_local_settings():
    p=images_project();pid=p["id"]
    settings=p["settings"]|{"size":64,"stabilize":.2}
    wait(client.post(f"/api/projects/{pid}/process",json={"settings":settings}))
    wait(client.post(f"/api/projects/{pid}/process",json={"settings":settings|{"offset_x":.1},"indices":[0]}))
    p=client.get(f"/api/projects/{pid}").json()
    before=[f["output"] for f in p["frames"]]
    body={"indices":[1],"asset_patch":{"align_mode":"center","matte_feather":1}}
    preview=client.post(f"/api/projects/{pid}/preview",json=body|{"index":1}).json()
    assert client.get(f"/api/projects/{pid}").json()["revision"]==p["revision"]
    wait(client.post(f"/api/projects/{pid}/process",json=body))
    after=client.get(f"/api/projects/{pid}").json()
    assert after["frames"][1]["output_url"]==preview["url"]
    assert after["frames"][1]["geometry"]==preview["geometry"]
    assert after["frames"][0]["settings"]["offset_x"]==.1
    assert after["last_run"]["affected"]==[0,1,2]
    assert after["frames"][3]["output"]==before[3]
    wait(client.post(f"/api/projects/{pid}/process",json=body))
    assert client.get(f"/api/projects/{pid}").json()["last_run"]["base_computed"]==0
    client.post(f"/api/projects/{pid}/undo")
    restored=client.post(f"/api/projects/{pid}/undo").json()
    assert [f["output"] for f in restored["frames"]]==before
    # Global asset patches preserve local position and background overrides.
    wait(client.post(f"/api/projects/{pid}/process",json={"asset_patch":{"align_mode":"bottom"}}))
    assert client.get(f"/api/projects/{pid}").json()["frames"][0]["settings"]["offset_x"]==.1


def test_canvas_rejects_partial_changes_and_old_project_defaults():
    p=images_project();pid=p["id"]
    options={"canvas_width":100,"canvas_height":80,"pivot_y":.9}
    bad=client.post(f"/api/projects/{pid}/preview",json={"index":0,"indices":[0],"asset_options":options})
    assert bad.status_code==400
    assert client.get(f"/api/projects/{pid}").json()["revision"]==p["revision"]
    preview=client.post(f"/api/projects/{pid}/preview",json={"index":0,"asset_options":options}).json()
    wait(client.post(f"/api/projects/{pid}/process",json={"asset_options":options}))
    p=client.get(f"/api/projects/{pid}").json()
    assert all(f["geometry"]["canvas"]==[100,80] for f in p["frames"])
    assert p["frames"][0]["output_url"]==preview["url"]
    restored=client.post(f"/api/projects/{pid}/undo").json()
    assert restored["asset_options"]["canvas_width"]==0
    old=storage.read(pid)
    old.pop("asset_options");old.pop("export_options")
    for key in imaging.AssetEdits.model_fields:
        old["settings"].pop(key)
    storage.write(old)
    revision=old["revision"]
    loaded=client.get(f"/api/projects/{pid}").json()
    assert loaded["settings"]["align_mode"]=="none"
    assert loaded["asset_options"]["pivot_y"]==.5
    assert loaded["revision"]==revision


def test_atlas_layout_subset_pages_padding_alpha_pivot_and_option_persistence():
    p=images_project();pid=p["id"]
    wait(client.post(f"/api/projects/{pid}/process",json={"settings":p["settings"]|{"size":64},
         "asset_options":{"pivot_x":.25,"pivot_y":.9}}))
    client.post(f"/api/projects/{pid}/actions",json={"name":"other","start":2,"end":3,"fps":6,"loop":False})
    p=client.get(f"/api/projects/{pid}").json()
    options={"columns":1,"padding":4,"extrude":1,"page_size":128,"prefix":"hero",
             "action_ids":[p["actions"][1]["id"]]}
    body={"options":options,"expected_revision":p["revision"]}
    plan=client.post(f"/api/projects/{pid}/export/preview",json=body).json()
    assert plan["frames"]==2 and len(plan["pages"])==2
    assert client.get(f"/api/projects/{pid}").json()["revision"]==p["revision"]
    job=wait(client.post(f"/api/projects/{pid}/export",json=body))
    z=zipfile.ZipFile(io.BytesIO(client.get(job["result"]["url"]).content))
    mf=json.loads(z.read("manifest.json"))
    assert mf["pivot"]==[.25,.9]
    assert len(mf["actions"])==1 and mf["actions"][0]["fps"]==6
    assert set(mf["frames"])=={"2","3"}
    assert mf["pages"]==[page["file"] for page in plan["pages"]]
    for info in mf["frames"].values():
        atlas=Image.open(io.BytesIO(z.read(mf["pages"][info["page"]])))
        fr=Image.open(io.BytesIO(z.read(info["file"])))
        x,y,w,h=info["rect"]
        assert np.array_equal(np.asarray(atlas.crop((x,y,x+w,y+h))),np.asarray(fr))
        assert 180 in np.unique(np.asarray(fr)[...,3])
        assert np.asarray(atlas)[:3,:,3].max()==0  # remainder of margin transparent
    assert "offset = Vector2(16.0, -25.6)" in z.read("preview.tscn").decode()
    after=client.get(f"/api/projects/{pid}").json()
    assert after["export_options"]==options
    assert client.post(f"/api/projects/{pid}/undo").json()["export_options"]["prefix"]==""


def test_invalid_atlas_layout_and_zero_margin_export():
    with pytest.raises(ValueError):
        exporting.ExportOptions(padding=1,extrude=2)
    p=images_project();pid=p["id"]
    settings=p["settings"]|{"size":64}
    wait(client.post(f"/api/projects/{pid}/process",json={"settings":settings}))
    p=client.get(f"/api/projects/{pid}").json()
    assert client.post(f"/api/projects/{pid}/export/preview",json={"options":{"columns":3,"page_size":128}}).status_code==400
    assert client.post(f"/api/projects/{pid}/export/preview",json={"options":{"action_ids":[]}}).status_code==400
    assert client.post(f"/api/projects/{pid}/export/preview",json={"expected_revision":p["revision"]-1}).status_code==400
    job=wait(client.post(f"/api/projects/{pid}/export",json={"options":{"padding":0,"extrude":0}}))
    z=zipfile.ZipFile(io.BytesIO(client.get(job["result"]["url"]).content))
    mf=json.loads(z.read("manifest.json"))
    assert mf["frames"]["0"]["rect"]==[0,0,64,64]

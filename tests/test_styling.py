import io
import json
import zipfile

import numpy as np
import pytest
from PIL import Image, ImageDraw

from server import imaging, pipeline, storage, styling
from test_pipeline import client, images_project, wait


def fetch_image(url):
    return np.asarray(Image.open(io.BytesIO(client.get(url).content)))


def test_sampling_modes_and_alpha_weighted_majority():
    im=Image.new("RGBA",(10,10),(240,40,20,255))
    ImageDraw.Draw(im).rectangle((4,4,6,6),fill=(20,40,240,255))
    center=styling.sample_rgba(im,(1,1),"nearest")
    majority=styling.sample_rgba(im,(1,1),"majority")
    average=styling.sample_rgba(im,(1,1),"area")
    assert center.getpixel((0,0))[:3]==(20,40,240)
    assert majority.getpixel((0,0))[:3]==(240,40,20)
    assert 20<average.getpixel((0,0))[2]<240
    hidden=Image.new("RGBA",(10,10),(0,255,0,0))
    ImageDraw.Draw(hidden).rectangle((0,0,4,9),fill=(255,255,255,255))
    for method in ("area","majority"):
        out=styling.sample_rgba(hidden,(1,1),method)
        assert out.getpixel((0,0))[:3]==(255,255,255)
        assert 0<out.getpixel((0,0))[3]<255


def test_uniform_logical_grid_nondivisible_canvas_and_hard_alpha():
    arr=np.zeros((9,13,4),np.uint8)
    arr[...,:3]=np.arange(13)[None,:,None]*15
    arr[...,3]=255
    settings=imaging.Settings(style="pixel",pixel_cell=4,pixel_sampling="area")
    out,logical=styling.grid(Image.fromarray(arr),settings)
    assert out.size==(13,9) and logical.size==(4,3)
    a=np.asarray(out)
    assert a[...,3].min()==255  # partial right/bottom cells stay visible
    for y in range(0,9,4):
        for x in range(0,13,4):
            cell=a[y:y+4,x:x+4]
            assert np.all(cell==cell[0,0])


def test_fixed_dither_color_coverage_and_logical_cell_anchor():
    im=Image.new("RGBA",(16,16),(96,96,96,180))
    palette=[[0,0,0],[255,255,255]]
    s=imaging.Settings(style="pixel",dither_strength=1)
    out=np.asarray(imaging.quantize(im,palette,s))
    assert set(map(tuple,out[...,:3].reshape(-1,3)))=={(0,0,0),(255,255,255)}
    assert abs(out[...,0].mean()-96)<8
    assert np.all(out[...,3]==180)
    assert np.array_equal(out[:4,:4],out[4:8,4:8])
    assert np.array_equal(out,np.asarray(imaging.quantize(im,palette,s)))
    cells=np.asarray(imaging.quantize(im,palette,s.model_copy(update={"pixel_cell":2})))
    for y in range(0,16,2):
        for x in range(0,16,2):
            assert np.all(cells[y:y+2,x:x+2]==cells[y,x])
    assert np.asarray(imaging.quantize(im,palette,s.model_copy(update={"dither_strength":0})))[...,0].max()==0


def test_lab_mapping_changes_color_decision_without_expanding_palette():
    palette=[[0,0,0],[255,255,255]]
    im=Image.new("RGBA",(2,2),(120,120,120,255))
    rgb=imaging.quantize(im,palette,imaging.Settings(palette_distance="rgb"))
    lab=imaging.quantize(im,palette,imaging.Settings(palette_distance="lab"))
    assert rgb.getpixel((0,0))[:3]!=lab.getpixel((0,0))[:3]
    assert lab.getpixel((0,0))[:3] in map(tuple,palette)


def test_style_patch_keeps_independent_frame_background_position_and_brush():
    p=images_project();pid=p["id"]
    wait(client.post(f"/api/projects/{pid}/process",json={"settings_patch":{"size":64}}))
    wait(client.post(f"/api/projects/{pid}/process",json={"indices":[1],
        "settings_patch":{"offset_x":.1,"background":"chroma","key_color":"#ffffff","tolerance":0}}))
    wait(client.put(f"/api/projects/{pid}/frames/1/mask",json={"strokes":[
        {"mode":"restore","points":[[.5,.5]],"radius":.01}]}))
    before=client.get(f"/api/projects/{pid}").json()
    patch={"smooth_strength":.5,"smooth_levels":4}
    preview=client.post(f"/api/projects/{pid}/preview",json={"index":1,"settings_patch":patch}).json()
    assert client.get(f"/api/projects/{pid}").json()["revision"]==before["revision"]
    wait(client.post(f"/api/projects/{pid}/process",json={"settings_patch":patch}))
    after=client.get(f"/api/projects/{pid}").json()
    assert after["frames"][1]["output_url"]==preview["url"]
    assert after["frames"][1]["settings"]["background"]=="chroma"
    assert after["frames"][1]["settings"]["offset_x"]==.1
    assert after["frames"][0]["settings"]["background"]=="keep"
    assert after["frames"][0]["settings"]["offset_x"]==0
    assert after["frames"][1]["strokes"]==before["frames"][1]["strokes"]
    bad=client.post(f"/api/projects/{pid}/preview",json={"index":0,"settings_patch":{"unknown":True}})
    assert bad.status_code==400
    restored=client.post(f"/api/projects/{pid}/undo").json()
    assert [f["output"] for f in restored["frames"]]==[f["output"] for f in before["frames"]]


def test_smoothing_reduces_noise_keeps_edge_alpha_and_ignores_hidden_rgb():
    rng=np.random.default_rng(12)
    arr=np.empty((40,40,4),np.uint8)
    arr[:,:,:3]=np.clip(180+rng.normal(0,8,(40,40,1)),0,255)
    arr[:,20:,:3]=np.clip(35+rng.normal(0,8,(40,20,1)),0,255)
    arr[:,:,3]=180
    s=imaging.Settings(smooth_strength=1)
    result=np.asarray(styling.smooth_colors(Image.fromarray(arr),s))
    assert result[5:35,5:15,0].std()<arr[5:35,5:15,0].std()*.7
    assert result[:,19,0].mean()-result[:,20,0].mean()>100
    assert np.array_equal(result[:,:,3],arr[:,:,3])
    white=Image.new("RGBA",(20,20),(0,0,0,0))
    ImageDraw.Draw(white).rectangle((5,5,14,14),fill=(255,255,255,80))
    result=np.asarray(styling.smooth_colors(white,s))
    assert result[result[...,3]>0,:3].min()==255


def test_color_layers_and_grading_keep_transparency_and_use_fixed_bins():
    arr=np.zeros((16,16,4),np.uint8)
    arr[:,:,:3]=np.arange(16)[None,:,None]*16
    arr[:,:,3]=np.arange(16)[:,None]*16
    s=imaging.Settings(smooth_levels=4)
    result=np.asarray(styling.smooth_colors(Image.fromarray(arr),s))
    assert set(np.unique(result[result[...,3]>0,:3]))<={0,85,170,255}
    assert np.array_equal(arr[:,:,3],result[:,:,3])
    saturated=styling.grade(Image.new("RGBA",(2,2),(160,50,20,110)),imaging.Settings(saturation=0))
    pixel=saturated.getpixel((0,0))
    assert pixel[0]==pixel[1]==pixel[2] and pixel[3]==110
    assert np.array_equal(np.asarray(styling.grade(Image.fromarray(arr),imaging.Settings())),arr)


def test_outline_expands_only_outer_alpha_and_respects_pixel_grid():
    im=Image.new("RGBA",(16,16))
    ImageDraw.Draw(im).rectangle((4,4,11,11),fill=(240,100,60,180))
    out,clipped=styling.outline(im,2,"#102030")
    arr=np.asarray(out)
    assert not clipped
    assert np.array_equal(arr[4:12,4:12],np.asarray(im)[4:12,4:12])
    assert out.getchannel("A").getbbox()==(2,2,14,14)
    assert out.getpixel((3,8))==(16,32,48,180)
    pixel,_=styling.base_style(im,imaging.Settings(style="pixel",pixel_cell=2,outline_width=1))
    assert pixel.getchannel("A").getbbox()==(2,2,14,14)
    assert set(np.unique(np.asarray(pixel)[...,3]))<={0,255}
    edge=Image.new("RGBA",(8,8));edge.putpixel((0,0),(10,20,30,255))
    _,warnings=styling.base_style(edge,imaging.Settings(outline_width=2))
    assert warnings


def test_custom_palette_scope_preview_apply_and_single_quantization(monkeypatch):
    p=images_project();pid=p["id"]
    s=p["settings"]|{"style":"pixel","size":64,"palette_mode":"custom",
                     "custom_palette":["#000000","#ffffff"],"dither_strength":.8,"stabilize":.2}
    bad=client.post(f"/api/projects/{pid}/preview",json={"index":1,"indices":[1],"settings":s})
    assert bad.status_code==400
    assert client.get(f"/api/projects/{pid}").json()["revision"]==p["revision"]
    calls=[]
    original=imaging.quantize
    def count(*args,**kwargs):
        calls.append(True);return original(*args,**kwargs)
    monkeypatch.setattr(imaging,"quantize",count)
    preview=client.post(f"/api/projects/{pid}/preview",json={"index":1,"settings":s}).json()
    assert len(calls)==1
    wait(client.post(f"/api/projects/{pid}/process",json={"settings":s}))
    p=client.get(f"/api/projects/{pid}").json()
    assert p["palette"]==[[0,0,0],[255,255,255]]
    assert p["frames"][1]["output_url"]==preview["url"]
    for fr in p["frames"]:
        a=fetch_image(fr["output_url"])
        assert set(map(tuple,a[a[...,3]>0,:3]))<={(0,0,0),(255,255,255)}
    before=p["palette"]
    wait(client.post(f"/api/projects/{pid}/process",json={"rebuild_palette":True}))
    assert client.get(f"/api/projects/{pid}").json()["palette"]==before


def test_dither_changes_output_without_recomputing_base_and_local_smooth_undo():
    p=images_project();pid=p["id"]
    s=p["settings"]|{"style":"pixel","size":64,"palette_mode":"custom","custom_palette":["#000000","#ffffff"]}
    wait(client.post(f"/api/projects/{pid}/process",json={"settings":s}))
    p=client.get(f"/api/projects/{pid}").json()
    before=[f["output"] for f in p["frames"]]
    wait(client.post(f"/api/projects/{pid}/process",json={"indices":[1],"settings":s|{"dither_strength":.8}}))
    p=client.get(f"/api/projects/{pid}").json()
    assert p["last_run"]["base_computed"]==0
    assert p["frames"][1]["output"]!=before[1]
    assert p["frames"][0]["output"]==before[0] and p["frames"][3]["output"]==before[3]
    restored=client.post(f"/api/projects/{pid}/undo").json()
    assert [f["output"] for f in restored["frames"]]==before
    smooth=s|{"style":"smooth","palette_mode":"auto","custom_palette":[],"smooth_strength":.4,"stabilize":.2}
    wait(client.post(f"/api/projects/{pid}/process",json={"settings":smooth}))
    p=client.get(f"/api/projects/{pid}").json()
    before=[f["output"] for f in p["frames"]]
    wait(client.post(f"/api/projects/{pid}/process",json={"indices":[1],"settings":smooth|{"smooth_levels":4,"outline_width":1}}))
    after=client.get(f"/api/projects/{pid}").json()
    assert after["last_run"]["affected"]==[0,1,2]
    assert after["frames"][3]["output"]==before[3]
    assert client.post(f"/api/projects/{pid}/undo").json()["frames"][1]["output"]==before[1]


def test_style_export_grid_palette_alpha_metadata_and_custom_to_auto():
    p=images_project();pid=p["id"]
    s=p["settings"]|{"style":"pixel","size":64,"pixel_cell":2,"pixel_sampling":"majority",
        "palette_mode":"custom","custom_palette":["#161b2b","#fff4db"],"dither_strength":1,
        "outline_width":1,"outline_color":"#161b2b"}
    wait(client.post(f"/api/projects/{pid}/process",json={"settings":s}))
    job=wait(client.post(f"/api/projects/{pid}/export"))
    z=zipfile.ZipFile(io.BytesIO(client.get(job["result"]["url"]).content))
    mf=json.loads(z.read("manifest.json"))
    assert mf["settings"]["dither_strength"]==1 and mf["settings"]["custom_palette"]==s["custom_palette"]
    fr=np.asarray(Image.open(io.BytesIO(z.read(mf["frames"]["0"]["file"]))))
    assert set(map(tuple,fr[fr[...,3]>0,:3]))<={(22,27,43),(255,244,219)}
    for y in range(0,64,2):
        for x in range(0,64,2):
            assert np.all(fr[y:y+2,x:x+2]==fr[y,x])
    wait(client.post(f"/api/projects/{pid}/process",json={"settings":s|{"palette_mode":"auto","colors":8}}))
    after=client.get(f"/api/projects/{pid}").json()
    assert after["palette"]!=mf["palette"]


def test_invalid_style_settings_and_old_defaults_are_read_only():
    p=images_project();pid=p["id"]
    for patch in ({"custom_palette":["wrong"]},{"palette_mode":"custom","custom_palette":[]},
                  {"pixel_cell":0},{"pixel_sampling":"unknown"},{"smooth_levels":1},
                  {"dither_strength":2},{"outline_width":20}):
        response=client.post(f"/api/projects/{pid}/preview",json={"index":0,"settings":p["settings"]|patch})
        assert response.status_code==422
    assert client.get(f"/api/projects/{pid}").json()["revision"]==p["revision"]
    old=storage.read(pid)
    for k in ("pixel_sampling","pixel_cell","dither_strength","smooth_strength","smooth_levels",
              "outline_width","outline_color","saturation","contrast","brightness","palette_mode",
              "custom_palette","palette_distance"):
        old["settings"].pop(k)
    storage.write(old)
    revision=old["revision"]
    restored=client.get(f"/api/projects/{pid}").json()
    assert restored["settings"]["pixel_cell"]==1 and restored["settings"]["saturation"]==1
    assert restored["revision"]==revision

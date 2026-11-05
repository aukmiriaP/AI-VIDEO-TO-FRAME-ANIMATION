import copy
import io
import json
import time
import zipfile

import numpy as np
import pytest
from PIL import Image, ImageDraw

from server import replacing, storage
from test_pipeline import client, images_project, wait


def picture(size=(64, 64), alpha=160):
    image = Image.new("RGBA", size)
    ImageDraw.Draw(image).rectangle((5, 8, 32, 46), fill=(90, 160, 230, alpha))
    return image


def payload(image):
    buf = io.BytesIO()
    image.save(buf, "PNG")
    return buf.getvalue()


def read(pid):
    return client.get(f"/api/projects/{pid}").json()


def replace(p, image, index=1, mode="source", keep=False):
    return wait(client.post(f'/api/projects/{p["id"]}/frames/{index}/replace',data={
        "mode":mode, "keep_strokes":str(keep).lower(), "expected_revision":p["revision"],
        "expected_frame_id":p["frames"][index]["id"]},
        files={"file":("edit.png",payload(image),"image/png")}))


def process(p, **patch):
    wait(client.post(f'/api/projects/{p["id"]}/process',json={"settings_patch":patch}))
    return read(p["id"])


def normals(p):
    wait(client.post(f'/api/projects/{p["id"]}/normals',json={
        "settings":p["normal_settings"],"expected_revision":p["revision"]}))
    return read(p["id"])


def test_source_replacement_identity_local_dependents_original_undo():
    p = normals(process(images_project(), size=64, stabilize=.3))
    pid=p["id"];old=copy.deepcopy(p);fr=p["frames"][1]
    source_bytes=client.get(fr["original_url"]).content
    replace(p,picture())
    p=read(pid);new=p["frames"][1]
    assert len(p["frames"])==4 and p["actions"]==old["actions"]
    for key in ("id","duration","enabled","time","settings","normal_settings","label"):
        assert new[key]==fr[key]
    assert new["original"]!=fr["original"] and new["source_hash"]!=fr["source_hash"]
    assert p["last_run"]["affected"]==[0,1,2]
    assert p["frames"][3]["output"]==old["frames"][3]["output"]
    assert new["normal"]!=fr["normal"] and p["frames"][0]["normal"]==old["frames"][0]["normal"]
    assert client.get(fr["original_url"]).content==source_bytes
    assert np.array_equal(np.asarray(Image.open(io.BytesIO(client.get(new["original_url"]).content))),np.asarray(picture()))
    restored=client.post(f"/api/projects/{pid}/undo").json()
    assert restored["frames"]==old["frames"]


def test_source_stroke_choice_and_duplicate_independence():
    p=process(images_project(),size=64)
    pid=p["id"]
    wait(client.put(f"/api/projects/{pid}/frames/1/mask",json={"strokes":[
        {"mode":"erase","points":[[.3,.3]],"radius":.1}]}))
    p=read(pid);strokes=p["frames"][1]["strokes"]
    replace(p,picture(),keep=True)
    assert read(pid)["frames"][1]["strokes"]==strokes
    p=client.post(f"/api/projects/{pid}/undo").json()
    replace(p,picture(),keep=False)
    p=read(pid)
    assert p["frames"][1]["strokes"]==[]
    duplicate=client.post(f"/api/projects/{pid}/edit",json={
        "operation":"duplicate","indices":[1],"expected_revision":p["revision"]}).json()
    shared=duplicate["frames"][2]["original"]
    replace(duplicate,picture(alpha=200),index=1)
    p=read(pid)
    assert p["frames"][2]["original"]==shared and p["frames"][1]["original"]!=shared


def test_output_override_exact_rgba_normals_export_and_reset():
    p=normals(process(images_project(),size=64,style="pixel",pixel_cell=2,
        palette_mode="custom",custom_palette=["#000000","#ffffff"],stabilize=.3))
    pid=p["id"];before=copy.deepcopy(p);image=picture(alpha=145)
    replace(p,image,mode="output");p=read(pid)
    fr=p["frames"][1]
    assert fr["original"]==before["frames"][1]["original"]
    assert fr["output"]==fr["output_override"] and fr["normal"]!=before["frames"][1]["normal"]
    out=np.asarray(Image.open(io.BytesIO(client.get(fr["output_url"]).content)))
    assert np.array_equal(out,np.asarray(image))
    n=np.asarray(Image.open(io.BytesIO(client.get(fr["normal_url"]).content)))
    assert np.array_equal(n[...,3],out[...,3])
    p=process(p,brightness=.2,dither_strength=1)
    assert p["frames"][1]["output"]==fr["output"]
    result=wait(client.post(f"/api/projects/{pid}/export",json={"options":{"include_normals":True}}))
    z=zipfile.ZipFile(io.BytesIO(client.get(result["result"]["url"]).content));mf=json.loads(z.read("manifest.json"))
    assert mf["frames"]["1"]["replacement"]["mode"]=="output"
    assert np.array_equal(np.asarray(Image.open(io.BytesIO(z.read(mf["frames"]["1"]["file"])))),out)
    assert client.put(f"/api/projects/{pid}/frames/1/mask",json={"strokes":[]}).status_code==400
    p=read(pid)
    wait(client.post(f"/api/projects/{pid}/frames/1/replacement/reset",json={
        "expected_revision":p["revision"],"expected_frame_id":fr["id"]}))
    reset=read(pid)
    assert not reset["frames"][1].get("output_override")
    assert reset["frames"][1]["original"]==fr["original"]
    assert reset["frames"][1]["output"]!=fr["output"]
    undo=client.post(f"/api/projects/{pid}/undo").json()
    assert undo["frames"][1]["output_override"]==fr["output_override"]
    # Source replacement explicitly clears a previous final-output override.
    replace(undo,picture(alpha=210))
    assert not read(pid)["frames"][1].get("output_override")


def test_replacement_validation_revision_cancel_and_canvas_guard():
    p=process(images_project(),size=64);pid=p["id"];saved=storage.read(pid)
    for index,image,revision,fid in (
        (99,picture(),p["revision"],"invalid"),
        (1,picture((32,32)),p["revision"],p["frames"][1]["id"]),
        (1,picture(),0,p["frames"][1]["id"]),
        (1,picture(),p["revision"],p["frames"][0]["id"]),
    ):
        with pytest.raises(ValueError):
            replacing.replace(pid,index,"source",payload(image),"bad.png",False,revision,fid,lambda *_:None,lambda:False)
        assert storage.read(pid)==saved
    with pytest.raises(ValueError):
        replacing.decode(b"not an image")
    with pytest.raises(InterruptedError):
        replacing.replace(pid,1,"source",payload(picture()),"good.png",False,
                          p["revision"],p["frames"][1]["id"],lambda *_:None,lambda:True)
    assert storage.read(pid)==saved
    replace(p,picture(),mode="output");p=read(pid)
    job=client.post(f"/api/projects/{pid}/process",json={"settings_patch":{"size":128}}).json()
    deadline=time.monotonic()+5
    while time.monotonic()<deadline:
        failed=client.get(f'/api/jobs/{job["job_id"]}').json()
        if failed["state"] in ("failed","done","canceled"):
            break
        time.sleep(.02)
    assert failed["state"]=="failed" and "成品覆盖" in failed["message"]
    assert read(pid)["revision"]==p["revision"]


def test_output_replacement_canvas_coordinates_and_animation_file_rejected():
    p=process(images_project(),size=64);pid=p["id"]
    wait(client.post(f"/api/projects/{pid}/process",json={
        "asset_options":{"canvas_width":96,"canvas_height":80,"pivot_y":.9},
        "indices":None}))
    p=read(pid)
    replace(p,picture((96,80)),mode="output")
    new=read(pid)
    assert new["frames"][1]["geometry"]["canvas"]==[96,80]
    assert new["frames"][1]["geometry"]["pivot"]==[.5,.9]
    buf=io.BytesIO()
    picture().save(buf,"PNG",save_all=True,append_images=[picture(alpha=100)],duration=80)
    with pytest.raises(ValueError,match="动画"):
        replacing.decode(buf.getvalue())

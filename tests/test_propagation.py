import copy
import io
import json
import zipfile

import numpy as np
import pytest
from PIL import Image

from server import imaging, pipeline, propagation, storage
from server.app import propagation_reports
from test_pipeline import client, wait
from propagation_fixtures import moving_image


def payload(image):
    buf = io.BytesIO()
    image.save(buf, "PNG")
    return buf.getvalue()


def moving_project(occlude=None, **settings):
    files = [("files", (f"{i:03d}.png", payload(moving_image(i, i==occlude)), "image/png")) for i in range(7)]
    job = wait(client.post("/api/import", data={"name":"motion-test","fps":12}, files=files))
    pid = job["project_id"]
    wait(client.post(f"/api/projects/{pid}/process", json={"settings_patch":{"size":128}|settings}))
    return read(pid)


def read(pid):
    return client.get(f"/api/projects/{pid}").json()


def brush(p, index=2, mode="erase", radius=.055):
    wait(client.put(f'/api/projects/{p["id"]}/frames/{index}/mask', json={"strokes":[
        {"mode":mode,"points":[[(50+index*4)/127,50/127]],"radius":radius}]}))
    return read(p["id"])


def request(p, indices, donor=2, confidence=.6):
    return propagation.PreviewRequest(expected_revision=p["revision"], donor_index=donor,
        donor_frame_id=p["frames"][donor]["id"], indices=indices, confidence=confidence)


def preview(p, indices, donor=2, confidence=.6):
    result = wait(client.post(f'/api/projects/{p["id"]}/mask-propagation/preview',
        json=request(p, indices, donor, confidence).model_dump()))
    return result["result"]["propagation"]


def apply(p, report, indices):
    return wait(client.post(f'/api/projects/{p["id"]}/mask-propagation/apply',
        json={"expected_revision":p["revision"],"report_id":report["id"],"indices":indices}))


def image_at(url):
    return np.asarray(Image.open(io.BytesIO(client.get(url).content)))


def test_bidirectional_motion_selective_apply_normals_cache_export_undo():
    p=brush(moving_project())
    pid=p["id"]
    wait(client.post(f"/api/projects/{pid}/normals", json={"expected_revision":p["revision"],"settings":p["normal_settings"]}))
    p=read(pid); saved=storage.read(pid)
    report=preview(p,[0,1,3,4])
    assert storage.read(pid)==saved  # preview does not touch revision, history, paths or geometry
    assert all("layer" not in item for item in report["items"])
    for item in report["items"]:
        assert item["applicable"] and item["accepted_ratio"]>.9
        arr=image_at(item["preview_url"])
        x=50+item["index"]*4
        assert arr[50,x,3]==0  # correction follows actual source translation
        assert arr[65,x,3]==220 and arr[50,x+16,3]==220
    apply(p,report,[1,3]); after=read(pid)
    assert after["last_run"]["affected"]==[1,3]
    for i in range(7):
        if i in (1,3):
            assert after["frames"][i]["output_url"]==next(it["preview_url"] for it in report["items"] if it["index"]==i)
            assert after["frames"][i]["normal"]!=p["frames"][i]["normal"]
            assert np.array_equal(image_at(after["frames"][i]["normal_url"])[...,3],
                                  image_at(after["frames"][i]["output_url"])[...,3])
        else:
            assert after["frames"][i]==p["frames"][i]
    exported=wait(client.post(f"/api/projects/{pid}/export",json={"options":{"include_normals":True}}))
    z=zipfile.ZipFile(io.BytesIO(client.get(exported["result"]["url"]).content))
    mf=json.loads(z.read("manifest.json"))
    assert mf["frames"]["1"]["mask_corrections"][0]["donor_frame_id"]==p["frames"][2]["id"]
    assert np.array_equal(np.asarray(Image.open(io.BytesIO(z.read(mf["frames"]["1"]["file"])))),
                          image_at(after["frames"][1]["output_url"]))
    # Export saves its options as a separate undoable operation.
    exported_undo=client.post(f"/api/projects/{pid}/undo").json()
    assert exported_undo["frames"]==after["frames"]
    restored=client.post(f"/api/projects/{pid}/undo").json()
    assert restored["frames"]==p["frames"]


def test_restore_target_pixels_and_manual_precedence():
    p=brush(moving_project(),mode="restore")
    report=preview(p,[3])
    layer=propagation_reports[report["id"]]["items"][0]["layer"]
    with Image.open(storage.project_dir(p["id"])/layer["path"]) as mask:
        source=moving_image(3)
        base=Image.new("RGBA",source.size,(1,2,3,0))
        corrected=imaging.apply_mask_corrections(base,source,[mask.convert("RGBA")])
        assert np.array_equal(np.asarray(corrected)[50,62],np.asarray(source)[50,62])
        assert not np.array_equal(np.asarray(source)[50,62],np.asarray(moving_image(2))[50,62])
        manual=imaging.brush_alpha(corrected,source,[{"mode":"erase","points":[[62/127,50/127]],"radius":.055}])
        assert np.asarray(manual)[50,62,3]==0
    # Integration: an existing target restore wins over a donor erase.
    p=brush(p,index=3,mode="restore")
    p=brush(p,index=2,mode="erase")
    report=preview(p,[3])
    assert report["items"][0]["applicable"]
    assert image_at(report["items"][0]["preview_url"])[50,62,3]==220
    assert any("手动画笔" in w for w in report["items"][0]["warnings"])


def test_occlusion_does_not_reappear_and_low_texture_rejected():
    p=brush(moving_project(occlude=3))
    report=preview(p,[3,4,5])
    assert all(not item["applicable"] and item["accepted_pixels"]==0 for item in report["items"])
    assert any("跟踪丢失" in w for w in report["items"][1]["warnings"])
    a=np.full((128,128,3),127,np.uint8)
    masks=np.zeros((128,128,2),np.float32); masks[40:60,40:60,0]=1
    _, confidence=propagation.transport(a,a,masks,np.ones((128,128),np.float32))
    assert confidence.max()==0


def test_validation_stale_reports_disabled_overrides_cancel_and_layer_limit():
    p=brush(moving_project());pid=p["id"]
    saved=storage.read(pid)
    for req in (request(p,[2]),request(p,[99]),request(p,[3]).model_copy(update={"donor_frame_id":"bad"}),
                request(p,[3]).model_copy(update={"expected_revision":0})):
        with pytest.raises(ValueError):
            propagation.preview(pid,req,lambda *_:None,lambda:False)
        assert storage.read(pid)==saved
    with pytest.raises(InterruptedError):
        propagation.preview(pid,request(p,[3]),lambda *_:None,lambda:True)
    assert storage.read(pid)==saved
    # Cross-action targets are not tracked even if adjacent.
    other=copy.deepcopy(saved);other["actions"]=[{"id":"a","start":0,"end":2},{"id":"b","start":3,"end":6}]
    with pytest.raises(ValueError,match="同一动作"):
        propagation.validate(other,request(p,[3]))
    report=preview(p,[1,3])
    req=propagation.ApplyRequest(expected_revision=p["revision"],report_id=report["id"],indices=[3])
    with pytest.raises(InterruptedError):
        propagation.apply(pid,propagation_reports[report["id"]],req,lambda *_:None,lambda:True)
    assert storage.read(pid)==saved
    # Also cancel during rendering, after in-memory edits.
    with pytest.raises(InterruptedError):
        _cancel_mid_apply(pid, report, req)
    assert storage.read(pid)==saved
    with pytest.raises(ValueError):
        propagation.apply(pid,propagation_reports[report["id"]],req.model_copy(update={"indices":[6]}),lambda *_:None,lambda:False)
    client.patch(f"/api/projects/{pid}/frames",json={"indices":[3],"enabled":False})
    p=read(pid)
    with pytest.raises(ValueError):
        propagation.apply(pid,propagation_reports[report["id"]],req,lambda *_:None,lambda:False)
    new=preview(p,[3])
    assert not new["items"][0]["applicable"]
    blocked=storage.read(pid)
    blocked["frames"][3]["enabled"]=True
    blocked["frames"][3]["output_override"]=blocked["frames"][3]["original"]
    blocked["frames"][3]["override_hash"]=blocked["frames"][3]["source_hash"]
    storage.write(blocked)
    assert not preview(read(pid),[3])["items"][0]["applicable"]
    blocked=storage.read(pid)
    blocked["frames"][3].pop("output_override")
    blocked["frames"][3].pop("override_hash")
    blocked["frames"][3]["mask_corrections"]=[copy.deepcopy(propagation_reports[report["id"]]["items"][0]["layer"])]*8
    storage.write(blocked)
    assert not preview(read(pid),[3])["items"][0]["applicable"]
    assert storage.read(pid)["frames"][3]["mask_corrections"]==blocked["frames"][3]["mask_corrections"]
    with pytest.raises(ValueError):
        propagation.clear(pid,3,0,blocked["frames"][3]["id"],lambda *_:None,lambda:False)


def _cancel_mid_apply(pid, report, req):
    canceled=False
    def progress(*_):
        nonlocal canceled
        canceled=True
    return propagation.apply(pid,propagation_reports[report["id"]],req,progress,lambda:canceled)


def test_clear_replacement_snapshot_dependency_and_source_coordinates():
    p=brush(moving_project(stabilize=.2,offset_x=.125,size=64))
    pid=p["id"];report=preview(p,[3]);apply(p,report,[3]);after=read(pid)
    assert after["last_run"]["affected"]==[2,3,4]
    # Correction stored at 128 source pixels before 64px scale and +8px offset.
    arr=image_at(after["frames"][3]["output_url"])
    assert arr[25,39,3]<20  # 62/2 + 8
    fixed=after["frames"][3]["mask_corrections"]
    changed=brush(after,index=2,mode="restore")
    assert changed["frames"][3]["mask_corrections"]==fixed
    wait(client.post(f"/api/projects/{pid}/frames/3/mask-propagation/clear",json={
        "expected_revision":changed["revision"],"expected_frame_id":changed["frames"][3]["id"]}))
    cleared=read(pid)
    assert not cleared["frames"][3].get("mask_corrections")
    assert image_at(cleared["frames"][3]["output_url"])[25,39,3]>200
    undo=client.post(f"/api/projects/{pid}/undo").json()
    assert undo["frames"]==changed["frames"]
    from test_replacing import replace
    replace(undo,moving_image(3),index=3,keep=True)
    assert read(pid)["frames"][3]["mask_corrections"]==fixed
    p=read(pid);replace(p,moving_image(3),index=3,keep=False)
    assert not read(pid)["frames"][3].get("mask_corrections")


def test_pixel_palette_and_empty_source_report_validation():
    p=moving_project(style="pixel",size=64,colors=8)
    with pytest.raises(ValueError,match="保存"):
        propagation.validate(storage.read(p["id"]),request(p,[3]))
    p=brush(p);report=preview(p,[1,3]);apply(p,report,[3]);after=read(p["id"])
    assert after["palette"]==p["palette"]
    out=image_at(after["frames"][3]["output_url"])
    assert set(np.unique(out[...,3]))<={0,255}
    assert {tuple(c) for c in out[out[...,3]>0,:3]}<={tuple(c) for c in p["palette"]}
    assert out[25,31,3]==0
    foreign=moving_project()
    req=propagation.ApplyRequest(expected_revision=foreign["revision"],report_id=report["id"],indices=[3])
    with pytest.raises(ValueError,match="过期"):
        propagation.apply(foreign["id"],propagation_reports[report["id"]],req,lambda *_:None,lambda:False)

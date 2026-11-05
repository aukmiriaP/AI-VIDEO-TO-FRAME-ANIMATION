# Run after Godot has imported an extracted export:
# Godot --headless --path <project> --script <absolute path to this file> --fixed-fps 12
# Optional: append "-- res://assets/" to verify a relocated asset folder.
extends SceneTree

func _initialize():
    call_deferred("verify_export")

func verify_export():
    var args = OS.get_cmdline_user_args()
    var folder = args[0] if args.size() > 0 else "res://"
    var manifest = JSON.parse_string(FileAccess.get_file_as_string(folder + "manifest.json"))
    var packed = load(folder + "preview.tscn") as PackedScene
    if packed == null or manifest == null:
        push_error("Exported scene or manifest could not be loaded")
        quit(1)
        return
    var scene = packed.instantiate()
    root.add_child(scene)
    var sprite = scene.get_node("Animation") as AnimatedSprite2D
    var animations = sprite.sprite_frames
    if animations == null:
        push_error("Missing SpriteFrames; import the textures before running this check")
        quit(1)
        return
    var total = 0
    for action in manifest["actions"]:
        var name = action["name"]
        var count = animations.get_frame_count(name)
        if count != action["frames"].size() or count < 1:
            push_error("Unexpected animation frame count: " + name)
            quit(1)
            return
        total += count
        for i in range(count):
            if animations.get_frame_texture(name, i) == null:
                push_error("Missing frame texture")
                quit(1)
                return
        print("ANIMATION ", name, " frames=", count, " fps=", animations.get_animation_speed(name))
    var expected_filter = 1 if manifest["style"] == "pixel" else 2
    if total != manifest["frames"].size() or sprite.texture_filter != expected_filter:
        push_error("Wrong total frame count or texture filter")
        quit(1)
        return
    var canvas = manifest["canvas"]
    var pivot = manifest["pivot"]
    var expected_offset = Vector2((0.5-pivot[0])*canvas[0], (0.5-pivot[1])*canvas[1])
    if not sprite.offset.is_equal_approx(expected_offset):
        push_error("Wrong sprite pivot offset")
        quit(1)
        return
    for action in manifest["actions"]:
        var name = action["name"]
        if not is_equal_approx(animations.get_animation_speed(name), float(action["fps"])):
            push_error("Wrong animation speed")
            quit(1)
            return
        for i in range(action["frames"].size()):
            var info = manifest["frames"][str(int(action["frames"][i]))]
            var texture = animations.get_frame_texture(name, i) as AtlasTexture
            var rect = info["rect"]
            if texture == null or texture.region != Rect2(rect[0],rect[1],rect[2],rect[3]):
                push_error("Wrong atlas rectangle")
                quit(1)
                return
            if manifest.has("fps") and not is_equal_approx(animations.get_frame_duration(name, i), float(info["duration"])*float(manifest["fps"])):
                push_error("Wrong frame duration")
                quit(1)
                return
    # Count frame_changed events; final frame may equal initial after a loop.
    var changes = [0]
    sprite.frame_changed.connect(func(): changes[0] += 1)
    for i in range(24):
        await process_frame
    if animations.get_frame_count(sprite.animation) > 1 and changes[0] == 0:
        push_error("Exported animation is not advancing")
        quit(1)
        return
    print("GODOT_PLAYBACK_OK total=", total, " changes=", changes[0], " filter=", sprite.texture_filter)
    quit(0)

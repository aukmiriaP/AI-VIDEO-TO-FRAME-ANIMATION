# AI 视频到游戏序列帧

本地 2D 动画资产编辑器，支持视频与图片序列导入、抠图、逐帧编辑、动作划分、图集及 Godot 4 资源导出。

当前版本为 v0.7。视频生成 API 尚未接入，需导入已有视频或图片。

[快速运行](#快速运行) · [使用指南](docs/usage.md) · [验证记录](docs/validation.md)

## 界面预览

![浅色编辑界面：序列库、动画画布、时间轴与参数面板](docs/interface-light.png)

截图素材为回归测试用的半透明移动纹理。界面支持浅色、深色和跟随系统。

[查看深色界面](docs/interface-dark.png) · [查看导入界面](docs/interface-empty.png)

## 功能

| 分类 | 功能 |
| --- | --- |
| 素材导入 | 视频按实际时间戳抽帧；图片序列自然排序；保留原始素材 |
| 背景与透明度 | 保留原 Alpha、色键抠图、U2NetP 本地 CPU 抠图；遮罩收缩／扩张、羽化与边缘清理 |
| 逐帧编辑 | 擦除／恢复画笔、洋葱皮、拖动排序、复制／删除／跳过、帧时长、动作片段与循环播放 |
| 局部精修 | 下载单帧后外部绘制，再替换原始帧或直接覆盖成品帧；支持撤销 |
| 跨帧修订 | 双向光流跟踪已保存的画笔修订；对比传播前后及风险区域，勾选目标后应用 |
| 动画检查 | 连续相似帧、异常跳变与循环候选；人工确认后合并、跳过或创建动作 |
| 风格与资产整理 | 非像素渐变处理、像素网格与共用色板；统一画布、锚点及主体对齐 |
| 法线与引擎导出 | 本地近似法线、WebGL 实时打光；RGBA PNG、图集、元数据及可运行的 Godot 4 预览工程 |

## 快速运行

已验证环境：macOS arm64、Python 3.11、Node.js 20+、Chrome。导出工程已在 Godot 4.7.2 验证；编辑器运行不需要安装 Godot。其他平台尚未完成验证。

克隆仓库：

```bash
git clone https://github.com/aukmiriaP/AI-VIDEO-TO-FRAME-ANIMATION.git frame-studio
```

在克隆后的 `frame-studio` 目录执行以下命令：

```bash
python3.11 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock.txt
npm --prefix web ci
npm --prefix web run build
.venv/bin/python launch.py
```

浏览器将打开 **http://127.0.0.1:8971**。依赖安装完成后，macOS 也可双击 `启动帧序.command` 启动。

AI 抠图需在界面中首次下载模型；模型下载后可本地运行，无需云端 API 密钥。色键、透明 PNG 编辑和练习素材不需要该模型。项目默认保存在 `data/projects/`，模型保存在 `data/models/`；这些内容、依赖和缓存均不包含在 Git 仓库中。

`requirements.lock.txt` 固定已验证环境的依赖版本，`requirements.txt` 提供直接依赖范围。可通过环境变量 `FRAME_STUDIO_DATA` 指定独立数据目录。

开发模式：在仓库根目录运行 `.venv/bin/python -m uvicorn server.app:app --host 127.0.0.1 --port 8971`，另一个终端运行 `npm --prefix web run dev`，访问 Vite 提供的本地地址。

## 使用

1. 点击「导入素材」，选择视频或图片序列，设置抽帧率与输出风格。图片序列按文件名自然排序，需保持相同尺寸。
2. 设置背景处理：透明图片选择「保留」，纯色背景选择「色键」，其他素材可尝试「AI 抠图」。点击「预览当前帧」，确认后点击「应用」。
3. 在时间轴选帧，调整顺序、时长和启用状态，或将连续范围「切为动作」。Shift 连选，⌘ / Ctrl 多选，← / → 逐帧，空格播放。
4. 使用画笔修订遮罩并保存；需要传播到邻帧时，打开「跨帧遮罩」，生成预览并勾选目标后应用。也可通过「替换当前帧」导入外部编辑的图片。
5. 在「资产整理」中设置画布、锚点与对齐方式。法线与打光为可选步骤，移动预览灯光不修改颜色帧。
6. 点击「导出动画」，设置图集和动作范围，导出并下载 ZIP。解压后用 Godot 4 导入 `project.godot` 运行预览。

应用范围可选全部或选中帧。局部修改会更新指定帧及必要的依赖邻帧；输出尺寸、画布与共用色板等整段设置会影响整个序列。最近 12 次编辑可撤销。

安装后可点击「试用练习素材」体验流程。内置水母动画由程序绘制。详细参数及操作说明见[使用指南](docs/usage.md)。

## 导出文件

```text
frames/              独立 RGBA PNG 帧
normals/             可选：独立法线 PNG
atlas-00.png         颜色图集，支持多页、留白与扩边
normal-atlas-00.png  可选：配对法线图集
manifest.json       帧矩形、时间、动作、画布、锚点和处理参数
animations.tres     Godot SpriteFrames 资源
preview.tscn        动画预览场景
project.godot       独立 Godot 4 预览工程
README.txt          导入说明
```

PNG 使用直通 Alpha（未预乘），颜色与法线图集使用相同布局。图集名称可通过文件名前缀调整。

导入已有 Godot 工程时，将图集、`animations.tres` 和 `preview.tscn` 放在同一目录；`project.godot` 仅用于独立预览，不应复制进已有工程。像素路径使用 Nearest，非像素路径使用 Linear；自行创建动画节点时需设置对应采样方式与锚点偏移。

## 开发与测试

前端使用 React 19、TypeScript、Vite、Canvas 2D 和 WebGL；后端使用 FastAPI、Pillow、NumPy、OpenCV、PyAV 与 rembg／ONNX Runtime。U2NetP 用于 CPU 抠图，双向光流用于遮罩传播及帧间颜色稳定。

```bash
# 仓库根目录；后端测试使用独立临时数据
.venv/bin/python -m pytest -q

# 前端类型检查与生产构建
npm --prefix web run build
```

测试使用独立临时数据，覆盖局部依赖、缓存、版本校验、撤销、替换与导出。浏览器和 Godot 的验证步骤、结果及复现条件见[验证记录](docs/validation.md)。

## 代码导航

| 位置 | 职责 |
| --- | --- |
| [`web/src/`](web/src/) | 编辑器、时间轴、画布交互、对照窗口与 WebGL 打光 |
| [`server/pipeline.py`](server/pipeline.py) | 导入、分阶段渲染、缓存与局部依赖更新 |
| [`server/imaging.py`](server/imaging.py) / [`styling.py`](server/styling.py) | 抠图、Alpha 处理、风格、色板与帧间稳定 |
| [`server/propagation.py`](server/propagation.py) / [`analysis.py`](server/analysis.py) | 遮罩传播与只读动画检查 |
| [`server/editing.py`](server/editing.py) / [`replacing.py`](server/replacing.py) | 动作与帧编辑、单帧替换及局部更新 |
| [`server/normals.py`](server/normals.py) / [`exporting.py`](server/exporting.py) | 近似法线、图集与 Godot 资源生成 |
| [`server/app.py`](server/app.py) / [`storage.py`](server/storage.py) | API、后台任务、本地持久化与快照 |
| [`tests/`](tests/) | 后端回归、Chrome 流程检查与 Godot 验证脚本 |

## 限制

- 每个序列最多 480 帧，单次导入最多 512 MB，单帧最多 1600 万像素。
- 轻量抠图对发丝、运动模糊和背景近色的处理有限；快速运动、遮挡、肢体交叉或低纹理会影响光流，需人工检查。
- 动画检查与遮罩传播提供算法候选，相似度和置信度不是经标定的质量概率。工具不自动修复肢体错误、形体漂移或循环接缝。
- 像素处理为采样与量化；法线为轮廓／亮度高度场近似，不包含真实几何、投影阴影或完整 PBR 材质。
- 当前仅支持单机本地使用，暂不支持多人协作、重做、缓存清理 UI、原生桌面安装包和 Unity 专用导出。

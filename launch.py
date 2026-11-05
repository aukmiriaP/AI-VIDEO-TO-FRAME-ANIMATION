"""Double-click launcher. Reopens a running instance or starts a local server."""
import os
import threading
import urllib.request
import webbrowser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
URL = "http://127.0.0.1:8971"

if __name__ == "__main__":
    try:
        import json
        with urllib.request.urlopen(URL + "/api/health", timeout=1) as response:
            status = json.load(response)
        if status.get("app") == "frame-studio":
            webbrowser.open(URL)
            raise SystemExit(0)
        raise SystemExit("端口 8971 已被其他服务使用。")
    except OSError:
        pass
    if not (ROOT / "web/dist/index.html").exists():
        raise SystemExit("请先在 web 目录运行 npm install 和 npm run build。")
    import uvicorn
    threading.Timer(1.5, lambda: webbrowser.open(URL)).start()
    print("帧序已启动：" + URL + "\n关闭此终端窗口将停止服务；项目会保留在 data/projects。")
    uvicorn.run("server.app:app", host="127.0.0.1", port=8971)
